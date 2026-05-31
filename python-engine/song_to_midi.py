import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Embeddable Python (launcher / portable bundle) doesn't auto-add the script
# dir to sys.path, so a sibling `import audio_utils` would fail. Add it ourselves.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# Provisioned assets (model / MSST / FFmpeg) live in the forge-env dir, not this
# (read-only when packaged) script dir. Resolve a base that actually contains them,
# falling back to ROOT for a co-located dev/source checkout.
def _forge_env_root():
    p = Path(sys.executable).resolve().parent
    return p.parent if p.name.lower() in ("python", "scripts") else p

_ASSET_BASE = _forge_env_root()
if not (_ASSET_BASE / "msst").exists() and (ROOT / "msst").exists():
    _ASSET_BASE = ROOT
MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (_ASSET_BASE / "models"))

FFMPEG_SHARED_BIN = str(_ASSET_BASE / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin")
if Path(FFMPEG_SHARED_BIN).exists():
    os.environ["PATH"] = FFMPEG_SHARED_BIN + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(FFMPEG_SHARED_BIN)

import pretty_midi
import torch

from audio_utils import expand_velocities, find_python, normalize_wav_in_place

# sys.executable in dev = venv\Scripts\python.exe; in portable bundle = python\python.exe.
PY = find_python()
MSST_DIR = _ASSET_BASE / "msst"
BS_ROFO_DIR = MODELS_BASE / "bs_rofo_sw"
BS_ROFO_YAML = BS_ROFO_DIR / "BS-Rofo-SW-Fixed.yaml"
BS_ROFO_CKPT = BS_ROFO_DIR / "BS-Rofo-SW-Fixed.ckpt"

MIN_NOTE_SEC = float(os.environ.get("MIN_NOTE_SEC", "0.05"))
MIN_VELOCITY = int(os.environ.get("MIN_VELOCITY", "20"))
USE_TTA = os.environ.get("USE_TTA", "0") in ("1", "true", "True", "yes")
BIGSHIFTS = int(os.environ.get("BIGSHIFTS", "1"))
PIANO_MIN_PITCH = int(os.environ.get("PIANO_MIN_PITCH", "21"))   # A0
PIANO_MAX_PITCH = int(os.environ.get("PIANO_MAX_PITCH", "108"))  # C8
SEGMENT_HOP = os.environ.get("SEGMENT_HOP")   # seconds; smaller = more overlap = better recall
SEGMENT_SIZE = os.environ.get("SEGMENT_SIZE")  # seconds; usually keep at default
if SEGMENT_HOP and not SEGMENT_SIZE:
    SEGMENT_SIZE = "16"  # transkun needs both or it crashes; 16s matches its training window
LOUDNESS_NORM = os.environ.get("LOUDNESS_NORM", "1") in ("1", "true", "True", "yes")
TARGET_RMS_DB = float(os.environ.get("TARGET_RMS_DB", "-20.0"))
PEAK_CEILING_DB = float(os.environ.get("PEAK_CEILING_DB", "-1.0"))
VELOCITY_GAMMA = float(os.environ.get("VELOCITY_GAMMA", "0.85"))


def safe_name(name: str) -> str:
    # MSST discovers input files with glob, so [], (), *, ? etc. in the name
    # (common in YouTube titles) break discovery. Strip them to a plain name.
    cleaned = re.sub(r'[\[\]()*?{}<>:"|!&#%$]', "_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._")
    return cleaned or "audio"


def stage_input(src: Path, stage_dir: Path) -> Path:
    stage_dir.mkdir(parents=True, exist_ok=True)
    # Stage under a glob-safe filename so MSST's file scan finds it.
    staged = stage_dir / (safe_name(src.stem) + src.suffix)
    if staged.exists():
        staged.unlink()
    try:
        os.link(src, staged)
    except OSError:
        shutil.copy2(src, staged)
    return staged


def separate_piano(src: Path, work_dir: Path) -> Path:
    print(f"\n[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem)")
    t0 = time.time()
    input_dir = work_dir / "input"
    output_dir = work_dir / "stems"
    output_dir.mkdir(parents=True, exist_ok=True)
    staged = stage_input(src, input_dir)

    cmd = [
        str(PY), "inference.py",
        "--model_type", "bs_roformer",
        "--config_path", str(BS_ROFO_YAML),
        "--start_check_point", str(BS_ROFO_CKPT),
        "--input_folder", str(input_dir),
        "--store_dir", str(output_dir),
        "--device_ids", "0",
    ]
    if USE_TTA:
        cmd.append("--use_tta")
    if BIGSHIFTS > 1:
        cmd += ["--bigshifts", str(BIGSHIFTS)]
    rc = subprocess.run(cmd, cwd=str(MSST_DIR), check=False).returncode
    if rc != 0:
        raise RuntimeError(f"MSST inference failed with exit code {rc}")

    candidates = [p for p in output_dir.rglob("*piano*.wav") if p.is_file()]
    if not candidates:
        listing = "\n  ".join(str(p.relative_to(output_dir)) for p in output_dir.rglob("*") if p.is_file())
        raise RuntimeError(f"No piano stem found in {output_dir}:\n  {listing}")
    piano_wav = candidates[0]
    print(f"  done in {time.time() - t0:.1f}s -> {piano_wav.name}")
    return piano_wav


def transcribe_to_midi(piano_wav: Path, out_midi: Path) -> None:
    print(f"\n[2/3] Transcribing with Transkun V2 (SOTA piano MIDI)")
    t0 = time.time()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # Use `-m transkun.transcribe` instead of transkun.exe so it works in the
    # portable bundle (no console_scripts shims in embedded Python).
    cmd = [str(PY), "-m", "transkun.transcribe", str(piano_wav), str(out_midi), "--device", device]
    if SEGMENT_HOP:
        cmd += ["--segmentHopSize", SEGMENT_HOP]
    if SEGMENT_SIZE:
        cmd += ["--segmentSize", SEGMENT_SIZE]
    rc = subprocess.run(cmd, check=False).returncode
    if rc != 0:
        raise RuntimeError(f"Transkun failed with exit code {rc}")
    print(f"  done in {time.time() - t0:.1f}s")


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
        print("Usage: song_to_midi.py <audio_file>")
        return 1

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"File not found: {src}")
        return 1

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}" + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else ""))
    print(f"Input: {src.name}")

    # Sanitize the work-dir name too: MSST globs the input folder path, and
    # brackets/parens in it would be read as glob character classes.
    work_dir = src.parent / "stems" / safe_name(src.stem)
    work_dir.mkdir(parents=True, exist_ok=True)

    piano_wav = separate_piano(src, work_dir)

    if LOUDNESS_NORM:
        print(f"    Normalizing piano stem to {TARGET_RMS_DB} dB RMS (peak ceiling {PEAK_CEILING_DB} dB)")
        normalize_wav_in_place(piano_wav, target_rms_db=TARGET_RMS_DB, peak_ceiling_db=PEAK_CEILING_DB)

    out_midi = src.with_suffix(".mid")
    transcribe_to_midi(piano_wav, out_midi)

    print(f"\n[3/3] Cleaning MIDI (drop notes < {MIN_NOTE_SEC}s or velocity < {MIN_VELOCITY}); velocity gamma {VELOCITY_GAMMA}")
    before, after = clean_midi(out_midi)
    print(f"  {before} -> {after} notes (dropped {before - after})")

    print(f"\nDONE.\n  Piano stem: {piano_wav}\n  MIDI:       {out_midi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
