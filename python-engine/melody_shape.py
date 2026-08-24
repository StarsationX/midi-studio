"""Turn a dense pitch transcription into a playable lead line.

Split out of melody_to_midi so it can be tested without loading basic-pitch or
torch: everything here is pure note maths over pretty_midi notes.

The target material is layered electronic music (artcore / Camellia-style):
~170-230 BPM with tempo changes inside one track, supersaw and orchestral
layers stacked in unison and at the octave, 16th/32nd arpeggios, and chord
stabs. Three things follow from that and drive this module:

  * a fixed 55 ms onset window merges 32nd notes at 200 BPM (37 ms) into one
    chord, so grouping and repeat-merging are derived from the detected tempo;
  * unison/octave layering makes the transcriber emit the same note twice an
    octave apart, and the louder copy is often the harmonic, not the
    fundamental, so octave ghosts are removed explicitly;
  * picking the loudest note in each onset group greedily jumps between the
    lead, a pad and an inner chord voice. A short dynamic program over the whole
    song picks the line that is both salient and continuous, which is the usual
    "salience + contour tracking" shape from the melody-extraction literature.
"""
from __future__ import annotations

import pretty_midi

DEFAULT_MIN_PITCH = 45
DEFAULT_MAX_PITCH = 100


def clone(note) -> pretty_midi.Note:
    return pretty_midi.Note(velocity=int(note.velocity), pitch=int(note.pitch),
                            start=float(note.start), end=float(note.end))


def estimate_bpm(notes, fallback=120.0) -> float:
    """BPM from the spacing between onsets.

    Histogram of inter-onset gaps, folded into one octave of tempo (so a run of
    16ths and a run of 8ths vote for the same beat), then scaled into a musical
    range. Deliberately crude: it only has to be close enough that a "16th note"
    is the right order of magnitude.
    """
    starts = sorted({round(float(n.start), 4) for n in notes})
    gaps = [b - a for a, b in zip(starts, starts[1:]) if 0.02 <= b - a <= 2.0]
    if len(gaps) < 6:
        return fallback
    gaps.sort()
    # The median gap is a subdivision of the beat; assume the densest common
    # subdivision is a 16th, which is what fast electronic leads are written in.
    median = gaps[len(gaps) // 2]
    bpm = 60.0 / (median * 4.0)
    while bpm < 90.0:
        bpm *= 2.0
    while bpm > 250.0:
        bpm /= 2.0
    return round(bpm, 2)


def fold_into_range(notes, low=DEFAULT_MIN_PITCH, high=DEFAULT_MAX_PITCH, fold=True):
    """Octave-shift out-of-range notes instead of deleting them.

    A lead that climbs past the top of the range is the hook; dropping it leaves
    a hole in the middle of the song.
    """
    out = []
    for note in notes:
        pitch = int(note.pitch)
        if fold:
            while pitch > high:
                pitch -= 12
            while pitch < low:
                pitch += 12
        if not (low <= pitch <= high):
            continue
        copy = clone(note)
        copy.pitch = pitch
        out.append(copy)
    return out


def _overlap(a, b) -> float:
    span = min(a.end, b.end) - max(a.start, b.start)
    shortest = min(a.end - a.start, b.end - b.start)
    return span / shortest if shortest > 0 else 0.0


def drop_octave_ghosts(notes, min_overlap=0.6):
    """Remove the duplicate an octave away from a simultaneous stronger note.

    Layered synths and doubled strings make the transcriber report both the
    fundamental and its octave. Keeping both turns a single melodic line into
    parallel octaves that no one played.
    """
    ordered = sorted(notes, key=lambda n: (-n.velocity, n.start))
    kept = []
    for note in ordered:
        ghost = False
        for other in kept:
            if abs(note.pitch - other.pitch) in (12, 24) and _overlap(note, other) >= min_overlap:
                ghost = True
                break
        if not ghost:
            kept.append(note)
    return sorted(kept, key=lambda n: (n.start, n.pitch))


def group_onsets(notes, window):
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


def salience(note, low, high) -> float:
    velocity = note.velocity / 127.0
    duration = min(1.0, max(0.0, note.end - note.start) / 0.45)
    register = (note.pitch - low) / max(1, high - low)
    return velocity * 0.55 + duration * 0.20 + register * 0.25


def _step_cost(previous_pitch, pitch):
    """Contour penalty between consecutive lead notes.

    A leap is unmusical, except the octave leap, which these leads do all the
    time, so ±12 is charged like a small step rather than a 12-semitone jump.
    """
    if previous_pitch is None:
        return 0.0
    distance = abs(pitch - previous_pitch)
    if distance in (12, 24):
        distance = 3
    return min(1.0, distance / 15.0)


def lead_line(groups, low, high, smoothness=0.55):
    """One note per onset group, chosen by dynamic programming over the song.

    Maximises total salience minus contour cost, so a quiet note that keeps the
    line intact can beat a louder note from an unrelated layer.
    """
    if not groups:
        return []
    best = [{}, ]
    previous_layer = {}
    for index, group in enumerate(groups):
        layer = {}
        for note in group:
            score = salience(note, low, high)
            if not previous_layer:
                layer[id(note)] = (score, note, None)
                continue
            candidate = None
            for prior_score, prior_note, _ in previous_layer.values():
                total = prior_score + score - smoothness * _step_cost(prior_note.pitch, note.pitch)
                if candidate is None or total > candidate[0]:
                    candidate = (total, note, prior_note)
            layer[id(note)] = candidate
        previous_layer = layer
        best.append(layer)

    # Walk back from the best final state.
    line = []
    layer = previous_layer
    chosen = max(layer.values(), key=lambda item: item[0]) if layer else None
    for group in reversed(groups):
        if chosen is None:
            break
        line.append(chosen[1])
        parent = chosen[2]
        if parent is None:
            break
        # find the parent's entry in the previous layer
        chosen = None
        for candidate in best[len(groups) - len(line)].values():
            if candidate[1] is parent:
                chosen = candidate
                break
    return list(reversed(line))


def merge_repeats(notes, max_gap):
    out = []
    for note in sorted(notes, key=lambda n: (n.start, n.pitch)):
        if out and out[-1].pitch == note.pitch and note.start - out[-1].end <= max_gap:
            out[-1].end = max(out[-1].end, note.end)
            out[-1].velocity = max(out[-1].velocity, note.velocity)
        else:
            out.append(clone(note))
    return out


def limit_density(notes, notes_per_second, window=1.0):
    """Thin the busiest passages so a human (or a key-press player) can follow.

    Camellia-style fills hit 30+ notes a second; a piano-game player tops out far
    below that, and the extra notes read as noise either way. The loudest notes
    in each window survive.
    """
    if not notes_per_second or notes_per_second <= 0:
        return notes
    ordered = sorted(notes, key=lambda n: n.start)
    budget = max(1, int(round(notes_per_second * window)))
    kept, bucket, bucket_start = [], [], None
    def flush():
        if not bucket:
            return
        bucket.sort(key=lambda n: (-n.velocity, n.start))
        kept.extend(bucket[:budget])
    for note in ordered:
        if bucket_start is None:
            bucket_start = note.start
        if note.start - bucket_start > window:
            flush()
            bucket, bucket_start = [], note.start
        bucket.append(note)
    flush()
    return sorted(kept, key=lambda n: (n.start, n.pitch))


def shape(raw_notes, *, polyphony, min_duration, bpm, low=DEFAULT_MIN_PITCH,
          high=DEFAULT_MAX_PITCH, fold=True, density=0.0, max_sustain_beats=8.0):
    """Full chain: range -> ghosts -> grouping -> lead line -> extras -> tidy."""
    beat = 60.0 / max(20.0, bpm)
    sixteenth = beat / 4.0
    window = min(0.055, max(0.018, sixteenth * 0.45))
    merge_gap = min(0.075, max(0.012, sixteenth * 0.35))

    notes = fold_into_range(raw_notes, low, high, fold)
    notes = [n for n in notes if n.end - n.start >= min_duration]
    # Very long quiet notes are pads and strings holding under the lead.
    notes = [n for n in notes
             if (n.end - n.start) <= max_sustain_beats * beat or n.velocity >= 90]
    if not notes:
        return []
    notes = drop_octave_ghosts(notes)
    groups = group_onsets(notes, window)

    line = lead_line(groups, low, high)
    chosen = {id(n) for n in line}
    selected = [clone(n) for n in line]

    if polyphony > 1:
        for group in groups:
            extras = [n for n in group if id(n) not in chosen]
            extras.sort(key=lambda n: salience(n, low, high), reverse=True)
            selected.extend(clone(n) for n in extras[:polyphony - 1])

    merged = merge_repeats(selected, merge_gap)
    if polyphony == 1:
        for previous, current in zip(merged, merged[1:]):
            if previous.end > current.start:
                previous.end = max(previous.start + 0.02, current.start)
    merged = [n for n in merged if n.end - n.start >= 0.02]
    return limit_density(merged, density)


def demo():
    """Self-check: a lead line buried under octave layers, a pad and chord stabs."""
    def note(pitch, start, length=0.12, velocity=100):
        return pretty_midi.Note(velocity=velocity, pitch=pitch, start=start, end=start + length)

    bpm = 200.0
    step = 60.0 / bpm / 4.0            # a 16th at 200 BPM = 75 ms
    melody = [72, 74, 76, 79, 76, 74, 72, 67] * 3
    raw = []
    for index, pitch in enumerate(melody):
        at = index * step
        raw.append(note(pitch, at, step * 0.9, 104))          # the lead
        raw.append(note(pitch + 12, at, step * 0.9, 112))     # louder octave layer
        raw.append(note(pitch - 12, at, step * 0.9, 88))      # sub layer
        raw.append(note(pitch - 5, at, step * 0.9, 70))       # inner chord voice
    raw.append(note(48, 0.0, len(melody) * step, 55))         # sustained pad

    detected = estimate_bpm(raw)
    assert 150 <= detected <= 250, f"bpm estimate off: {detected}"

    clean = shape(raw, polyphony=1, min_duration=0.03, bpm=bpm)
    pitches = [n.pitch for n in clean]
    assert pitches, "clean candidate came back empty"
    # One note per 16th, no octave doubling, and the pad is gone.
    assert len(clean) == len(melody), f"expected {len(melody)} notes, got {len(clean)}"
    assert all(abs(a - b) % 12 == 0 for a, b in zip(pitches, melody)), \
        f"line does not follow the melody: {pitches} vs {melody}"
    assert len({p % 12 for p in pitches} - {m % 12 for m in melody}) == 0
    for previous, current in zip(clean, clean[1:]):
        assert previous.end <= current.start + 1e-6, "clean candidate must be monophonic"

    # Density limiting keeps the loudest notes and respects the cap.
    dense = [note(60 + (i % 12), i * 0.02, 0.02, 60 + (i % 40)) for i in range(100)]
    thinned = limit_density(dense, 10)
    assert len(thinned) <= 25, f"density cap not applied: {len(thinned)}"

    # Ghost removal keeps the stronger of an octave pair.
    pair = [note(60, 0, 0.5, 80), note(72, 0, 0.5, 120)]
    assert [n.pitch for n in drop_octave_ghosts(pair)] == [72]

    # Folding brings an out-of-range hook back instead of deleting it.
    folded = fold_into_range([note(108, 0, 0.2)], 45, 100, True)
    assert folded and folded[0].pitch == 96

    print("melody_shape demo: OK")


if __name__ == "__main__":
    demo()
