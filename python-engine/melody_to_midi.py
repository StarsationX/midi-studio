"""Extract playable lead-melody candidates from dense mixed music."""

import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

logging.getLogger("basic_pitch").setLevel(logging.ERROR)

import numpy as np
import pretty_midi
import soundfile as sf
from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict
from scipy.signal import butter, sosfiltfilt

from audio_utils import audio_window_from_env, load_normalize_save
import melody_shape as shaper
import song_to_midi as song


# Range widened from C3-C7: artcore leads run above C7 and drop to a low
# octave between sections, and MELODY_FOLD brings anything outside back in
# rather than deleting the hook.
MIN_PITCH = int(os.environ.get("MELODY_MIN_PITCH", "45"))
MAX_PITCH = int(os.environ.get("MELODY_MAX_PITCH", "100"))
FOLD_OCTAVES = os.environ.get("MELODY_FOLD", "1") in ("1", "true", "True", "yes")
# Notes per second the "clean" candidate is allowed to reach. Dense fills go
# past 30; nobody can play that, and it reads as noise on a piano-roll anyway.
DENSITY = float(os.environ.get("MELODY_DENSITY", "13"))
BP_ONSET = float(os.environ.get("MELODY_ONSET_THRESHOLD", "0.42"))
BP_FRAME = float(os.environ.get("MELODY_FRAME_THRESHOLD", "0.28"))
BP_MIN_NOTE_MS = int(os.environ.get("MELODY_MIN_NOTE_MS", "45"))
# A supersaw stack transcribes as the note plus a quiet simultaneous fifth, and
# those parallel fifths are the most obvious wrong thing in a dense electronic
# transcription. Off for material that really does play in fifths (some
# orchestral writing, power chords) where removing them takes real notes.
STRICT_FIFTHS = os.environ.get("MELODY_STRICT_FIFTHS", "1") in ("1", "true", "True", "yes")
SKIP_SEP = os.environ.get("SKIP_SEPARATION", "0") in ("1", "true", "True", "yes")


def _stem_label(path: Path) -> str:
    name = path.stem.lower()
    for label in ("drums", "drum", "percussion", "bass", "vocals", "vocal",
                  "other", "piano", "guitar"):
        if label in name:
            return label
    return name


def _mix_lead_stems(src: Path, work_dir: Path) -> Path:
    backend = song._resolve_backend()
    if SKIP_SEP:
        print("  using isolated input directly")
        audio, sr = sf.read(str(src), always_2d=True, dtype="float32")
    elif backend == "onnx_dml":
        mixed = song.separate_onnx_general(src, work_dir)
        audio, sr = sf.read(str(mixed), always_2d=True, dtype="float32")
    else:
        stems_dir = song.run_separation(src, work_dir)
        wavs = sorted(p for p in stems_dir.rglob("*.wav") if p.is_file())
        picked = [p for p in wavs if _stem_label(p) not in {
            "drums", "drum", "percussion", "bass", "vocals", "vocal"
        }]
        if not picked:
            picked = [p for p in wavs if _stem_label(p) not in {"drums", "drum", "percussion", "bass"}]
        if not picked:
            raise RuntimeError("Separation produced no pitched lead stems.")
        print("  lead stems: " + ", ".join(_stem_label(p) for p in picked))
        audio, sr = None, None
        for p in picked:
            part, part_sr = sf.read(str(p), always_2d=True, dtype="float32")
            if sr is None:
                sr = part_sr
            if part_sr != sr:
                continue
            if audio is None:
                audio = part.copy()
            else:
                n, c = min(len(audio), len(part)), min(audio.shape[1], part.shape[1])
                audio = audio[:n, :c] + part[:n, :c]
        if audio is None:
            raise RuntimeError("No compatible lead stems were produced.")

    # Electronic bass and kick leakage create strong false fundamentals. A gentle
    # high-pass keeps the lead band while leaving low melodic notes intact.
    cutoff = max(45.0, pretty_midi.note_number_to_hz(MIN_PITCH - 12))
    sos = butter(4, cutoff, btype="highpass", fs=sr, output="sos")
    audio = sosfiltfilt(sos, audio, axis=0).astype("float32")
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0:
        audio *= min(1.0, 0.98 / peak)
    out = work_dir / "melody_mix.wav"
    sf.write(str(out), audio, sr)
    return out


def _write_candidate(tempo, notes, path: Path, name: str):
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=81, name=name)
    inst.notes = sorted(notes, key=lambda n: (n.start, n.pitch))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def build_candidates(raw_midi: Path, primary: Path):
    pm = pretty_midi.PrettyMIDI(str(raw_midi))
    raw_notes = [n for inst in pm.instruments if not inst.is_drum for n in inst.notes]
    if not raw_notes:
        raise RuntimeError("No pitched notes were detected in the selected audio.")

    paths = {
        "clean": primary,
        "balanced": primary.with_name(primary.stem + "_balanced.mid"),
        "detailed": primary.with_name(primary.stem + "_detailed.mid"),
    }
    # Timing everywhere below is derived from this, so a 200 BPM track stops
    # having its 32nds merged into chords by a fixed window.
    # Only a starting point now: the shaper measures the local spacing itself,
    # because this material changes speed inside a single track.
    bpm = shaper.estimate_bpm(raw_notes)
    print(f"  detected tempo: {bpm:.0f} BPM")
    specs = {
        # polyphony, shortest note, notes/second cap
        "clean": (1, 0.070, DENSITY),
        "balanced": (2, 0.055, DENSITY * 1.6),
        "detailed": (3, 0.040, 0.0),
    }
    counts = {}
    for name, (polyphony, min_duration, density) in specs.items():
        notes = shaper.shape(raw_notes, polyphony=polyphony, min_duration=min_duration,
                             bpm=bpm, low=MIN_PITCH, high=MAX_PITCH,
                             fold=FOLD_OCTAVES, density=density,
                             strict_fifths=STRICT_FIFTHS)
        _write_candidate(bpm, notes, paths[name], f"Main Melody - {name.title()}")
        counts[name] = len(notes)
        print(f"  {name}: {len(notes)} notes")
    return paths, counts


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: melody_to_midi.py <audio_file> [output.mid]")
        return 1
    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"File not found: {src}")
        return 1
    out_midi = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_name(src.stem + "_melody.mid")
    work_dir = song.work_root(src, "_melody")
    process_src = audio_window_from_env(src, work_dir)

    print(f"Input: {src.name}")
    print("\n[1/4] Isolating pitched lead material")
    lead_wav = _mix_lead_stems(process_src, work_dir)
    norm_wav = work_dir / "melody_norm.wav"
    load_normalize_save(lead_wav, norm_wav, target_rms_db=-18.0, peak_ceiling_db=-1.0)

    raw_midi = work_dir / "melody_raw.mid"
    print("\n[2/4] Detecting instrument-agnostic pitches")
    started = time.time()
    _, midi_data, _ = predict(
        str(norm_wav), model_or_model_path=ICASSP_2022_MODEL_PATH,
        onset_threshold=BP_ONSET, frame_threshold=BP_FRAME,
        minimum_note_length=BP_MIN_NOTE_MS,
        minimum_frequency=pretty_midi.note_number_to_hz(MIN_PITCH),
        maximum_frequency=pretty_midi.note_number_to_hz(MAX_PITCH),
        multiple_pitch_bends=False, melodia_trick=True)
    midi_data.write(str(raw_midi))
    print(f"  detected in {time.time() - started:.1f}s")

    print("\n[3/4] Building Clean, Balanced, and Detailed candidates")
    candidates, counts = build_candidates(raw_midi, out_midi)
    print("\n[4/4] Preparing review project")
    result = {
        "midiPath": str(candidates["clean"]),
        "candidates": {k: str(v) for k, v in candidates.items()},
        "candidateCounts": counts,
        "sourceAudio": str(src),
        "previewAudio": str(src),
        "pipeline": "melody",
    }
    print("RESULT|" + json.dumps(result, ensure_ascii=False))
    print("DONE.")
    song.cleanup_work(work_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
