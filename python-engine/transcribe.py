import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Embeddable Python (launcher / portable bundle) doesn't auto-add the script
# dir to sys.path, so a sibling `import audio_utils` would fail. Add it ourselves.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# FFmpeg lives in the provisioned forge-env, not this (read-only when packaged)
# script dir; resolve a base that holds it, falling back to ROOT for dev/source.
_ASSET_BASE = Path(sys.executable).resolve().parent
if _ASSET_BASE.name.lower() in ("python", "scripts"):
    _ASSET_BASE = _ASSET_BASE.parent
if not (_ASSET_BASE / "ffmpeg").exists() and (ROOT / "ffmpeg").exists():
    _ASSET_BASE = ROOT

FFMPEG_SHARED_BIN = str(_ASSET_BASE / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin")
if Path(FFMPEG_SHARED_BIN).exists():
    os.environ["PATH"] = FFMPEG_SHARED_BIN + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(FFMPEG_SHARED_BIN)

import pretty_midi
import torch

from audio_utils import expand_velocities, find_python, load_normalize_save

PY = find_python()

# Transcription backend:
#   cuda     - transkun on torch CUDA (NVIDIA)
#   onnx_dml - transkun acoustic model on ONNX Runtime + DirectML (any DX12 GPU)
#   cpu      - transkun on torch CPU
#   auto     - CUDA -> cuda; else DirectML GPU + model present -> onnx_dml; else cpu
TRANSCRIBE_BACKEND = os.environ.get("TRANSCRIBE_BACKEND", "auto").lower()
_MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (ROOT / "models"))
TRANSKUN_ONNX = _MODELS_BASE / "onnx" / "transkun_v2.onnx"


def resolve_transcribe_backend():
    if TRANSCRIBE_BACKEND in ("cuda", "cpu", "onnx_dml"):
        return TRANSCRIBE_BACKEND
    if torch.cuda.is_available():
        return "cuda"
    try:
        import onnxruntime as ort
        if ("DmlExecutionProvider" in ort.get_available_providers()
                and TRANSKUN_ONNX.exists()):
            return "onnx_dml"
    except Exception:
        pass
    return "cpu"


def transkun_cmd(backend, src, out_midi):
    """Build the transcription subprocess command for the chosen backend."""
    if backend == "onnx_dml":
        return [str(PY), str(ROOT / "transcribe_onnx_dml.py"),
                str(src), str(out_midi)]
    cmd = [str(PY), "-m", "transkun.transcribe", str(src), str(out_midi),
           "--device", backend]
    if SEGMENT_HOP:
        cmd += ["--segmentHopSize", SEGMENT_HOP]
    if SEGMENT_SIZE:
        cmd += ["--segmentSize", SEGMENT_SIZE]
    return cmd
MIN_NOTE_SEC = float(os.environ.get("MIN_NOTE_SEC", "0.05"))
MIN_VELOCITY = int(os.environ.get("MIN_VELOCITY", "20"))
PIANO_MIN_PITCH = int(os.environ.get("PIANO_MIN_PITCH", "21"))
PIANO_MAX_PITCH = int(os.environ.get("PIANO_MAX_PITCH", "108"))
SEGMENT_HOP = os.environ.get("SEGMENT_HOP")
SEGMENT_SIZE = os.environ.get("SEGMENT_SIZE")
if SEGMENT_HOP and not SEGMENT_SIZE:
    SEGMENT_SIZE = "16"
LOUDNESS_NORM = os.environ.get("LOUDNESS_NORM", "1") in ("1", "true", "True", "yes")
TARGET_RMS_DB = float(os.environ.get("TARGET_RMS_DB", "-20.0"))
PEAK_CEILING_DB = float(os.environ.get("PEAK_CEILING_DB", "-1.0"))
VELOCITY_GAMMA = float(os.environ.get("VELOCITY_GAMMA", "0.85"))


def clean_midi(midi_path: Path) -> tuple[int, int]:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    before = sum(len(i.notes) for i in pm.instruments)
    for inst in pm.instruments:
        inst.notes = [
            n for n in inst.notes
            if (n.end - n.start) >= MIN_NOTE_SEC
            and n.velocity >= MIN_VELOCITY
            and PIANO_MIN_PITCH <= n.pitch <= PIANO_MAX_PITCH
        ]
        expand_velocities(inst.notes, gamma=VELOCITY_GAMMA, floor=MIN_VELOCITY)
    after = sum(len(i.notes) for i in pm.instruments)
    pm.write(str(midi_path))
    return before, after


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <piano_audio> [output.mid]")
        return 1

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"File not found: {src}")
        return 1

    out_midi = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_suffix(".mid")
    backend = resolve_transcribe_backend()
    print(f"Backend: {backend}"
          + (f" ({torch.cuda.get_device_name(0)})" if backend == "cuda" else "")
          + (" (ONNX Runtime + DirectML)" if backend == "onnx_dml" else ""))

    norm_wav = src.with_name(src.stem + "_norm.wav") if LOUDNESS_NORM else None
    try:
        if LOUDNESS_NORM:
            print(f"Normalizing to {TARGET_RMS_DB} dB RMS -> {norm_wav.name}")
            load_normalize_save(src, norm_wav, target_rms_db=TARGET_RMS_DB, peak_ceiling_db=PEAK_CEILING_DB)
            transcribe_src = norm_wav
        else:
            transcribe_src = src

        print(f"Transcribing with Transkun V2: {src.name}")
        t0 = time.time()
        cmd = transkun_cmd(backend, transcribe_src, out_midi)
        rc = subprocess.run(cmd, check=False).returncode
        if rc != 0:
            print(f"Transkun failed with exit code {rc}")
            return rc
        print(f"  done in {time.time() - t0:.1f}s")

        before, after = clean_midi(out_midi)
        print(f"MIDI cleanup: {before} -> {after} notes (dropped {before - after}); velocity gamma {VELOCITY_GAMMA}")
        print(f"\nDONE. MIDI: {out_midi}")
        return 0
    finally:
        if norm_wav and norm_wav.exists():
            try:
                norm_wav.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
