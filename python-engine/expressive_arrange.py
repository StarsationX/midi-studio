"""Arrange source-timed vocal, bass and harmony evidence for solo piano."""
from bisect import bisect_left, bisect_right
from collections import defaultdict
from itertools import combinations

import numpy as np
import pretty_midi
import soundfile as sf
import soxr
from scipy.ndimage import median_filter
from scipy.signal import find_peaks


def _runs(labels):
    edges = np.r_[0, np.flatnonzero(labels[1:] != labels[:-1]) + 1, len(labels)]
    return zip(edges[:-1], edges[1:])


def bass_notes(path):
    """Estimate bass fundamentals and use the separate envelope for attacks."""
    rate, hop, fft = 6000, 60, 4096
    with sf.SoundFile(path) as source:
        if not len(source):
            return []
        stream = soxr.ResampleStream(source.samplerate, rate, 1)
        chunks = []
        for block in source.blocks(blocksize=source.samplerate * 4, dtype="float32", always_2d=True):
            chunks.append(stream.resample_chunk(block.mean(axis=1), last=source.tell() == len(source)))
        mono = np.concatenate(chunks)
        del chunks
    if not len(mono):
        return []
    notes = []
    # Bounded spectra with enough overlap for centering, including at clip edges.
    context = 480
    padded = np.pad(mono, (context, context))
    pitches = np.arange(24, 61)
    frequencies = 440. * np.exp2((pitches - 69) / 12.)
    harmonics = frequencies[:, None] * np.arange(1, 7)[None, :]
    centers = np.rint(harmonics * fft / rate).astype(int)
    radii = np.maximum(1, np.rint(harmonics * .025 * fft / rate).astype(int))
    window = np.hanning(2 * context).astype(np.float32)
    frames = np.arange(0, len(mono), hop)
    density = []
    power = []
    envelope = []
    for chunk in np.array_split(frames, max(1, (len(frames) + 999) // 1000)):
        bounds = chunk[:, None] + np.arange(len(window))
        waveform = padded[bounds]
        spectrum = np.abs(np.fft.rfft(waveform * window, n=fft)).T
        strength = np.zeros((len(pitches), len(chunk)))
        for i, (bins, widths) in enumerate(zip(centers, radii)):
            for j, (center, width) in enumerate(zip(bins, widths), 1):
                peak = spectrum[center - width:center + width + 1].max(axis=0)
                shoulders = (spectrum[max(1, center - 2 * width - 1)] +
                             spectrum[center + 2 * width + 1]) * .5
                weight = 1.35 if j == 1 else j ** -.67
                strength[i] += weight * np.maximum(0, peak - .68 * shoulders)
        density.append(np.argmax(strength, axis=0))
        power.append(np.max(strength, axis=0))
        envelope.append(np.sqrt(np.mean(waveform[:, context - 100:context + 100] ** 2, axis=1)))

    energy = np.concatenate(envelope)
    # A short bass entrance can occupy much less than 6% of a quiet recording.
    reference = max(float(np.quantile(energy, .94)), float(energy.max()) * .12)
    if reference < .0005:
        return []
    signals = np.concatenate(power)
    dominant = pitches[median_filter(np.concatenate(density), size=7, mode="nearest")]
    dominant[(energy < reference * .055) | (signals < np.quantile(signals, .92) * .035)] = -1
    for a, b in _runs(dominant):
        if 0 < a and b < len(dominant) and b - a <= 4 and dominant[a - 1] == dominant[b]:
            dominant[a:b] = dominant[a - 1]

    # A bass player can pluck the same pitch repeatedly. The pitch label only
    # changes at a new pitch, so look for a deep valley followed by a new attack.
    smooth = median_filter(energy, size=3, mode="nearest")
    valleys, _ = find_peaks(-smooth, distance=9, prominence=reference * .035)
    for a, b in _runs(dominant):
        if dominant[a] < 0 or b - a < 9:
            continue
        pitch = int(dominant[a])
        cuts = [a]
        for valley in valleys[np.searchsorted(valleys, a + 8):np.searchsorted(valleys, b - 7)]:
            before = smooth[max(cuts[-1], valley - 28):valley].max()
            after = smooth[valley + 1:min(b, valley + 8)].max()
            if smooth[valley] > .40 * min(before, after) or after < .12 * reference:
                continue
            # A broad valley may begin well before the following pluck.
            rise = np.flatnonzero(smooth[valley:min(b, valley + 8)] >
                                  smooth[valley] + .25 * (after - smooth[valley]))
            if len(rise):
                attack = valley + int(rise[0])
                if attack - cuts[-1] >= 9 and b - attack >= 8:
                    cuts.append(attack)
        for start_frame, end_frame in zip(cuts, cuts[1:] + [b]):
            start = frames[start_frame] / rate
            end = min(len(mono) / rate, end_frame * hop / rate)
            level = float(np.quantile(energy[start_frame:end_frame], .8))
            # A pluck has transient noise before its fundamental settles. Only
            # recover an earlier attack if there was a real silence before it.
            last_end = notes[-1].end if notes else 0.
            if start - last_end >= .045:
                search = max(round(last_end * rate / hop), start_frame - 9)
                approach = smooth[search:start_frame + 1]
                if len(approach) >= 4 and approach[0] < .12 * level:
                    rise = np.flatnonzero(approach >= .30 * level)
                    if len(rise):
                        start = (search + rise[0]) * hop / rate
            velocity = round(51 + 19 * min(1., level / reference))
            notes.append(pretty_midi.Note(velocity, pitch, float(start), float(end)))
    return notes


def _group_attacks(notes, min_velocity=38):
    """Group chord attacks without counting neighboring harmony notes as strikes."""
    groups = []
    for note in sorted(notes, key=lambda n: n.start):
        if note.velocity < min_velocity or note.end - note.start < .08 or note.pitch < 45:
            continue
        if not groups or note.start - groups[-1][0].start > .055:
            groups.append([])
        groups[-1].append(note)
    return groups


def _fold(pitch, low, high):
    while pitch < low:
        pitch += 12
    while pitch > high:
        pitch -= 12
    return pitch


def _lead_notes(vocals, groups, duration, beat):
    lead = []
    vocal_starts = [note.start for note in vocals]
    for note in vocals:
        # Vocal note starts are already on the source clock. No snapping.
        pitch = _fold(note.pitch, 21, 108)
        lead.append(pretty_midi.Note(note.velocity, pitch, note.start, note.end))

    last_end = -1.
    for group in groups:
        start = group[0].start
        i = bisect_right(vocal_starts, start)
        previous = vocals[i - 1] if i else None
        upcoming = vocals[i].start if i < len(vocals) else duration
        # A breath between syllables is part of the sung phrase. Only use
        # transcribed instrumental attacks where there is room for a phrase.
        gap_start = previous.end if previous else 0.
        if vocals and (upcoming - gap_start < max(1.2, 2.5 * beat)
                       or (previous and start < gap_start + .24)
                       or (i < len(vocals) and upcoming - start < .24)):
            continue
        if start < last_end + .055:
            continue
        choices = [n for n in group if 57 <= n.pitch <= 88 and n.velocity >= 53
                   and n.end - n.start >= .12]
        if not choices:
            continue
        note = max(choices, key=lambda n: n.velocity + .38 * n.pitch)
        end = min(note.end, upcoming - .045)
        if end - note.start >= .10:
            lead.append(pretty_midi.Note(round(57 + .30 * note.velocity), note.pitch, note.start, end))
            last_end = end

    lead.sort(key=lambda n: n.start)
    phrase_time = 0.
    for index, note in enumerate(lead):
        previous = lead[index - 1] if index else None
        if previous is None or note.start - previous.end > .29:
            phrase_time = note.start
        next_start = lead[index + 1].start if index + 1 < len(lead) else duration
        phrase = min(1., (note.start - phrase_time) / .54)
        release = min(1., max(0., next_start - note.end) / .35)
        length = min(1., (note.end - note.start) / .35)
        note.velocity = int(np.clip(round(note.velocity - 2 + 4 * phrase + 3 * length - 3 * release), 1, 127))
    return lead


def _voicing(weights, bass, melody, prior):
    # Leave wider space above a deep bass; a third is clear higher up.
    floor = 43 if bass is None else bass + (7 if bass < 36 else 5 if bass < 43 else 3)
    ceiling = min(65, melody - 2) if melody is not None else 65
    if bass is not None:
        ceiling = min(ceiling, bass + 12)
    if floor > ceiling:
        return ()

    strongest = max(weights.values())
    classes = [pc for pc, weight in weights.items() if weight >= .42 * strongest
               and (bass is None or pc != bass % 12)]
    pitches = [p for p in range(floor, ceiling + 1) if p % 12 in classes]
    size = 2 if len(classes) >= 2 else 1
    voicings = [v for v in combinations(pitches, size)
                if v[-1] - v[0] <= 12 and (size == 1 or v[1] - v[0] >= (5 if v[0] < 45 else 3))
                and len({p % 12 for p in v}) == size]
    if not voicings:
        voicings = [(p,) for p in pitches]
    def score(voicing):
        evidence = sum(weights[p % 12] / strongest for p in voicing)
        # Prefer small steps and common tones. Only apply the third/seventh
        # preference when the backing itself also contains the bass pitch class.
        motion = sum(min((abs(p - old) for old in prior), default=abs(p - 53))
                     for p in voicing)
        character = sum((p - bass) % 12 in (3, 4, 10, 11) for p in voicing
                        if bass is not None and bass % 12 in weights)
        doubled_melody = any(melody is not None and p % 12 == melody % 12 for p in voicing)
        return evidence + .14 * character - .035 * motion - .16 * doubled_melody
    return max(voicings, key=score, default=())


def _backing(bass, backing, groups, lead, duration, beat):
    left_bass = []
    l_starts = [n.start for n in lead]
    for i, note in enumerate(bass):
        end = min(duration, note.end, bass[i + 1].start if i + 1 < len(bass) else duration)
        if end - note.start >= .075:
            lead_index = bisect_left(l_starts, note.start)
            concurrent = lead[max(0, lead_index - 1):bisect_left(l_starts, end)]
            ceiling = min((n.pitch - 2 for n in concurrent if n.end > note.start), default=60)
            pitch = _fold(note.pitch, 21, max(32, ceiling))
            left_bass.append(pretty_midi.Note(min(70, note.velocity), pitch, note.start, end))
    b_starts = [n.start for n in left_bass]
    ordered = sorted(backing, key=lambda n: n.start)
    active = []
    next_index = 0
    chords = []
    for group in groups:
        start = group[0].start
        sample = start + min(.075, beat / 6)
        active = [n for n in active if n.end > sample]
        while next_index < len(ordered) and ordered[next_index].start <= sample:
            note = ordered[next_index]
            if note.end > sample and note.velocity >= 37 and 45 <= note.pitch <= 78:
                active.append(note)
            next_index += 1

        weights = defaultdict(float)
        releases = {}
        for note in active + group:
            if 45 <= note.pitch <= 78:
                pc = note.pitch % 12
                weight = note.velocity / 100 * min(1., (note.end - note.start) / min(.28, beat * .6))
                weights[pc] = max(weights[pc], weight)
                releases[pc] = max(releases.get(pc, start), note.end)
        b_idx = bisect_right(b_starts, start + .035) - 1
        bass_pitch = left_bass[b_idx].pitch if b_idx >= 0 and left_bass[b_idx].end > start else None
        l_idx = bisect_left(l_starts, start)
        nearby = [n.pitch for n in lead[max(0, l_idx - 1):l_idx + 4]
                  if n.start < start + .32 and n.end > start]
        if len(weights) < 2:
            # The isolated bass can supply the second pitch of an exposed
            # dyad. A brief or melody-doubled backing pitch adds little.
            if bass_pitch is None or not any(
                45 <= n.pitch <= 78 and n.velocity >= 45 and n.end - n.start >= max(.22, .60 * beat)
                and n.pitch % 12 != bass_pitch % 12 and all(n.pitch % 12 != p % 12 for p in nearby)
                for n in group
            ):
                continue
        prior = tuple(chords[-1][1]) if chords else ()
        voiced = _voicing(weights, bass_pitch, min(nearby, default=None), prior)
        if not voiced:
            continue

        ends = {p: min(duration, releases[p % 12]) for p in voiced if releases[p % 12] > start + .08}
        if not ends:
            continue
        if chords:
            last_start, last_ends, _ = chords[-1]
            elapsed = start - last_start
            same = set(ends) == set(last_ends)
            fresh = {n.pitch % 12 for n in group if n.pitch <= 78}
            if same and start <= min(last_ends.values()) + .035 and (
                len(fresh) < 2 or elapsed < max(.25, beat * .8)
            ):
                for pitch in ends:
                    last_ends[pitch] = max(last_ends[pitch], ends[pitch])
                continue
            if elapsed < min(.24, max(.15, beat * .43)):
                continue
            if same and elapsed < max(.29, beat * .75):
                continue
        velocity = round(39 + 17 * min(1., max(weights.values())))
        chords.append((start, ends, velocity))

    notes = []
    for i, (start, ends, velocity) in enumerate(chords):
        end = min(max(ends.values()), chords[i + 1][0] if i + 1 < len(chords) else duration)
        before = bisect_left(b_starts, start)
        concurrent = [n for n in left_bass[max(0, before - 1):bisect_left(b_starts, end)]
                      if n.end > start]
        lead_index = bisect_left(l_starts, start)
        following = lead[max(0, lead_index - 1):bisect_left(l_starts, end)]
        for pitch, release in ends.items():
            # Common tones may ring over a repeated bass. Release a tone only
            # when the melody crosses it or the next bass exceeds hand reach.
            collision = [n.start for n in concurrent if not 2 <= pitch - n.pitch <= 12]
            collision += [n.start for n in following if n.end > start and n.pitch <= pitch + 1]
            stop = min([end, release] + collision)
            if stop - start >= .08:
                notes.append(pretty_midi.Note(velocity, pitch, start, stop))
    return sorted(left_bass + notes, key=lambda n: (n.start, n.pitch))


def arrange(vocals, backing, bass, duration, bpm):
    ordered_vocals = sorted(vocals, key=lambda n: n.start)
    groups = _group_attacks(backing)
    if bass is None:
        # The MDX separator has a pitched mix instead of an isolated bass stem.
        bass = []
        for note in sorted((n for n in backing if n.pitch < 48 and n.velocity >= 49),
                           key=lambda n: (n.start, n.pitch)):
            if bass and note.start - bass[-1].start < .095:
                continue
            bass.append(note)

    beat = 60. / bpm
    lead = _lead_notes(ordered_vocals, groups, duration, beat)
    left = _backing(sorted(bass, key=lambda n: n.start), backing, groups, lead, duration, beat)
    midi = pretty_midi.PrettyMIDI(initial_tempo=bpm, resolution=960)
    for name, notes in (("Right Hand - Melody", lead), ("Left Hand - Bass and Chords", left)):
        track = pretty_midi.Instrument(0, name=name)
        track.notes.extend(notes)
        midi.instruments.append(track)
    return midi
