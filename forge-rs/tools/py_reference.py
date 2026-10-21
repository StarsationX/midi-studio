"""Reference run of the Python ONNX transcription path, CPU only.

    python capped.py py_reference.py <audio> <out_dir> [--models DIR] [--dump]

Runs python-engine/transcribe_onnx_dml.py unmodified, except that every ORT
session is forced onto CPUExecutionProvider. Writes <out_dir>/ref.mid and
<out_dir>/notes.json (full-precision floats). With --dump it also records the
intermediates forge-rs can be compared against, per segment k:

  resampled.npy           audio after soxr (only if a resample happened)
  seg{k}_features.npy     ONNX input   [1, 691, 229, 6]
  seg{k}_score.npy        ONNX outputs [691, 691, 90]
  seg{k}_noise.npy                     [690, 90]
  seg{k}_ctx.npy                       [1, 90, 691, 256]
  seg{k}_paths.json       semi-CRF decode (forcedStartPos + intervals)
  seg{k}_attr.npy         head input  [nIntervals, 768]
  seg{k}_vel_logits.npy   velocityPredictor output
  seg{k}_of_out.npy       refinedOFPredictor output
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
FORGE_MODELS = Path(os.environ.get("LOCALAPPDATA", "")) / "midi-studio" / "forge-env" / "models"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out_dir")
    ap.add_argument("--models", default=str(FORGE_MODELS))
    ap.add_argument("--dump", action="store_true")
    ap.add_argument("--app", action="store_true",
                    help="transcribe.py pipeline: load_normalize_save first, clean_midi after "
                         "(writes app.mid next to ref.mid)")
    a = ap.parse_args()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    os.environ["MIDI_STUDIO_MODELS_DIR"] = a.models

    import numpy as np
    import onnxruntime as ort
    import torch

    _orig_init = ort.InferenceSession.__init__

    def cpu_init(self, path, sess_options=None, providers=None, **kw):
        return _orig_init(self, path, sess_options, providers=["CPUExecutionProvider"], **kw)

    ort.InferenceSession.__init__ = cpu_init

    sys.path.insert(0, str(REPO / "python-engine"))
    import transcribe_onnx_dml as tod
    import transkun.Data as tdata
    from transkun import CRF

    seg = {"k": -1}
    captured = {}

    if a.dump:
        import soxr
        _orig_resample = soxr.resample

        def resample_hook(x, in_rate, out_rate, *args, **kw):
            y = _orig_resample(x, in_rate, out_rate, *args, **kw)
            np.save(out / "resample_in.npy", x)
            np.save(out / "resampled.npy", y)
            return y

        soxr.resample = resample_hook

        _orig_run = ort.InferenceSession.run

        def run_hook(self, output_names, input_feed, *args, **kw):
            seg["k"] += 1
            k = seg["k"]
            res = _orig_run(self, output_names, input_feed, *args, **kw)
            np.save(out / f"seg{k:02d}_features.npy", input_feed["features"])
            for name, arr in zip(("score", "noise", "ctx"), res):
                np.save(out / f"seg{k:02d}_{name}.npy", arr)
            return res

        ort.InferenceSession.run = run_hook

        _orig_decode = CRF.NeuralSemiCRFInterval.decode

        def decode_hook(self, forcedStartPos=None, forward=False):
            path = _orig_decode(self, forcedStartPos=forcedStartPos, forward=forward)
            json.dump({"forcedStartPos": list(forcedStartPos) if forcedStartPos is not None else None,
                       "paths": [[list(iv) for iv in p] for p in path]},
                      open(out / f"seg{seg['k']:02d}_paths.json", "w"))
            return path

        CRF.NeuralSemiCRFInterval.decode = decode_hook

    _orig_load = tod.load_model

    def load_hook():
        model = _orig_load()
        if a.dump:
            def mk(name):
                def hook(mod, inp, outp):
                    k = seg["k"]
                    if name == "vel":
                        np.save(out / f"seg{k:02d}_attr.npy", inp[0].numpy())
                        np.save(out / f"seg{k:02d}_vel_logits.npy", outp.numpy())
                    else:
                        np.save(out / f"seg{k:02d}_of_out.npy", outp.numpy())
                return hook
            model.velocityPredictor.register_forward_hook(mk("vel"))
            model.refinedOFPredictor.register_forward_hook(mk("of"))
        captured["model"] = model
        return model

    tod.load_model = load_hook

    _orig_write = tdata.writeMidi

    def write_hook(notes, *args, **kw):
        captured["notes"] = [dict(start=n.start, end=n.end, pitch=int(n.pitch), velocity=int(n.velocity),
                                  hasOnset=bool(n.hasOnset), hasOffset=bool(n.hasOffset)) for n in notes]
        return _orig_write(notes, *args, **kw)

    tdata.writeMidi = write_hook

    print(f"torch {torch.__version__} threads={torch.get_num_threads()}  ort {ort.__version__}")
    src = a.audio
    if a.app:
        from audio_utils import load_normalize_save
        import transcribe as app_tr          # python-engine/transcribe.py (defaults from env)
        norm = out / "norm.wav"
        load_normalize_save(Path(a.audio), norm, target_rms_db=app_tr.TARGET_RMS_DB,
                            peak_ceiling_db=app_tr.PEAK_CEILING_DB)
        src = str(norm)
    sys.argv = ["transcribe_onnx_dml.py", src, str(out / "ref.mid")]
    t0 = time.perf_counter()
    rc = tod.main()
    wall = time.perf_counter() - t0
    if rc:
        return rc
    if a.app:
        import shutil
        shutil.copyfile(out / "ref.mid", out / "app.mid")
        before, after = app_tr.clean_midi(out / "app.mid")
        print(f"[py_reference] clean_midi: {before} -> {after} notes")
    json.dump({"notes": captured["notes"], "wall_s": wall}, open(out / "notes.json", "w"), indent=0)
    print(f"[py_reference] {len(captured['notes'])} notes, wall (model load + transcribe) {wall:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
