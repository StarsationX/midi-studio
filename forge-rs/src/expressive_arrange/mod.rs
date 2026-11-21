//! Source-timed reduction for two piano hands. Harmony comes from observed
//! pitched attacks; the drum pulse only sets the editor grid and density.
mod bass;
mod harmony;
mod tempo;
pub use bass::bass_notes;
pub use harmony::harmony_notes;
pub use tempo::tempo_map;

use crate::pmidi::{Instrument, Note, PrettyMidi};

fn ordered(notes: &[Note], duration: f64) -> Vec<Note> {
    let mut result = notes.to_vec();
    order_in_place(&mut result, duration);
    result
}

fn order_in_place(notes: &mut Vec<Note>, duration: f64) {
    notes.retain_mut(|n| {
        n.end = n.end.min(duration);
        n.start.is_finite() && n.start >= 0. && n.end > n.start && n.velocity > 0
    });
    notes.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
}

fn groups(notes: &[Note]) -> Vec<Vec<Note>> {
    let mut result: Vec<Vec<Note>> = vec![];
    for &n in notes
        .iter()
        .filter(|n| n.velocity >= 38 && n.end - n.start >= 0.08 && n.pitch >= 45)
    {
        if let Some(last) = result.last_mut() {
            if n.start - last[0].start <= 0.055 {
                last.push(n);
                continue;
            }
        }
        result.push(vec![n]);
    }
    result
}

fn fold(pitch: u8, low: u8, high: u8) -> u8 {
    let mut key = i16::from(pitch);
    while key < i16::from(low) {
        key += 12;
    }
    while key > i16::from(high) {
        key -= 12;
    }
    key as u8
}

// Short backing notes are useful as a line, but a single isolated transient
// is poor evidence of melody. These limits are independent of chord voicing.
fn fill_candidate(n: &Note) -> bool {
    (53..=96).contains(&n.pitch) && n.velocity >= 45 && n.end - n.start >= 0.030
}

// A short lower-key repeat under an already sounding octave can come from
// the same instrumental tone. A coincident piano onset is independent
// evidence for striking the key again. All three lines are onset-sorted.
fn remove_octave_echoes(lead: &mut Vec<Note>, instrumental: &[Note], piano: &[Note], beat: f64) {
    let mut written = 0;
    let mut previous: Option<Note> = None;
    let window = (beat / 2.).clamp(0.12, 0.25);
    for i in 0..lead.len() {
        let n = lead[i];
        let repeat = previous.is_some_and(|p| p.pitch == n.pitch && n.start - p.end <= 0.055);
        previous = Some(n);
        if repeat {
            let start = instrumental.partition_point(|p| p.start < n.start - window);
            let upper = instrumental[start..].iter().take_while(|p| p.start < n.start - 0.035)
                .any(|p| p.pitch == n.pitch + 12 && fill_candidate(p) && p.end >= n.start - 0.012);
            if upper {
                let start = piano.partition_point(|p| p.start < n.start - 0.045);
                let confirmed = piano[start..].iter().take_while(|p| p.start <= n.start + 0.045)
                    .any(|p| p.pitch == n.pitch);
                if !confirmed {
                    let held = &mut lead[written - 1];
                    if n.start - held.end <= 0.012 {
                        held.end = held.end.max(n.end);
                    }
                    continue;
                }
            }
        }
        lead[written] = n;
        written += 1;
    }
    lead.truncate(written);
}

fn melody(vocals: &[Note], instrumental: &[Note], piano: &[Note], duration: f64, beat: f64) -> Vec<Note> {
    let mut backing = instrumental;
    let mut lead: Vec<Note> = Vec::new();
    let horizon = beat.clamp(0.30, 0.50);
    while let Some(first) = backing.first() {
        let start = first.start;
        let (group, remaining) = backing.split_at(backing.partition_point(|n| n.start <= start + 0.055));
        backing = remaining;
        let i = vocals.partition_point(|n| n.start <= start);
        let previous = i.checked_sub(1).map(|j| vocals[j].end);
        let upcoming = vocals.get(i).map_or(duration, |n| n.start);
        let room = upcoming - previous.unwrap_or(0.);
        if !vocals.is_empty()
            && (room < (2.5 * beat).max(1.2)
                || previous.is_some_and(|end| start < end + 0.24)
                || (i < vocals.len() && upcoming - start < 0.24))
        {
            continue;
        }
        let prior = lead.last().copied().filter(|n| {
            start - n.end <= 0.29 && previous.is_none_or(|vocal_end| n.start >= vocal_end)
        });
        let boundary = if i < vocals.len() { upcoming - 0.24 } else { duration };
        let future = &backing[..backing.partition_point(|n| n.start <= (start + horizon).min(boundary))];
        let old_line_continues = prior.is_some_and(|p| future.iter()
            .any(|f| fill_candidate(f) && f.pitch.abs_diff(p.pitch) <= 5));
        let best = group.iter().filter(|n| n.start < boundary && fill_candidate(n)).filter_map(|n| {
            let distance = prior.map(|p| p.pitch.abs_diff(n.pitch));
            let next = future.iter()
                .filter(|f| f.start - n.start >= 0.065 && fill_candidate(f))
                .map(|f| f.pitch.abs_diff(n.pitch)).min();
            let continues = next.is_some_and(|d| d <= 5);
            let established = prior.is_some_and(|p| p.pitch.abs_diff(n.pitch) <= 7 && n.start - p.start <= horizon);
            let independent = (57..=88).contains(&n.pitch) && n.velocity >= 53 && n.end - n.start >= 0.12;
            if !independent && !established && !continues {
                return None;
            }
            if prior.is_some_and(|p| n.start - p.start < 0.065 ||
                (n.start < p.end && p.pitch.abs_diff(n.pitch) > 7 && (!continues || old_line_continues))) {
                return None;
            }
            let score = f64::from(n.velocity) + 0.38 * f64::from(n.pitch)
                - 1.6 * f64::from(distance.unwrap_or(0).min(12))
                + f64::from(6 - next.unwrap_or(6).min(6));
            Some((score, n))
        }).max_by(|a, b| a.0.total_cmp(&b.0));
        if let Some((_, n)) = best {
            let end = n.end.min(if i < vocals.len() {
                upcoming - 0.045
            } else {
                duration
            });
            if end - n.start >= 0.030 {
                if prior.is_some_and(|p| p.end > n.start) {
                    lead.last_mut().unwrap().end = n.start;
                }
                lead.push(Note {
                    end,
                    ..*n
                });
            }
        }
    }
    // The polyphonic detector can split one decaying pitch into two adjacent
    // notes. Join only a fast, weaker continuation; preserve the first attack
    // and the full release. A gap, accent or different key stays articulated.
    let split_window = (beat / 3.).clamp(0.09, 0.16);
    lead.dedup_by(|next, held| {
        if next.pitch == held.pitch && next.start - held.start <= split_window
            && next.start - held.end <= 0.012 && held.velocity >= next.velocity.saturating_add(5)
        {
            held.end = held.end.max(next.end);
            true
        } else {
            false
        }
    });
    remove_octave_echoes(&mut lead, instrumental, piano, beat);
    for n in &mut lead {
        n.velocity = (57. + 0.30 * f64::from(n.velocity)).round() as u8;
    }
    lead.extend(vocals.iter().map(|n| Note { pitch: fold(n.pitch, 21, 108), ..*n }));
    lead.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut phrase_time = 0.;
    for i in 0..lead.len() {
        if i == 0 || lead[i].start - lead[i - 1].end > 0.29 {
            phrase_time = lead[i].start;
        }
        let next_start = lead.get(i + 1).map_or(duration, |n| n.start);
        let n = &mut lead[i];
        let phrase = ((n.start - phrase_time) / 0.54).min(1.);
        let release = ((next_start - n.end) / 0.35).clamp(0., 1.);
        let length = ((n.end - n.start) / 0.35).min(1.);
        n.velocity = (f64::from(n.velocity) - 2. + 4. * phrase + 3. * length - 3. * release)
            .round()
            .clamp(1., 127.) as u8;
    }
    lead
}

#[derive(Default)]
struct Chord {
    start: f64,
    notes: Vec<(u8, f64)>,
    velocity: u8,
}

fn voicing(
    weights: &[f64; 12],
    bass: Option<u8>,
    lead: Option<u8>,
    prior: &[(u8, f64)],
) -> Vec<u8> {
    let floor = bass.map_or(43, |p| {
        p + if p < 36 {
            7
        } else if p < 43 {
            5
        } else {
            3
        }
    });
    let ceiling = 65
        .min(lead.map_or(65, |p| p.saturating_sub(2)))
        .min(bass.map_or(65, |p| p + 12));
    let strongest = weights.iter().copied().fold(0., f64::max);
    if strongest == 0. {
        return vec![];
    }
    let playable: Vec<_> = (floor..=ceiling)
        .filter(|p| {
            weights[(p % 12) as usize] >= 0.42 * strongest && bass.is_none_or(|b| b % 12 != p % 12)
        })
        .collect();
    let score = |p: u8| {
        let motion = prior
            .iter()
            .map(|(old, _)| old.abs_diff(p))
            .min()
            .unwrap_or_else(|| p.abs_diff(53));
        let character = bass.is_some_and(|b| {
            weights[(b % 12) as usize] > 0. && matches!((p - b) % 12, 3 | 4 | 10 | 11)
        });
        weights[(p % 12) as usize] / strongest - 0.035 * f64::from(motion)
            + if character { 0.14 } else { 0. }
    };
    let doubled = |p: u8| lead.is_some_and(|n| n % 12 == p % 12);
    let mut best = vec![];
    let mut best_score = f64::NEG_INFINITY;
    for (i, &p) in playable.iter().enumerate() {
        for &q in &playable[i + 1..] {
            if q - p > 12 || q % 12 == p % 12 || q - p < if p < 45 { 5 } else { 3 } {
                continue;
            }
            let value = score(p) + score(q) - if doubled(p) || doubled(q) { 0.16 } else { 0. };
            if value > best_score {
                best = vec![p, q];
                best_score = value;
            }
        }
    }
    if best.is_empty() {
        for &p in &playable {
            let value = score(p) - if doubled(p) { 0.16 } else { 0. };
            if value > best_score {
                best = vec![p];
                best_score = value;
            }
        }
    }
    best
}

/// The monophonic outer voices are sorted by note-on when calling this helper.
fn overlapping(line: &[Note], start: f64, end: f64) -> impl Iterator<Item = &Note> {
    let first = line.partition_point(|n| n.start < start).saturating_sub(1);
    line[first..]
        .iter()
        .take_while(move |n| n.start < end)
        .filter(move |n| n.end > start)
}

fn left_hand(
    raw_bass: &[Note],
    backing: &[Note],
    attacks: &[Vec<Note>],
    lead: &[Note],
    duration: f64,
    beat: f64,
) -> Vec<Note> {
    let mut bass = vec![];
    for (i, &n) in raw_bass.iter().enumerate() {
        let end = n
            .end
            .min(raw_bass.get(i + 1).map_or(duration, |next| next.start));
        if end - n.start < 0.075 {
            continue;
        }
        let ceiling = overlapping(lead, n.start, end)
            .map(|n| n.pitch.saturating_sub(2))
            .min()
            .unwrap_or(60);
        let pitch = fold(n.pitch, 21, ceiling.max(32));
        if pitch <= ceiling {
            bass.push(Note {
                pitch,
                velocity: n.velocity.min(70),
                end,
                ..n
            });
        }
    }
    let mut active: Vec<&Note> = vec![];
    let mut next = 0;
    let mut chords: Vec<Chord> = vec![];
    for group in attacks {
        let start = group[0].start;
        let sample = start + 0.075f64.min(beat / 6.);
        active.retain(|n| n.end > sample);
        while next < backing.len() && backing[next].start <= sample {
            let n = &backing[next];
            if n.end > sample && n.velocity >= 37 && (45..=78).contains(&n.pitch) {
                active.push(n);
            }
            next += 1;
        }
        let mut weights = [0f64; 12];
        let mut releases = [0f64; 12];
        let mut fresh = [false; 12];
        for n in group.iter().filter(|n| n.pitch <= 78) {
            fresh[(n.pitch % 12) as usize] = true;
        }
        for n in active
            .iter()
            .copied()
            .chain(group.iter())
            .filter(|n| n.pitch <= 78)
        {
            let pc = (n.pitch % 12) as usize;
            let weight =
                f64::from(n.velocity) / 100. * ((n.end - n.start) / (0.6 * beat).min(0.28)).min(1.);
            weights[pc] = weights[pc].max(weight);
            releases[pc] = releases[pc].max(n.end);
        }
        let bass_key = bass
            .partition_point(|n| n.start <= start + 0.035)
            .checked_sub(1)
            .filter(|&i| bass[i].end > start)
            .map(|i| bass[i].pitch);
        let nearby: Vec<_> = overlapping(lead, start, start + 0.32)
            .map(|n| n.pitch)
            .collect();
        if weights.iter().filter(|&&w| w > 0.).count() < 2
            && !bass_key.is_some_and(|b| {
                group.iter().any(|n| {
                    n.pitch <= 78
                        && n.velocity >= 45
                        && n.end - n.start >= (0.60 * beat).max(0.22)
                        && n.pitch % 12 != b % 12
                        && !nearby.iter().any(|p| p % 12 == n.pitch % 12)
                })
            })
        {
            continue;
        }
        let prior = chords.last().map_or(&[][..], |c| c.notes.as_slice());
        let voiced = voicing(&weights, bass_key, nearby.iter().copied().min(), prior);
        let notes: Vec<_> = voiced
            .into_iter()
            .map(|p| (p, releases[(p % 12) as usize]))
            .filter(|(_, end)| *end - start >= 0.08)
            .collect();
        if notes.is_empty() {
            continue;
        }
        if let Some(last) = chords.last_mut() {
            let elapsed = start - last.start;
            let same = notes.iter().map(|x| x.0).eq(last.notes.iter().map(|x| x.0));
            if same
                && last.notes.iter().all(|x| start <= x.1 + 0.035)
                && (fresh.iter().filter(|&&attacked| attacked).count() < 2
                    || elapsed < (0.80 * beat).max(0.25))
            {
                for (old, new) in last.notes.iter_mut().zip(&notes) {
                    old.1 = old.1.max(new.1);
                }
                continue;
            }
            if elapsed < (0.43 * beat).clamp(0.15, 0.24)
                || (same && elapsed < (0.75 * beat).max(0.29))
            {
                continue;
            }
        }
        let strongest = weights.into_iter().fold(0., f64::max).min(1.);
        chords.push(Chord {
            start,
            notes,
            velocity: (39. + 17. * strongest).round() as u8,
        });
    }
    let mut harmony = vec![];
    for (i, chord) in chords.iter().enumerate() {
        let start = chord.start;
        let boundary = chords.get(i + 1).map_or(duration, |c| c.start);
        let shape_start = harmony.len();
        for &(pitch, release) in &chord.notes {
            let mut end = release.min(boundary);
            for n in overlapping(&bass, start, end) {
                if !(2..=12).contains(&pitch.saturating_sub(n.pitch)) {
                    end = end.min(n.start);
                }
            }
            for n in overlapping(lead, start, end) {
                if n.pitch <= pitch + 1 {
                    end = end.min(n.start);
                }
            }
            if end - start >= 0.08 {
                harmony.push(Note {
                    pitch,
                    velocity: chord.velocity,
                    start,
                    end,
                });
            }
        }
        // Leave the hand at the bass when a fleeting support shape would
        // require a second large jump almost immediately.
        let next_bass = bass.get(bass.partition_point(|n| n.start <= start));
        if let Some(next) = next_bass.filter(|n| n.start - start <= 0.120) {
            if harmony[shape_start..].iter().all(|n| {
                n.end - start <= 0.120 && n.pitch.abs_diff(next.pitch) > 12
            }) {
                harmony.truncate(shape_start);
            }
        }
    }
    bass.extend(harmony);
    ordered(&bass, duration)
}

pub fn arrange(
    vocals: &[Note],
    backing: &[Note],
    bass: Option<&[Note]>,
    duration: f64,
    tempos: &[(f64, f64)],
) -> PrettyMidi {
    arrange_with_harmony(vocals, backing, &[], bass, duration, tempos)
}

pub fn arrange_with_harmony(
    vocals: &[Note],
    backing: &[Note],
    harmonic_notes: &[Note],
    bass: Option<&[Note]>,
    duration: f64,
    tempos: &[(f64, f64)],
) -> PrettyMidi {
    arrange_with_instruments(vocals, backing, backing, harmonic_notes, bass, duration, tempos)
}

pub(crate) fn arrange_with_instruments(
    vocals: &[Note], instrumental: &[Note], backing: &[Note], harmonic_notes: &[Note],
    bass: Option<&[Note]>, duration: f64, tempos: &[(f64, f64)],
) -> PrettyMidi {
    let mut midi = PrettyMidi::with_tempo_map(960, tempos);
    let beat = midi.tick_scales[0].1 * f64::from(midi.resolution);
    let mut evidence = ordered(backing, duration);
    let lead = melody(&ordered(vocals, duration), &ordered(instrumental, duration), &evidence, duration, beat);
    let bass = match bass {
        Some(line) => ordered(line, duration),
        None => {
            let mut low: Vec<Note> = vec![];
            for &n in evidence.iter().filter(|n| n.pitch < 48 && n.velocity >= 49) {
                if low.last().is_none_or(|last| n.start - last.start >= 0.095) {
                    low.push(n);
                }
            }
            low
        }
    };
    // Left-hand evidence stays independent of the instrumental lead detector.
    if !harmonic_notes.is_empty() {
        evidence.extend_from_slice(harmonic_notes);
        order_in_place(&mut evidence, duration);
    }
    let left = left_hand(&bass, &evidence, &groups(&evidence), &lead, duration, beat);
    for (name, notes) in [
        ("Right Hand - Melody", lead),
        ("Left Hand - Bass and Chords", left),
    ] {
        let mut track = Instrument::new(0, false, name);
        track.notes = notes;
        midi.instruments.push(track);
    }
    midi
}

#[cfg(test)]
mod tests;
