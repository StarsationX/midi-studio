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
FFMPEG_SHARED_BIN = str(ROOT / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin")
if Path(FFMPEG_SHARED_BIN).exists():
    os.environ["PATH"] = FFMPEG_SHARED_BIN + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(FFMPEG_SHARED_BIN)

logging.getLogger("basic_pitch").setLevel(logging.ERROR)

import pretty_midi
from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict

from audio_utils import expand_velocities, load_normalize_save

MIN_NOTE_SEC = float(os.environ.get("MIN_NOTE_SEC", "0.05"))
MIN_VELOCITY = int(os.environ.get("MIN_VELOCITY", "20"))
MIN_PITCH = int(os.environ.get("PIANO_MIN_PITCH", "0"))
MAX_PITCH = int(os.environ.get("PIANO_MAX_PITCH", "127"))

BP_ONSET = float(os.environ.get("BP_ONSET_THRESHOLD", "0.5"))
BP_FRAME = float(os.environ.get("BP_FRAME_THRESHOLD", "0.3"))
BP_MIN_NOTE_MS = int(os.environ.get("BP_MIN_NOTE_MS", "58"))

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
            and MIN_PITCH <= n.pitch <= MAX_PITCH
        ]
        expand_velocities(inst.notes, gamma=VELOCITY_GAMMA, floor=MIN_VELOCITY)
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

    print(f"Input:  {src.name}")
    print(f"Output: {out_midi.name}")
    print(f"basic-pitch settings: onset={BP_ONSET}, frame={BP_FRAME}, min_note_ms={BP_MIN_NOTE_MS}")

    norm_wav = src.with_name(src.stem + "_norm.wav") if LOUDNESS_NORM else None
    try:
        if LOUDNESS_NORM:
            print(f"Normalizing to {TARGET_RMS_DB} dB RMS -> {norm_wav.name}")
            load_normalize_save(src, norm_wav, target_rms_db=TARGET_RMS_DB, peak_ceiling_db=PEAK_CEILING_DB)
            predict_src = norm_wav
        else:
            predict_src = src

        t0 = time.time()
        _, midi_data, _ = predict(
            str(predict_src),
            model_or_model_path=ICASSP_2022_MODEL_PATH,
            onset_threshold=BP_ONSET,
            frame_threshold=BP_FRAME,
            minimum_note_length=BP_MIN_NOTE_MS,
            minimum_frequency=None,
            maximum_frequency=None,
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
