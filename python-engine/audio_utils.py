"""Audio + MIDI helpers shared by the transcription scripts."""
import os
import sys
from pathlib import Path

import numpy as np


def find_python() -> Path:
    """Return the python.exe matching the current interpreter.
    Converts pythonw.exe -> python.exe so subprocess output reaches stdout.
    Works in dev (venv) and portable (bundled embedded Python) modes."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        candidate = exe.with_name("python.exe")
        if candidate.exists():
            return candidate
    return exe


def _db(x: float) -> float:
    return 20.0 * np.log10(max(x, 1e-12))


def normalize_wav_in_place(
    wav_path: Path,
    target_rms_db: float = -20.0,
    peak_ceiling_db: float = -1.0,
) -> Path:
    import soundfile as sf

    audio, sr = sf.read(str(wav_path), always_2d=False, dtype="float32")
    if audio.size == 0:
        return wav_path

    mono = audio.mean(axis=1) if audio.ndim > 1 else audio
    rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
    if rms < 1e-9:
        return wav_path

    gain = 10.0 ** ((target_rms_db - _db(rms)) / 20.0)
    audio_n = audio * gain

    peak = float(np.abs(audio_n).max())
    ceiling = 10.0 ** (peak_ceiling_db / 20.0)
    if peak > ceiling:
        audio_n = audio_n * (ceiling / peak)

    sf.write(str(wav_path), audio_n, sr)
    return wav_path


def load_normalize_save(
    src: Path,
    out_wav: Path,
    target_rms_db: float = -20.0,
    peak_ceiling_db: float = -1.0,
    normalize: bool = True,
) -> Path:
    import librosa
    import soundfile as sf

    audio, sr = librosa.load(str(src), sr=None, mono=False)
    if normalize:
        mono = audio.mean(axis=0) if audio.ndim > 1 else audio
        rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
        if rms >= 1e-9:
            gain = 10.0 ** ((target_rms_db - _db(rms)) / 20.0)
            audio = audio * gain
            peak = float(np.abs(audio).max())
            ceiling = 10.0 ** (peak_ceiling_db / 20.0)
            if peak > ceiling:
                audio = audio * (ceiling / peak)

    out = audio.T if audio.ndim > 1 else audio
    sf.write(str(out_wav), out, sr)
    return out_wav


def audio_window_from_env(src: Path, work_dir: Path | None = None) -> Path:
    """Return a WAV clipped to FORGE_START_SEC/FORGE_END_SEC, or src unchanged."""
    start_raw = os.environ.get("FORGE_START_SEC", "").strip()
    end_raw = os.environ.get("FORGE_END_SEC", "").strip()
    if not start_raw and not end_raw:
        return src

    start = float(start_raw) if start_raw else 0.0
    end = float(end_raw) if end_raw else 0.0
    if start < 0:
        start = 0.0
    duration = (end - start) if end > start else None
    if start <= 0 and duration is None:
        return src

    import librosa
    import soundfile as sf

    out_dir = work_dir or src.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stop_label = f"{end:.3f}" if end > start else "end"
    tag = f"_range_{start:.3f}_{stop_label}".replace(".", "p")
    out_wav = out_dir / f"{src.stem}{tag}.wav"
    audio, sr = librosa.load(str(src), sr=None, mono=False, offset=start, duration=duration)
    if audio.size == 0:
        raise RuntimeError("Selected time range contains no audio.")
    out = audio.T if audio.ndim > 1 else audio
    sf.write(str(out_wav), out, sr)
    print(f"Time range: {start:.3f}s -> " + (f"{end:.3f}s" if end > start else "end"))
    return out_wav


def expand_velocities(notes, gamma: float = 0.85, floor: int = 10) -> None:
    # gamma<1 expands (soft softer, loud louder); gamma>1 compresses;
    # pivot is the median so the curve adapts to whatever range Transkun emitted.
    if not notes or gamma == 1.0:
        return
    vels = sorted(n.velocity for n in notes)
    pivot = float(vels[len(vels) // 2])
    span = max(pivot, 127.0 - pivot, 1.0)
    for n in notes:
        d = (n.velocity - pivot) / span
        sign = 1.0 if d >= 0 else -1.0
        d_new = sign * (abs(d) ** gamma)
        v_new = pivot + d_new * span
        n.velocity = max(floor, min(127, int(round(v_new))))
