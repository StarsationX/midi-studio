"""Fast transkun transcription: pipelined (and, on CUDA, batched) backbone.

Usage: transcribe_fast.py <audio> <out_midi>
Env:   TRANSCRIBE_BACKEND=cuda|onnx_dml (default: cuda if available else onnx_dml)
       TRANSCRIBE_BATCH=4   segments per CUDA forward (auto-halves on OOM)
       SEGMENT_HOP          segment hop seconds (segment size stays at model default)

A producer thread runs the neural backbone ahead of time, on CUDA with TF32
+ bf16 autocast and several segments per forward, on DirectML via the static
ONNX graph one segment at a time, while the consumer runs transkun's stock
`model.transcribe()` on CPU with `processFramesBatch` replaced by a queue pop.
GPU compute and the CPU semi-CRF decode overlap, and the decode consumes
exactly what the backbone produced, so output ordering/logic is unchanged.

Audio is downmixed to mono on both backends (the ONNX graph is traced mono;
CUDA follows suit so both fast paths produce identical results).
"""
import math
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (ROOT / "models"))
ONNX_PATH = _MODELS_BASE / "onnx" / "transkun_v2.onnx"
SEGMENT_HOP = os.environ.get("SEGMENT_HOP")
BATCH = max(1, int(os.environ.get("TRANSCRIBE_BATCH", "4")))

_DONE = object()


def load_model():
    import moduleconf
    import transkun
    pretrained = Path(transkun.__file__).resolve().parent / "pretrained"
    confManager = moduleconf.parseFromFile(str(pretrained / "2.0.conf"))
    TransKun = confManager["Model"].module.TransKun
    conf = confManager["Model"].config
    ckpt = torch.load(str(pretrained / "2.0.pt"), map_location="cpu")
    model = TransKun(conf=conf)
    sd = ckpt.get("best_state_dict") or ckpt.get("state_dict") or ckpt
    model.load_state_dict(sd, strict=False)
    model.eval()
    return model


def segment_frames(model, x, hop):
    """Replicate model.transcribe()'s segmentation exactly (ModelTransformer
    .transcribe): same padding, step, tail-pad, so the producer's frames are
    identical to what the consumer's loop will ask for, in the same order."""
    from transkun.Util import makeFrame
    xT = x.transpose(-1, -2)
    padTimeBegin = model.segmentSizeInSecond - hop
    pad = math.ceil(padTimeBegin * model.fs)
    xT = F.pad(xT, (pad, pad))
    nSample = xT.shape[-1]
    stepSize = math.ceil(hop * model.fs / model.hopSize) * model.hopSize
    segmentSize = math.ceil(model.segmentSizeInSecond * model.fs)
    frames = []
    for i in range(0, nSample, stepSize):
        cur = xT[:, i:i + segmentSize]
        if cur.shape[-1] < segmentSize:
            cur = F.pad(cur, (0, segmentSize - cur.shape[-1]))
        frames.append(makeFrame(cur, model.hopSize, model.windowSize).unsqueeze(0))
    return frames


def producer_cuda(model, frames, nSym, out_q):
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    gpu = model.cuda()
    batch = BATCH
    i = 0
    with torch.inference_mode():
        while i < len(frames):
            chunk = frames[i:i + batch]
            try:
                fb = torch.cat(chunk, dim=0).cuda()
                # TF32 only, bf16 autocast quantizes the ±80k CRF scores
                # enough to flip Viterbi decisions (95.7% note match vs 100%).
                crf, ctx = gpu.processFramesBatch(fb)
                score = crf.score.float()
                noise = crf.noiseScore.float()
                ctx = ctx.float()
                for b in range(fb.shape[0]):
                    # score/noise last dim is [nBatch*nSym] with sym fastest
                    out_q.put((score[..., b * nSym:(b + 1) * nSym].cpu(),
                               noise[..., b * nSym:(b + 1) * nSym].cpu(),
                               ctx[b:b + 1].cpu()))
                i += fb.shape[0]
            except torch.cuda.OutOfMemoryError:
                if batch == 1:
                    raise
                batch = max(1, batch // 2)
                torch.cuda.empty_cache()
                print(f"CUDA OOM, retrying with batch {batch}")
    out_q.put(_DONE)


def producer_dml(model, frames, out_q):
    import onnxruntime as ort
    sess = ort.InferenceSession(
        str(ONNX_PATH), providers=["DmlExecutionProvider", "CPUExecutionProvider"])
    assert "ctx" in [o.name for o in sess.get_outputs()], \
        "ONNX model lacks ctx output, re-export with export_transkun_onnx.py"
    with torch.no_grad():
        for fb in frames:
            mean = torch.mean(fb, dim=[1, 2, 3], keepdim=True)
            std = torch.std(fb, dim=[1, 2, 3], keepdim=True)
            feats = model.framewiseFeatureExtractor((fb - mean) / (std + 1e-8)).contiguous()
            feats = feats.view(fb.shape[0] * 1, *feats.shape[-3:])
            score, noise, ctx = sess.run(
                None, {"features": feats.numpy().astype(np.float32)})
            out_q.put((torch.from_numpy(score), torch.from_numpy(noise),
                       torch.from_numpy(ctx)))
    out_q.put(_DONE)


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: transcribe_fast.py <audio> <out_midi>")
        return 1
    src, out_midi = Path(sys.argv[1]), Path(sys.argv[2])

    backend = os.environ.get("TRANSCRIBE_BACKEND", "").lower()
    if backend not in ("cuda", "onnx_dml"):
        backend = "cuda" if torch.cuda.is_available() else "onnx_dml"

    from transkun import CRF
    from transkun.Data import writeMidi
    from transkun.transcribe import readAudio

    model = load_model()
    torch.set_grad_enabled(False)

    fs, audio = readAudio(str(src))
    if fs != model.fs:
        import soxr
        audio = soxr.resample(audio, fs, model.fs)
    if audio.ndim == 2 and audio.shape[1] > 1:
        audio = audio.mean(axis=1, keepdims=True)
    elif audio.ndim == 1:
        audio = audio[:, None]
    x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))

    hop = float(SEGMENT_HOP) if SEGMENT_HOP else model.segmentHopSizeInSecond
    frames = segment_frames(model, x, hop)
    nSym = len(model.targetMIDIPitch)
    print(f"Backend: {backend}, {len(frames)} segments"
          + (f", batch {BATCH}, TF32" if backend == "cuda" else " (DirectML prefetch)"))

    # ~180 MB per queued segment; small bound keeps RAM flat while still
    # letting the GPU run ahead of the CPU decode.
    out_q = queue.Queue(maxsize=BATCH + 2)
    # CUDA gets its own weight copy on GPU; the CPU copy keeps serving the
    # decode heads (model.cuda() would otherwise move it in place).
    producer_model = load_model() if backend == "cuda" else model
    if backend == "cuda":
        producer_model.backbone.useGradientCheckpoint = False
        target = producer_cuda
        args = (producer_model, frames, nSym, out_q)
    else:
        target = producer_dml
        args = (producer_model, frames, out_q)

    err = []

    def run_producer():
        try:
            target(*args)
        except Exception as e:  # surface in consumer instead of hanging
            err.append(e)
            out_q.put(_DONE)

    threading.Thread(target=run_producer, daemon=True, name="backbone").start()

    def pop_front(_framesBatch):
        item = out_q.get()
        if item is _DONE:
            raise RuntimeError(f"backbone producer ended early: {err or 'unknown'}")
        score, noise, ctx = item
        return CRF.NeuralSemiCRFInterval(score, noise), ctx

    model.processFramesBatch = pop_front

    t0 = time.time()
    notes = model.transcribe(x, stepInSecond=hop,
                             segmentSizeInSecond=model.segmentSizeInSecond,
                             discardSecondHalf=False)
    if err:
        raise err[0]
    print(f"Transcribed {len(notes)} events in {time.time() - t0:.1f}s")

    writeMidi(notes).write(str(out_midi))
    print(f"MIDI: {out_midi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
