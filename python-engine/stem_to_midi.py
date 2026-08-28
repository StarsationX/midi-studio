import logging
import os
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

logging.getLogger("basic_pitch").setLevel(logging.ERROR)

import pretty_midi
from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict

from audio_utils import audio_window_from_env, expand_velocities, load_normalize_save

# A 32nd note at 174 BPM is 43 ms, so a 50 ms floor deleted real notes
# out of fast tracks. Transkun rarely emits anything under 30 ms, so the
# lower floor costs almost no false positives.
MIN_NOTE_SEC = float(os.environ.get("MIN_NOTE_SEC", "0.03"))
MIN_VELOCITY = int(os.environ.get("MIN_VELOCITY", "20"))
MIN_PITCH = int(os.environ.get("PIANO_MIN_PITCH", "0"))
MAX_PITCH = int(os.environ.get("PIANO_MAX_PITCH", "127"))

BP_ONSET = float(os.environ.get("BP_ONSET_THRESHOLD", "0.5"))
BP_FRAME = float(os.environ.get("BP_FRAME_THRESHOLD", "0.3"))
BP_MIN_NOTE_MS = int(os.environ.get("BP_MIN_NOTE_MS", "58"))

# Constrain detection to the playable piano band (A0..C8). basic-pitch otherwise
# happily emits sub-bass rumble and ultrasonic harmonic ghosts that the piano
# player can't play anyway, limiting at the source yields a much cleaner MIDI.
def _env_freq(name, default):
    v = os.environ.get(name, "")
    try:
        f = float(v)
        return f if f > 0 else None  # 0 / blank => no limit
    except ValueError:
        return default
BP_MIN_FREQ = _env_freq("BP_MIN_FREQ", 27.5)     # A0
BP_MAX_FREQ = _env_freq("BP_MAX_FREQ", 4186.0)   # C8

# Fold notes that land just outside the target range back in by whole octaves
# (instead of dropping them) so the melodic line survives on an 88-key board.
OCTAVE_FOLD = os.environ.get("OCTAVE_FOLD", "1") in ("1", "true", "True", "yes")
FOLD_MIN = int(os.environ.get("FOLD_MIN_PITCH", "21"))    # A0
FOLD_MAX = int(os.environ.get("FOLD_MAX_PITCH", "108"))   # C8
# Cap simultaneous notes (keeps the loudest in each chord). 0 = unlimited.
# Basic-pitch general output is dense; a low cap makes Roblox-piano playback
# far cleaner and avoids dropped/spammed keys.
MAX_POLYPHONY = int(os.environ.get("MAX_POLYPHONY", "0"))

LOUDNESS_NORM = os.environ.get("LOUDNESS_NORM", "1") in ("1", "true", "True", "yes")
TARGET_RMS_DB = float(os.environ.get("TARGET_RMS_DB", "-20.0"))
PEAK_CEILING_DB = float(os.environ.get("PEAK_CEILING_DB", "-1.0"))
VELOCITY_GAMMA = float(os.environ.get("VELOCITY_GAMMA", "0.85"))


def _fold_pitch(p: int) -> int:
    if FOLD_MAX - FOLD_MIN < 12:        # degenerate range -> just clamp
        return max(0, min(127, p))
    while p < FOLD_MIN:
        p += 12
    while p > FOLD_MAX:
        p -= 12
    return p


def _cap_polyphony(notes, max_poly):
    """Limit chord density: group notes by near-equal onset and keep the loudest."""
    if max_poly <= 0 or len(notes) <= max_poly:
        return notes
    notes = sorted(notes, key=lambda n: n.start)
    out, group, gstart = [], [], None
    Q = 0.035  # notes starting within 35 ms count as one chord
    for nt in notes:
        if gstart is None or nt.start - gstart <= Q:
            if gstart is None:
                gstart = nt.start
            group.append(nt)
        else:
            out.extend(group if len(group) <= max_poly
                       else sorted(group, key=lambda n: n.velocity, reverse=True)[:max_poly])
            group, gstart = [nt], nt.start
    out.extend(group if len(group) <= max_poly
               else sorted(group, key=lambda n: n.velocity, reverse=True)[:max_poly])
    return out


def clean_midi(midi_path: Path) -> tuple[int, int]:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    before = sum(len(i.notes) for i in pm.instruments)
    for inst in pm.instruments:
        notes = [n for n in inst.notes
                 if (n.end - n.start) >= MIN_NOTE_SEC and n.velocity >= MIN_VELOCITY]
        if OCTAVE_FOLD:
            for n in notes:
                n.pitch = _fold_pitch(n.pitch)
        notes = [n for n in notes if MIN_PITCH <= n.pitch <= MAX_PITCH]
        notes = _cap_polyphony(notes, MAX_POLYPHONY)
        expand_velocities(notes, gamma=VELOCITY_GAMMA, floor=MIN_VELOCITY)
        inst.notes = notes
    after = sum(len(i.notes) for i in pm.instruments)
    pm.write(str(midi_path))
    return before, after


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: stem_to_midi.py <audio_file> [output.mid]")
        return 1

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"File not found: {src}")
        return 1
    out_midi = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_suffix(".mid")
    process_src = audio_window_from_env(src, src.parent / "stems" / src.stem)

    print(f"Input:  {src.name}")
    print(f"Output: {out_midi.name}")
    print(f"basic-pitch settings: onset={BP_ONSET}, frame={BP_FRAME}, min_note_ms={BP_MIN_NOTE_MS}")
    print(f"band: {BP_MIN_FREQ}-{BP_MAX_FREQ} Hz | octave-fold: {OCTAVE_FOLD} "
          f"[{FOLD_MIN}-{FOLD_MAX}] | max-polyphony: {MAX_POLYPHONY or 'unlimited'}")

    norm_wav = src.with_name(src.stem + "_norm.wav") if LOUDNESS_NORM else None
    try:
        if LOUDNESS_NORM:
            print(f"Normalizing to {TARGET_RMS_DB} dB RMS -> {norm_wav.name}")
            load_normalize_save(process_src, norm_wav, target_rms_db=TARGET_RMS_DB, peak_ceiling_db=PEAK_CEILING_DB)
            predict_src = norm_wav
        else:
            predict_src = process_src

        t0 = time.time()
        _, midi_data, _ = predict(
            str(predict_src),
            model_or_model_path=ICASSP_2022_MODEL_PATH,
            onset_threshold=BP_ONSET,
            frame_threshold=BP_FRAME,
            minimum_note_length=BP_MIN_NOTE_MS,
            minimum_frequency=BP_MIN_FREQ,
            maximum_frequency=BP_MAX_FREQ,
            multiple_pitch_bends=False,
            melodia_trick=True,
        )
        midi_data.write(str(out_midi))
        print(f"Transcribed in {time.time() - t0:.1f}s")

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
