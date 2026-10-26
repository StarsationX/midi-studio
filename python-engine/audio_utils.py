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


# Transkun only knows a piano tuned to A440. An upright 41 cents sharp gave 201
# notes where the in-tune copy gave 507: notes near halfway between two keys get
# dropped. FORGE_RETUNE=0 turns the correction off.
RETUNE_MIN_CENTS = 15.0


def tuning_cents(y: np.ndarray, sr: int, fmin: float = 80.0, fmax: float = 1000.0) -> float:
    """Offset from A440 in cents, in [-50, 50): the magnitude-weighted circular
    mean of every spectral peak's distance to its nearest equal-tempered pitch."""
    import scipy.signal as sg
    # 16384-point frames for ~1.3 Hz bins at 22.05 kHz; a hop of half a frame
    # keeps a 10 minute song's spectrogram near 100 MB.
    f, _, z = sg.stft(y, sr, nperseg=16384, noverlap=8192)
    lo, hi = np.searchsorted(f, fmin), np.searchsorted(f, fmax)
    mag = np.abs(z[lo:hi])
    acc = 0j
    for col in mag.T:
        top = col.max()
        if top <= 0:
            continue
        for p in sg.find_peaks(col, height=top * 0.1)[0]:
            if 0 < p < len(col) - 1:
                a, b, c = np.log(col[p - 1:p + 2] + 1e-12)
                den = a - 2 * b + c
                hz = f[lo + p] + (0.5 * (a - c) / den if den else 0.0) * (f[1] - f[0])
                acc += col[p] * np.exp(2j * np.pi * 12 * np.log2(hz / 440.0))
    return 100.0 * np.angle(acc) / (2 * np.pi) if acc else 0.0


def retune_for_transkun(wav: Path) -> tuple[Path, float]:
    """An in-tune copy of `wav` next to it when it sits RETUNE_MIN_CENTS or more
    off A440, plus the factor that maps the copy's note times back onto the
    original; (wav, 1.0) when it is close enough or FORGE_RETUNE=0. The copy is
    resampled, not pitch-shifted, so attacks stay intact (it plays a little
    slower or faster, which the factor undoes)."""
    if os.environ.get("FORGE_RETUNE", "1") in ("0", "false", "False", "no"):
        return wav, 1.0
    import soundfile as sf
    import soxr
    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    cents = tuning_cents(soxr.resample(audio.mean(axis=1), sr, 22050), 22050)
    if abs(cents) < RETUNE_MIN_CENTS:
        print(f"  tuning {cents:+.0f} cents from A440, close enough")
        return wav, 1.0
    ratio = 2.0 ** (-cents / 1200.0)
    out = wav.with_name(wav.stem + "_tuned.wav")
    sf.write(str(out), soxr.resample(audio, sr, sr / ratio), sr)
    print(f"  tuning {cents:+.0f} cents from A440, retuned for transcription")
    return out, ratio


def scale_midi_times(midi_path: Path, ratio: float) -> None:
    """Multiply every event time in the file by `ratio` (retune_for_transkun's)."""
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    end = pm.get_end_time()
    if end > 0:
        pm.adjust_times([0.0, end], [0.0, end * ratio])
    pm.write(str(midi_path))


if __name__ == "__main__":
    # self-check: a sine 40 cents sharp of A4 reads as +40, A440 as 0
    sr = 22050
    t = np.arange(sr * 3) / sr
    for want in (0.0, 40.0, -30.0):
        y = np.sin(2 * np.pi * 440.0 * 2 ** (want / 1200) * t).astype(np.float32)
        got = tuning_cents(y, sr)
        assert abs(got - want) < 2, (want, got)
    print("audio_utils self-check ok")
