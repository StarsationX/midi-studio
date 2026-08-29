"""Self-check for chord stagger, hand split, chord report and sheet export.
Run: python test_play_opts.py (from python-engine/)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mido
import midi_player as e


def fixture():
    m = mido.MidiFile()
    tr = mido.MidiTrack()
    m.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=500000))
    chord = [48, 50, 52, 53, 55, 57, 59, 60]
    for n in chord:
        tr.append(mido.Message("note_on", note=n, velocity=80, time=0))
    for i, n in enumerate(chord):
        tr.append(mido.Message("note_off", note=n, time=480 if i == 0 else 0))
    tr.append(mido.Message("note_on", note=72, velocity=80, time=480))
    tr.append(mido.Message("note_off", note=72, time=5))
    p = os.path.join(tempfile.gettempdir(), "midi-studio-test.mid")
    m.save(p)
    return p


def main():
    p = fixture()
    from pathlib import Path
    here = Path(__file__).resolve().parent
    _, ntk = e.load_mapping("virtualpiano", here)

    ev, un, tot, bpm, _ = e.parse_midi(p, ntk, 1.0)
    r = e.chord_report(ev)
    assert r["max_chord"] == 8 and r["big_chords"] == 1 and r["short_notes"] == 1, r

    ev2, *_ = e.parse_midi(p, ntk, 1.0, chord_stagger=0.005)
    ts = [round(x[0], 3) for x in ev2[:8]]
    assert ts == [round(i * 0.005, 3) for i in range(8)], ts
    assert [x[3] for x in ev2[:8]] == sorted(x[3] for x in ev2[:8]), "roll is low to high"

    evr, *_ = e.parse_midi(p, ntk, 1.0, hand="right")
    assert [x[3] for x in evr] == [60, 72], evr
    evl, *_ = e.parse_midi(p, ntk, 1.0, hand="left")
    assert len(evl) == 7 and all(x[3] < 60 for x in evl), evl

    sheet = e.events_to_sheet(ev, bpm)
    assert sheet.startswith("[") and "\n" in sheet, repr(sheet)
    assert ntk[72] in sheet, sheet
    print(sheet)
    print("engine ok")


if __name__ == "__main__":
    main()
