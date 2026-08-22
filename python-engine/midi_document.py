"""Small JSON bridge used by the Electron review workspace."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import mido


def load_midi(path: Path) -> dict:
    midi = mido.MidiFile(str(path))
    time_sec = 0.0
    tempo = 500000
    found_tempo = False
    active: dict[tuple[int, int], list[tuple[float, int]]] = {}
    notes = []
    for msg in midi:
        time_sec += float(msg.time)
        if msg.type == "set_tempo" and not found_tempo:
            tempo = msg.tempo
            found_tempo = True
        elif msg.type == "note_on" and msg.velocity > 0:
            active.setdefault((msg.channel, msg.note), []).append((time_sec, msg.velocity))
        elif msg.type in ("note_off", "note_on"):
            key = (msg.channel, msg.note)
            starts = active.get(key)
            if starts:
                start, velocity = starts.pop(0)
                notes.append({
                    "id": f"n{len(notes) + 1}",
                    "pitch": int(msg.note),
                    "start": round(start, 6),
                    "end": round(max(start + 0.01, time_sec), 6),
                    "velocity": int(velocity),
                    "channel": int(msg.channel),
                })
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    duration = max([float(midi.length)] + [n["end"] for n in notes])
    return {
        "path": str(path.resolve()),
        "name": path.stem,
        "bpm": round(mido.tempo2bpm(tempo), 3),
        "duration": round(duration, 6),
        "notes": notes,
    }


def save_midi(path: Path, document: dict) -> None:
    bpm = max(20.0, min(400.0, float(document.get("bpm", 120))))
    ticks = 480
    tempo = mido.bpm2tempo(bpm)
    events = []
    for note in document.get("notes", []):
        pitch = max(0, min(127, int(note.get("pitch", 60))))
        velocity = max(1, min(127, int(note.get("velocity", 96))))
        start = max(0.0, float(note.get("start", 0)))
        end = max(start + 0.01, float(note.get("end", start + 0.25)))
        events.append((start, 1, pitch, velocity))
        events.append((end, 0, pitch, 0))
    events.sort(key=lambda event: (event[0], event[1], event[2]))

    midi = mido.MidiFile(ticks_per_beat=ticks)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("track_name", name="MIDI Studio Review", time=0))
    track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    previous = 0.0
    for at, kind, pitch, velocity in events:
        delta = max(0.0, at - previous)
        tick_delta = int(round(mido.second2tick(delta, ticks, tempo)))
        message = "note_on" if kind else "note_off"
        track.append(mido.Message(message, note=pitch, velocity=velocity, time=tick_delta))
        previous = at
    track.append(mido.MetaMessage("end_of_track", time=0))
    path.parent.mkdir(parents=True, exist_ok=True)
    midi.save(str(path))


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"load", "save"}:
        print("Usage: midi_document.py <load|save> <midi-path>", file=sys.stderr)
        return 2
    action, path = sys.argv[1], Path(sys.argv[2])
    try:
        if action == "load":
            print(json.dumps(load_midi(path), ensure_ascii=False))
        else:
            save_midi(path, json.load(sys.stdin))
            print(json.dumps({"ok": True, "path": str(path.resolve())}))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
