"""Phase-by-phase breakdown of what midi_document.py load actually spends.

    python benchmarks/py-load-profile.py <midi> [--reps 3]

Prints ONE json object on stdout: every phase in ms, plus the parity check.

Why it is trustworthy: the instrumented copy of load_midi below is compared
field-for-field against the real python-engine/midi_document.load_midi output on
the same file, and the result carries `parity: true|false`. A breakdown that
does not reproduce the shipping loader's own output is not evidence, so if the
copy ever drifts from the original this file says so instead of lying.

Nothing here is imported by the app; it only measures it.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / "python-engine"
sys.path.insert(0, str(ENGINE))

C = time.perf_counter


def ms(a: float, b: float) -> float:
    return round((b - a) * 1000.0, 3)


def instrumented(path: Path) -> tuple[dict, dict]:
    """load_midi, phase by phase. Mirrors midi_document.load_midi exactly."""
    t = {}
    a = C()
    import mido  # noqa: PLC0415
    t["import_mido"] = ms(a, C())

    a = C()
    midi = mido.MidiFile(str(path))
    t["MidiFile_parse"] = ms(a, C())

    # mido's __iter__ merges the tracks and converts delta ticks to seconds.
    # Timed on its own so "reading the file" is separable from "building dicts".
    a = C()
    msgs = list(midi)
    t["iterate_merge_to_seconds"] = ms(a, C())

    a = C()
    time_sec = 0.0
    tempo = 500000
    found_tempo = False
    active: dict[tuple[int, int], list[tuple[float, int]]] = {}
    programs: dict[int, int] = {}
    notes = []
    for msg in msgs:
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
    for (channel, pitch), starts in active.items():
        for start, velocity in starts:
            notes.append({
                "pitch": int(pitch), "start": round(start, 6),
                "end": round(max(start + 0.01, time_sec), 6),
                "velocity": int(velocity), "channel": int(channel), "unterminated": True,
            })
    t["build_note_dicts"] = ms(a, C())

    a = C()
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    t["sort"] = ms(a, C())

    a = C()
    for index, note in enumerate(notes, 1):
        note["id"] = f"n{index}"
    t["assign_ids"] = ms(a, C())

    a = C()
    duration = max([float(midi.length)] + [n["end"] for n in notes])
    t["midi_length"] = ms(a, C())

    a = C()
    import midi_document  # noqa: PLC0415
    estimated = not found_tempo
    bpm = round(mido.tempo2bpm(tempo), 3)
    if estimated:
        bpm = midi_document._bpm_from_onsets([n["start"] for n in notes], bpm)
    t["bpm_from_onsets"] = ms(a, C())

    doc = {
        "path": str(path.resolve()), "name": path.stem, "bpm": bpm,
        "bpmEstimated": estimated, "duration": round(duration, 6),
        "programs": programs, "notes": notes,
    }

    a = C()
    payload = json.dumps(doc, ensure_ascii=False)
    t["json_dumps"] = ms(a, C())
    t["json_bytes"] = len(payload.encode("utf-8"))
    t["note_count"] = len(notes)
    return t, doc


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print("usage: py-load-profile.py <midi> [--reps N]", file=sys.stderr)
        return 2
    path = Path(argv[0])
    reps = 3
    if "--reps" in argv:
        reps = int(argv[argv.index("--reps") + 1])

    boot = os.environ.get("MS_PROFILE_T0")
    runs = []
    doc = None
    for _ in range(reps):
        t, doc = instrumented(path)
        runs.append(t)

    # Parity: the real shipping loader, same file, compared as JSON.
    import midi_document
    a = C()
    real = midi_document.load_midi(path)
    real_total = ms(a, C())
    parity = json.dumps(real, sort_keys=True) == json.dumps(doc, sort_keys=True)

    keys = [k for k in runs[0] if k not in ("json_bytes", "note_count")]
    agg = {}
    for k in keys:
        vals = sorted(r[k] for r in runs)
        agg[k] = {"mean": round(sum(vals) / len(vals), 3), "min": vals[0], "max": vals[-1]}
    out = {
        "file": str(path), "reps": reps, "parity": parity,
        "note_count": runs[0]["note_count"], "json_bytes": runs[0]["json_bytes"],
        "phases": agg,
        "real_load_midi_total_ms": real_total,
        "instrumented_total_ms": round(sum(agg[k]["mean"] for k in keys if k != "import_mido"), 3),
        "since_process_start_ms": round((time.time() - float(boot)) * 1000.0, 3) if boot else None,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
