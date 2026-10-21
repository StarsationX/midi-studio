"""make_bp_fixture.py AUDIO.wav OUTDIR: golden fixtures for the basic-pitch
decode (tests/basic_pitch.rs), from the forge env's own basic_pitch 0.4.0,
stem_to_midi.clean_midi and melody_shape.

Writes bp_note/onset/contour.npy (raw model output, first 4 s), bp_raw.mid
(predict's MIDI with stem_to_midi's settings), bp_clean.mid (stem_to_midi
cleanup), bp_raw_melody.mid (melody settings) and bp_melody_{clean,balanced,
detailed}.mid (build_candidates).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python-engine"))
import numpy as np
import pretty_midi
import librosa
import basic_pitch.inference as inf
import basic_pitch.note_creation as nc
from basic_pitch import ICASSP_2022_MODEL_PATH

audio, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
y, _ = librosa.load(str(audio), sr=22050, mono=True)
y = y[22050 * 10: 22050 * 14]
tmp = out / "_bp_tmp.wav"
import soundfile as sf
sf.write(str(tmp), y, 22050, subtype="FLOAT")
mo = inf.run_inference(str(tmp), inf.Model(ICASSP_2022_MODEL_PATH))
tmp.unlink()
for k in ("note", "onset", "contour"):
    np.save(out / f"bp_{k}.npy", mo[k].astype(np.float32))


def decode(onset, frame, ms, fmin, fmax):
    m = {k: v.copy() for k, v in mo.items()}
    mnl = int(np.round(ms / 1000 * (22050 / 256)))
    midi, _ = nc.model_output_to_notes(m, onset_thresh=onset, frame_thresh=frame, min_note_len=mnl, min_freq=fmin,
                                       max_freq=fmax, multiple_pitch_bends=False, melodia_trick=True, midi_tempo=120)
    return midi


decode(0.5, 0.3, 58, 27.5, 4186.0).write(str(out / "bp_raw.mid"))
os.environ.setdefault("PIANO_MIN_PITCH", "0")
import stem_to_midi as stm
import shutil
shutil.copy2(out / "bp_raw.mid", out / "bp_clean.mid")
print("clean", stm.clean_midi(out / "bp_clean.mid"))
decode(0.42, 0.28, 30, pretty_midi.note_number_to_hz(45), pretty_midi.note_number_to_hz(100)).write(str(out / "bp_raw_melody.mid"))
import melody_to_midi as mel
paths, counts = mel.build_candidates(out / "bp_raw_melody.mid", out / "bp_melody_clean.mid")
for k, p in paths.items():
    if p.name != f"bp_melody_{k}.mid":
        p.replace(out / f"bp_melody_{k}.mid")
print("melody", counts)
