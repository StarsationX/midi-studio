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
    programs: dict[int, int] = {}
    notes = []
    for msg in midi:
        time_sec += float(msg.time)
        if msg.type == "set_tempo" and not found_tempo:
            tempo = msg.tempo
            found_tempo = True
        elif msg.type == "program_change":
            programs.setdefault(int(msg.channel), int(msg.program))
        elif msg.type == "note_on" and msg.velocity > 0:
            active.setdefault((msg.channel, msg.note), []).append((time_sec, msg.velocity))
        elif msg.type in ("note_off", "note_on"):
            key = (msg.channel, msg.note)
            starts = active.get(key)
            if starts:
                start, velocity = starts.pop(0)
                notes.append({
                    "pitch": int(msg.note),
                    "start": round(start, 6),
                    "end": round(max(start + 0.01, time_sec), 6),
                    "velocity": int(velocity),
                    "channel": int(msg.channel),
                })
    # A note whose note_off is missing or truncated (common in transcriptions and
    # in files cut short) would otherwise be invisible in the editor and lost on
    # the next save. Close it at the end of the file instead of dropping it.
    for (channel, pitch), starts in active.items():
        for start, velocity in starts:
            notes.append({
                "pitch": int(pitch),
                "start": round(start, 6),
                "end": round(max(start + 0.01, time_sec), 6),
                "velocity": int(velocity),
                "channel": int(channel),
                "unterminated": True,
            })
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    for index, note in enumerate(notes, 1):
        note["id"] = f"n{index}"
    duration = max([float(midi.length)] + [n["end"] for n in notes])
    return {
        "path": str(path.resolve()),
        "name": path.stem,
        "bpm": round(mido.tempo2bpm(tempo), 3),
        "duration": round(duration, 6),
        "programs": programs,
        "notes": notes,
    }


def save_midi(path: Path, document: dict) -> None:
    bpm = max(20.0, min(400.0, float(document.get("bpm", 120))))
    ticks = 480
    tempo = mido.bpm2tempo(bpm)
    programs = document.get("programs") or {}
    events = []
    for note in document.get("notes", []):
        pitch = max(0, min(127, int(note.get("pitch", 60))))
        velocity = max(1, min(127, int(note.get("velocity", 96))))
        channel = max(0, min(15, int(note.get("channel", 0) or 0)))
        start = max(0.0, float(note.get("start", 0)))
        end = max(start + 0.01, float(note.get("end", start + 0.25)))
        events.append((start, 1, pitch, velocity, channel))
        events.append((end, 0, pitch, 0, channel))
    events.sort(key=lambda event: (event[0], event[1], event[2]))

    midi = mido.MidiFile(ticks_per_beat=ticks)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("track_name", name="MIDI Studio Review", time=0))
    track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    # Keep each channel on the instrument it was loaded with, so a drum or
    # multi-instrument file still sounds like itself after a round trip.
    for channel, program in sorted((int(c), int(p)) for c, p in programs.items()):
        if 0 <= channel <= 15 and 0 <= program <= 127:
            track.append(mido.Message("program_change", channel=channel, program=program, time=0))
    # Deltas are converted from absolute ticks. Rounding each delta on its own
    # against an absolute cursor let the error accumulate and dragged long files
    # progressively out of time.
    previous_tick = 0
    for at, kind, pitch, velocity, channel in events:
        tick = int(round(mido.second2tick(at, ticks, tempo)))
        message = "note_on" if kind else "note_off"
        track.append(mido.Message(message, note=pitch, velocity=velocity, channel=channel,
                                  time=max(0, tick - previous_tick)))
        previous_tick = tick
    track.append(mido.MetaMessage("end_of_track", time=0))
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write beside the target and swap in, so a crash mid-write can't leave the
    # user with a truncated MIDI where their song used to be.
    staging = path.with_name(path.name + ".saving")
    midi.save(str(staging))
    staging.replace(path)


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
