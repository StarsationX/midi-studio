#!/usr/bin/env python3
"""Generate benchmarks/fixtures/player-dense.mid: a REALISTIC stress fixture
for player dispatch timing.

The existing fixtures are uniform 24 notes/s single voices. Real playback jitter
appears where a chord dumps 4-8 keypresses into the same millisecond and where a
16th-note run leaves <60ms between wake-ups, so a uniform fixture measures the
easy case and hides exactly what users hear.

Layout (150 BPM, 40 s):
  * a 16th-note right-hand run          -> 10 note-on/s, ~100 ms gaps
  * 4-note left-hand chords on beats     -> 4 presses inside one ms
  * one 8-note chord every 4 bars        -> past 6-key rollover, the worst case
  * two bars of 32nds every 8 bars       -> 20 note-on/s, ~50 ms gaps
Plus an offset 16th middle voice so two streams interleave.
"""
import sys
from pathlib import Path
import mido

BPM = 150.0
BEAT = 60.0 / BPM
TPB = 480
SECONDS = 40.0


def build():
    mid = mido.MidiFile(ticks_per_beat=TPB)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(BPM), time=0))

    ev = []  # (abs_beats, 'on'/'off', note, vel)

    def add(beat, note, dur_beats, vel=80):
        ev.append((beat, 1, note, vel))
        ev.append((beat + dur_beats, 0, note, 0))

    scale = [0, 2, 4, 5, 7, 9, 11]
    total_beats = SECONDS / BEAT
    bar = 0.0
    idx = 0
    while bar < total_beats:
        bar_i = int(bar // 4)
        # right hand 16ths
        step = 0.25
        thirtyseconds = (bar_i % 8) in (6, 7)
        if thirtyseconds:
            step = 0.125
        b = bar
        while b < bar + 4 and b < total_beats:
            deg = scale[idx % len(scale)]
            oct_ = 60 + 12 * ((idx // len(scale)) % 2)
            add(b, oct_ + deg, step * 0.9, 84)
            idx += 1
            b += step
        # middle voice: offset 16th arpeggio, so two independent streams
        # interleave and most wake-ups land <60 ms apart
        b = bar + 0.125
        while b < bar + 4 and b < total_beats:
            deg = scale[(idx * 3) % len(scale)]
            add(b, 48 + deg, 0.2, 70)
            idx += 1
            b += 0.25
        # left hand chords on each beat
        for k in range(4):
            root = 36 + scale[(bar_i + k) % len(scale)]
            if (bar_i % 4) == 3 and k == 0:
                # the wide chord: 8 simultaneous keys, past 6-key rollover
                notes = [root, root + 4, root + 7, root + 11,
                         root + 12, root + 16, root + 19, root + 23]
            else:
                notes = [root, root + 4, root + 7, root + 12]
            for n in notes:
                add(bar + k, n, 0.9, 72)
        bar += 4

    ev.sort(key=lambda e: (e[0], e[1]))
    prev = 0.0
    for beat, kind, note, vel in ev:
        dt = int(round((beat - prev) * TPB))
        prev = beat
        tr.append(mido.Message("note_on" if kind else "note_off",
                               note=note, velocity=vel, time=max(0, dt)))
    return mid


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        Path(__file__).resolve().parent / "fixtures" / "player-dense.mid"
    out.parent.mkdir(parents=True, exist_ok=True)
    m = build()
    m.save(str(out))
    m2 = mido.MidiFile(str(out))
    ons = [x for x in m2 if x.type == "note_on" and x.velocity > 0]
    print(f"wrote {out}  len={m2.length:.1f}s  note_ons={len(ons)}  "
          f"mean={len(ons)/max(m2.length,0.001):.1f}/s")
