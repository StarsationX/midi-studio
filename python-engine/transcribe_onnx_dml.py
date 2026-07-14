"""Transkun transcription with the acoustic model on ONNX Runtime + DirectML.

Usage: transcribe_onnx_dml.py <audio> <out_midi>

GPU path for non-CUDA cards (AMD/Intel, any DX12 GPU). The heavy transformer
backbone runs as ONNX on DirectML; everything else — segmentation, the
velocity / refined onset-offset heads, semi-CRF Viterbi decode, cross-segment
merging, MIDI assembly — is transkun's own unmodified Python code on CPU
torch. We just monkeypatch `model.processFramesBatch` with an ONNX session
call that returns the same (crf, ctx) contract.

Requires the ctx-bearing export from export_transkun_onnx.py (the older
piano_trainer export lacks the ctx output and will fail here with a clear
error rather than silently degrading velocities).
"""
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (ROOT / "models"))
ONNX_PATH = _MODELS_BASE / "onnx" / "transkun_v2.onnx"
SEGMENT_HOP = os.environ.get("SEGMENT_HOP")


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


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: transcribe_onnx_dml.py <audio> <out_midi>")
        return 1
    src, out_midi = Path(sys.argv[1]), Path(sys.argv[2])
    if not ONNX_PATH.exists():
        print(f"ONNX model missing: {ONNX_PATH}")
        return 1

    import onnxruntime as ort
    from transkun import CRF
    from transkun.Data import writeMidi
    from transkun.transcribe import readAudio

    sess = ort.InferenceSession(
        str(ONNX_PATH), providers=["DmlExecutionProvider", "CPUExecutionProvider"])
    provider = sess.get_providers()[0]
    outputs = [o.name for o in sess.get_outputs()]
    if "ctx" not in outputs:
        print(f"ONNX model has outputs {outputs} but 'ctx' is required "
              "(re-export with export_transkun_onnx.py)")
        return 1
    print(f"Backbone: ONNX Runtime on {provider}")

    model = load_model()
    torch.set_grad_enabled(False)

    def onnx_front(framesBatch):
        # Spectrogram front-end on CPU torch (cheap; ONNX DFT breaks DML),
        # mirroring processFramesBatch before the backbone. The graph runs
        # backbone + scorer on the GPU.
        fb = framesBatch.cpu()
        mean = torch.mean(fb, dim=[1, 2, 3], keepdim=True)
        std = torch.std(fb, dim=[1, 2, 3], keepdim=True)
        features = model.framewiseFeatureExtractor((fb - mean) / (std + 1e-8)).contiguous()
        features = features.view(fb.shape[0] * 1, *features.shape[-3:])
        score, noise, ctx = sess.run(
            None, {"features": features.numpy().astype(np.float32)})
        crf = CRF.NeuralSemiCRFInterval(torch.from_numpy(score),
                                        torch.from_numpy(noise))
        return crf, torch.from_numpy(ctx)

    model.processFramesBatch = onnx_front   # instance attr shadows the method

    fs, audio = readAudio(str(src))
    if fs != model.fs:
        import soxr
        audio = soxr.resample(audio, fs, model.fs)
    # Graph is traced mono; downmix. (Reference model averages the power
    # spectrogram across channels — waveform mean is the practical stand-in.)
    if audio.ndim == 2 and audio.shape[1] > 1:
        audio = audio.mean(axis=1, keepdims=True)
    elif audio.ndim == 1:
        audio = audio[:, None]
    x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))

    # segmentSize must stay at the model default: the ONNX positional
    # embeddings were traced at T=691 (16 s). Hop may vary freely.
    hop = float(SEGMENT_HOP) if SEGMENT_HOP else model.segmentHopSizeInSecond
    t0 = time.time()
    notes = model.transcribe(x, stepInSecond=hop,
                             segmentSizeInSecond=model.segmentSizeInSecond,
                             discardSecondHalf=False)
    print(f"Transcribed {len(notes)} events in {time.time() - t0:.1f}s")

    writeMidi(notes).write(str(out_midi))
    print(f"MIDI: {out_midi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
