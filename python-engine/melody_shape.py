"""Turn a dense pitch transcription into a playable lead line.

Split out of melody_to_midi so it can be tested without loading basic-pitch or
torch: everything here is pure note maths over pretty_midi notes.

The target material is layered electronic music (artcore / Camellia-style):
~170-230 BPM with tempo changes inside one track, supersaw and orchestral
layers stacked in unison and at the octave, 16th/32nd arpeggios, and chord
stabs. Five things follow from that and drive this module:

  * a fixed 55 ms onset window merges 32nd notes at 200 BPM (37 ms) into one
    chord, so grouping and repeat-merging are derived from the tempo, and from
    the LOCAL tempo: these tracks change speed inside one song, and a single
    global figure is then wrong for most of it;
  * a machine-gun repeated note is the riff, not a transcription artefact. It
    has to survive the pass that stitches split notes back together, or the
    whole figure collapses into one held note;
  * unison/octave layering makes the transcriber emit the same note twice an
    octave apart, and a supersaw stack adds the fifth on top of that, so
    harmonic ghosts are removed explicitly;
  * thinning a fill by "keep the loudest" scatters the survivors off the beat.
    Thinning on the metrical grid keeps the shape of the run instead;
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


def _median(values):
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


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
    # The median gap is a subdivision of the beat; assume the densest common
    # subdivision is a 16th, which is what fast electronic leads are written in.
    bpm = 60.0 / (_median(gaps) * 4.0)
    while bpm < 90.0:
        bpm *= 2.0
    while bpm > 250.0:
        bpm /= 2.0
    return round(bpm, 2)


class TempoMap:
    """The local note spacing, second by second.

    One BPM for a whole track is wrong for this material: a Camellia track will
    open at 90, sit at 174 for two minutes, halve into a breakdown and finish at
    220, and every window derived from a single average is then too wide in the
    fast parts and too narrow in the slow ones. This measures the actual gap
    between onsets around each moment instead.
    """

    BUCKET = 1.0        # seconds per measurement
    SPAN = 2            # buckets either side folded into each measurement

    def __init__(self, notes, fallback_step):
        self.fallback = fallback_step
        self.gaps_by_bucket = {}
        starts = sorted({round(float(n.start), 4) for n in notes})
        for a, b in zip(starts, starts[1:]):
            gap = b - a
            if 0.015 <= gap <= 1.0:
                self.gaps_by_bucket.setdefault(int(a // self.BUCKET), []).append(gap)
        self._cache = {}

    def step_at(self, time):
        """Shortest musically meaningful step around `time`, in seconds.

        This is the grid the notes here are actually landing on, so it is what
        "two notes are the same event" and "two notes are a deliberate repeat"
        get measured against.
        """
        bucket = int(max(0.0, time) // self.BUCKET)
        if bucket in self._cache:
            return self._cache[bucket]
        pool = []
        for offset in range(-self.SPAN, self.SPAN + 1):
            pool.extend(self.gaps_by_bucket.get(bucket + offset, ()))
        # Too little to measure locally: the whole-track figure is a better
        # guess than a number derived from three gaps.
        step = _median(pool) if len(pool) >= 5 else self.fallback
        step = min(0.5, max(0.015, step))
        self._cache[bucket] = step
        return step


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


# Intervals a single sounding note produces in a transcriber, and how sure we
# have to be before calling one a ghost rather than a note someone played.
# The octave is safe to remove on sight. The fifth is not: parallel fifths are
# rare but real, and a supersaw's fifth partial is always the quieter of the
# pair and always exactly simultaneous, so it is held to both tests.
_GHOST_INTERVALS = {
    12: (0.6, 1.00),    # semitones: (minimum overlap, maximum velocity ratio)
    24: (0.6, 1.00),
    7:  (0.85, 0.80),
    19: (0.85, 0.80),
}


def drop_harmonic_ghosts(notes, strict_fifths=True):
    """Remove the partial a layered synth adds above the note that caused it.

    Layered synths and doubled strings make the transcriber report both the
    fundamental and its octave. Keeping both turns a single melodic line into
    parallel octaves that no one played. A supersaw stack goes further and puts
    a fifth in there too, which is where the parallel-fifth artefacts in dense
    electronic transcriptions come from.
    """
    ordered = sorted(notes, key=lambda n: (-n.velocity, n.start))
    kept = []
    for note in ordered:
        ghost = False
        for other in kept:
            interval = abs(note.pitch - other.pitch)
            rule = _GHOST_INTERVALS.get(interval)
            if rule is None:
                continue
            if interval in (7, 19) and not strict_fifths:
                continue
            min_overlap, max_ratio = rule
            if _overlap(note, other) < min_overlap:
                continue
            # `kept` is walked loudest first, so `other` is the stronger note.
            if other.velocity and note.velocity / other.velocity > max_ratio:
                continue
            ghost = True
            break
        if not ghost:
            kept.append(note)
    return sorted(kept, key=lambda n: (n.start, n.pitch))


# The old name, kept because it says what it does for the octave case.
drop_octave_ghosts = drop_harmonic_ghosts


def group_onsets(notes, tempo_map):
    """Collect notes struck at the same moment, at the local tempo.

    The window is a fraction of the local step, so a 32nd run does not get
    swept into one chord and a slow passage still groups a spread chord.
    """
    groups, current, start = [], [], None
    for note in sorted(notes, key=lambda n: (n.start, -n.velocity, -n.pitch)):
        window = min(0.055, max(0.012, tempo_map.step_at(note.start) * 0.45))
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


def _step_cost(previous, note):
    """Contour penalty between consecutive lead notes.

    A leap is unmusical, except the octave leap, which these leads do all the
    time, so +/-12 is charged like a small step rather than a 12-semitone jump.

    A jump in loudness is charged too. Pitch alone cannot tell the lead from an
    inner voice that happens to sit nearby, but a lead holds a roughly steady
    level while the layer underneath it does not, so this is a cheap stand-in
    for "stay on the same instrument".
    """
    if previous is None:
        return 0.0
    distance = abs(note.pitch - previous.pitch)
    if distance in (12, 24):
        distance = 3
    contour = min(1.0, distance / 15.0)
    dynamics = min(1.0, abs(note.velocity - previous.velocity) / 64.0)
    return contour + dynamics * 0.35


def lead_line(groups, low, high, smoothness=0.55):
    """One note per onset group, chosen by dynamic programming over the song.

    Maximises total salience minus contour cost, so a quiet note that keeps the
    line intact can beat a louder note from an unrelated layer.
    """
    if not groups:
        return []
    best = [{}, ]
    previous_layer = {}
    for group in groups:
        layer = {}
        for note in group:
            score = salience(note, low, high)
            if not previous_layer:
                layer[id(note)] = (score, note, None)
                continue
            candidate = None
            for prior_score, prior_note, _ in previous_layer.values():
                total = prior_score + score - smoothness * _step_cost(prior_note, note)
                if candidate is None or total > candidate[0]:
                    candidate = (total, note, prior_note)
            layer[id(note)] = candidate
        previous_layer = layer
        best.append(layer)

    # Walk back from the best final state.
    line = []
    layer = previous_layer
    chosen = max(layer.values(), key=lambda item: item[0]) if layer else None
    for _group in reversed(groups):
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


def merge_repeats(notes, tempo_map):
    """Stitch a note the transcriber split in two back together.

    The thing this must NOT do is merge a deliberate repeat. A lead that fires
    the same pitch on every 32nd is the whole riff, and the gaps inside it are
    smaller than the gaps inside a split note, so a plain "close enough, join
    them" rule turned the entire figure into one held note.

    Two same-pitch notes are one note only if the second starts before the next
    grid position, i.e. the split happened inside a step. Anything landing on
    its own step is a re-articulation and is left alone.
    """
    out = []
    for note in sorted(notes, key=lambda n: (n.start, n.pitch)):
        if out and out[-1].pitch == note.pitch:
            step = tempo_map.step_at(note.start)
            gap = note.start - out[-1].end
            within_step = note.start - out[-1].start < step * 0.75
            if within_step and gap <= step * 0.75:
                out[-1].end = max(out[-1].end, note.end)
                out[-1].velocity = max(out[-1].velocity, note.velocity)
                continue
        out.append(clone(note))
    return out


def _metrical_weight(index):
    """How strong the beat is that this grid position falls on.

    Counting in 32nds from the first onset: every 8th index is a quarter note,
    every 4th an 8th, every 2nd a 16th, the rest are 32nds. Rank them that way
    and thinning a run keeps its skeleton rather than a random handful.
    """
    if index % 8 == 0:
        return 3
    if index % 4 == 0:
        return 2
    if index % 2 == 0:
        return 1
    return 0


def limit_density(notes, notes_per_second, tempo_map=None, window=1.0):
    """Thin the busiest passages so a human (or a key-press player) can follow.

    Camellia-style fills hit 30+ notes a second; a piano-game player tops out far
    below that, and the extra notes read as noise either way.

    Which notes survive matters as much as how many. Keeping the loudest scatters
    them off the beat and a 32nd run comes back as an arrhythmic handful, so the
    survivors are chosen by metrical position first and loudness only to break
    ties. What is left is the run's skeleton, which is what a person would play
    if you asked them for the simple version.
    """
    if not notes_per_second or notes_per_second <= 0:
        return notes
    ordered = sorted(notes, key=lambda n: n.start)
    if not ordered:
        return notes
    budget = max(1, int(round(notes_per_second * window)))
    origin = ordered[0].start

    def rank(note):
        if tempo_map is None:
            return (0, note.velocity)
        step = tempo_map.step_at(note.start)
        index = int(round((note.start - origin) / step)) if step > 0 else 0
        return (_metrical_weight(index), note.velocity)

    kept, bucket, bucket_start = [], [], None

    def flush():
        if not bucket:
            return
        bucket.sort(key=lambda n: (-rank(n)[0], -rank(n)[1], n.start))
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
          high=DEFAULT_MAX_PITCH, fold=True, density=0.0, max_sustain_beats=8.0,
          strict_fifths=True):
    """Full chain: range -> ghosts -> grouping -> lead line -> extras -> tidy."""
    beat = 60.0 / max(20.0, bpm)
    fallback_step = beat / 4.0                      # a 16th at the global tempo

    notes = fold_into_range(raw_notes, low, high, fold)
    notes = [n for n in notes if n.end - n.start >= min_duration]
    # Very long quiet notes are pads and strings holding under the lead.
    notes = [n for n in notes
             if (n.end - n.start) <= max_sustain_beats * beat or n.velocity >= 90]
    if not notes:
        return []

    tempo_map = TempoMap(notes, fallback_step)
    notes = drop_harmonic_ghosts(notes, strict_fifths=strict_fifths)
    groups = group_onsets(notes, tempo_map)

    line = lead_line(groups, low, high)
    chosen = {id(n) for n in line}
    selected = [clone(n) for n in line]

    if polyphony > 1:
        for group in groups:
            extras = [n for n in group if id(n) not in chosen]
            extras.sort(key=lambda n: salience(n, low, high), reverse=True)
            selected.extend(clone(n) for n in extras[:polyphony - 1])

    merged = merge_repeats(selected, tempo_map)
    if polyphony == 1:
        for previous, current in zip(merged, merged[1:]):
            if previous.end > current.start:
                previous.end = max(previous.start + 0.02, current.start)
    merged = [n for n in merged if n.end - n.start >= 0.02]
    return limit_density(merged, density, tempo_map)


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

    # A machine-gun repeated note is the riff. It used to come back as one held
    # note, because the gaps inside it are smaller than the merge window.
    rep_bpm = 200.0
    thirty_second = 60.0 / rep_bpm / 8.0
    repeats = [note(76, i * thirty_second, thirty_second * 0.85, 100) for i in range(16)]
    kept = shape(repeats, polyphony=1, min_duration=0.01, bpm=rep_bpm)
    assert len(kept) >= 14, f"repeated-note riff collapsed to {len(kept)} notes"

    # A note the transcriber split in two is still stitched back together.
    split = [note(60, 0.0, 0.020, 100), note(60, 0.022, 0.020, 100)]
    tempo_map = TempoMap(split, 0.075)
    assert len(merge_repeats(split, tempo_map)) == 1, "split note was not rejoined"

    # Thinning keeps the beat, not just the loudest. A run where the off-beats
    # are loudest must still come back on the beat.
    grid = 0.05
    run = [note(60 + (i % 5), i * grid, grid * 0.9, 127 if i % 2 else 70) for i in range(40)]
    tempo_map = TempoMap(run, grid)
    thinned = limit_density(run, 5, tempo_map)
    on_grid = sum(1 for n in thinned if round((n.start / grid)) % 2 == 0)
    assert on_grid > len(thinned) / 2, \
        f"thinning ignored the beat: {on_grid} of {len(thinned)} on strong positions"

    # Density limiting respects the cap.
    dense = [note(60 + (i % 12), i * 0.02, 0.02, 60 + (i % 40)) for i in range(100)]
    assert len(limit_density(dense, 10)) <= 25, "density cap not applied"

    # Ghost removal keeps the stronger of an octave pair...
    pair = [note(60, 0, 0.5, 80), note(72, 0, 0.5, 120)]
    assert [n.pitch for n in drop_harmonic_ghosts(pair)] == [72]
    # ...and drops the quiet simultaneous fifth a supersaw stack adds.
    stack = [note(60, 0, 0.5, 120), note(67, 0, 0.5, 70)]
    assert [n.pitch for n in drop_harmonic_ghosts(stack)] == [60], "supersaw fifth survived"
    # A fifth that is played, not a partial, stays: it is as loud as its pair.
    played = [note(60, 0, 0.5, 110), note(67, 0, 0.5, 108)]
    assert len(drop_harmonic_ghosts(played)) == 2, "a real fifth was removed"

    # The local tempo tracks a track that changes speed halfway through.
    slow = [note(60, i * 0.5, 0.4) for i in range(8)]
    fast = [note(60, 4.0 + i * 0.05, 0.04) for i in range(80)]
    tempo_map = TempoMap(slow + fast, 0.1)
    assert tempo_map.step_at(1.0) > tempo_map.step_at(6.0) * 3, \
        f"tempo map is flat: {tempo_map.step_at(1.0)} vs {tempo_map.step_at(6.0)}"

    # Folding brings an out-of-range hook back instead of deleting it.
    folded = fold_into_range([note(108, 0, 0.2)], 45, 100, True)
    assert folded and folded[0].pitch == 96

    print("melody_shape demo: OK")


if __name__ == "__main__":
    demo()
