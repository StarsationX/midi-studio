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
import song_to_midi as song


MIN_PITCH = int(os.environ.get("MELODY_MIN_PITCH", "48"))
MAX_PITCH = int(os.environ.get("MELODY_MAX_PITCH", "96"))
BP_ONSET = float(os.environ.get("MELODY_ONSET_THRESHOLD", "0.42"))
BP_FRAME = float(os.environ.get("MELODY_FRAME_THRESHOLD", "0.28"))
BP_MIN_NOTE_MS = int(os.environ.get("MELODY_MIN_NOTE_MS", "45"))
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


def _clone_note(note: pretty_midi.Note) -> pretty_midi.Note:
    return pretty_midi.Note(
        velocity=int(note.velocity), pitch=int(note.pitch),
        start=float(note.start), end=float(note.end))


def _group_onsets(notes, window=0.055):
    groups, current, start = [], [], None
    for note in sorted(notes, key=lambda n: (n.start, -n.velocity, -n.pitch)):
        if start is None or note.start - start <= window:
            if start is None:
                start = note.start
            current.append(note)
        else:
            groups.append(current)
            current, start = [note], note.start
    if current:
        groups.append(current)
    return groups


def _lead_score(note, previous_pitch):
    velocity = note.velocity / 127.0
    duration = min(1.0, max(0.0, note.end - note.start) / 0.45)
    register = (note.pitch - MIN_PITCH) / max(1, MAX_PITCH - MIN_PITCH)
    continuity = 0.5 if previous_pitch is None else max(0.0, 1.0 - abs(note.pitch - previous_pitch) / 18.0)
    return velocity * 0.42 + duration * 0.18 + register * 0.15 + continuity * 0.25


def _merge_repeats(notes, max_gap):
    out = []
    for note in sorted(notes, key=lambda n: (n.start, n.pitch)):
        if out and out[-1].pitch == note.pitch and note.start - out[-1].end <= max_gap:
            out[-1].end = max(out[-1].end, note.end)
            out[-1].velocity = max(out[-1].velocity, note.velocity)
        else:
            out.append(_clone_note(note))
    return out


def _candidate_notes(raw_notes, polyphony, min_duration, merge_gap):
    notes = [n for n in raw_notes
             if MIN_PITCH <= n.pitch <= MAX_PITCH and n.end - n.start >= min_duration]
    selected, previous_pitch = [], None
    for group in _group_onsets(notes):
        ranked = sorted(group, key=lambda n: _lead_score(n, previous_pitch), reverse=True)
        chosen = ranked[:polyphony]
        if chosen:
            previous_pitch = chosen[0].pitch
            selected.extend(_clone_note(n) for n in chosen)
    merged = _merge_repeats(selected, merge_gap)
    if polyphony == 1:
        for previous, current in zip(merged, merged[1:]):
            if previous.end > current.start:
                previous.end = max(previous.start + 0.02, current.start)
    return [note for note in merged if note.end - note.start >= 0.02]


def _write_candidate(template, notes, path: Path, name: str):
    tempo = 120.0
    if template.get_onsets().size > 1:
        try:
            estimate = float(template.estimate_tempo())
            if np.isfinite(estimate) and estimate > 0:
                tempo = estimate
        except (ValueError, ZeroDivisionError):
            pass
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
    specs = {
        "clean": (1, 0.085, 0.075),
        "balanced": (2, 0.060, 0.055),
        "detailed": (3, 0.040, 0.035),
    }
    counts = {}
    for name, spec in specs.items():
        notes = _candidate_notes(raw_notes, *spec)
        _write_candidate(pm, notes, paths[name], f"Main Melody - {name.title()}")
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
    work_dir = src.parent / "stems" / (song.safe_name(src.stem) + "_melody")
    work_dir.mkdir(parents=True, exist_ok=True)
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
    try:
        raw_midi.unlink(missing_ok=True)
        norm_wav.unlink(missing_ok=True)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
