//! Source-timed reduction for two piano hands. Harmony comes from observed
//! pitched attacks; the drum pulse only sets the editor grid and density.
mod bass;
mod harmony;
mod piano;
mod tempo;
pub use bass::bass_notes;
pub(crate) use bass::{bass_line, BassLine};
pub use harmony::{analyze_harmony, Harmony};
use harmony::{register_at, Register};
pub use piano::{arrange_piano_passages, piano_passages};
pub(crate) use piano::align_piano_entries;
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

// Piano fallbacks copied into the instrument stream are the same observation,
// not a confirming second detector.
fn confirmed_attack(n: &Note, piano: &[Note]) -> bool {
    if n.end - n.start < 0.08 { return false; }
    let first = piano.partition_point(|k| k.start < n.start - 0.035);
    let mut confirmed = false;
    for k in piano[first..].iter().take_while(|k| k.start <= n.start + 0.035) {
        if k == n { return false; }
        if k.pitch == n.pitch && k.velocity >= 55 && k.end - k.start >= 0.03 {
            confirmed = true;
        }
    }
    confirmed
}

fn confirmed_upper_attack(n: &Note, piano: &[Note]) -> bool {
    n.pitch >= 64 && confirmed_attack(n, piano)
}

// A detector can split off a tiny lead-in just before a sustained strike.
// Repair that key after selecting the line so its longer release can't
// change which pitches win later. Leave room for the next rolled chord.
fn restore_fragmented_attacks(lead: &mut [Note], instrumental: &[Note], piano: &[Note], vocals: &[Note], duration: f64) {
    const SEPARATE: f64 = 0.065;
    for i in 0..lead.len() {
        let short = lead[i];
        if short.end - short.start > SEPARATE { continue; }
        let from = instrumental.partition_point(|n| n.start < short.end - 0.012);
        let Some(strike) = instrumental[from..].iter().take_while(|n| n.start < short.start + SEPARATE)
            .find(|n| n.pitch == short.pitch && n.velocity >= short.velocity && n.start <= short.end + 0.012
                && confirmed_attack(n, piano)) else { continue };
        let first = piano.partition_point(|p| p.start < short.start - 0.035);
        if piano[first..].iter().take_while(|p| p.start <= short.start + 0.035)
            .any(|p| p.pitch == short.pitch && p.velocity >= 55 && p.end - p.start >= 0.030) { continue; }
        let next_vocal = vocals.get(vocals.partition_point(|n| n.start <= short.start));
        if next_vocal.is_some_and(|n| n.start - strike.start < 0.24) { continue; }
        let next_attack = lead.get(i + 1).map_or(duration, |next| {
            let from = instrumental.partition_point(|n| n.start < next.start - 0.035);
            instrumental.get(from).map_or(next.start, |n| n.start.min(next.start))
        });
        let end = strike.end.min(next_attack).min(next_vocal.map_or(duration, |n| n.start - 0.045));
        if end - strike.start >= 0.030 { lead[i] = Note { end, ..*strike }; }
    }
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
            let confirmed = confirmed_upper_attack(n, piano);
            let independent = (57..=88).contains(&n.pitch) && n.velocity >= 53 && n.end - n.start >= 0.12;
            if !confirmed && !independent && !established && !continues {
                return None;
            }
            if prior.is_some_and(|p| n.start - p.start < 0.065 ||
                (n.start < p.end && p.pitch.abs_diff(n.pitch) > 7 && (!continues || old_line_continues)
                    && !(confirmed && n.pitch > p.pitch))) {
                return None;
            }
            let score = f64::from(n.velocity) + 0.38 * f64::from(n.pitch)
                - 1.6 * f64::from(distance.unwrap_or(0).min(12))
                + f64::from(6 - next.unwrap_or(6).min(6)) + if confirmed { 10. } else { 0. };
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
    restore_fragmented_attacks(&mut lead, instrumental, piano, vocals, duration);
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

/// Retain sustained partners at a selected instrumental attack. Keep the
/// preferred dyad; a third key needs its own independent detector onset
/// and must fit within the same octave-wide hand.
fn treble_partners(lead: &[Note], instrumental: &[Note], piano: &[Note], vocals: &[Note], mut left: &[Note]) -> Vec<Note> {
    let mut partners = Vec::new();
    for (i, key) in lead.iter().enumerate() {
        if key.end - key.start < 0.08 || vocals.binary_search_by(|n| n.start.total_cmp(&key.start)).is_ok() {
            continue;
        }
        let first = instrumental.partition_point(|n| n.start < key.start - 0.035);
        let count = instrumental[first..].partition_point(|n| n.start <= key.start + 0.035);
        let attacks = &instrumental[first..first + count];
        if attacks.len() < 2 { continue; }
        let Some(primary) = attacks.iter().find(|n| n.pitch == key.pitch && n.start == key.start) else { continue };
        let supported = confirmed_upper_attack(primary, piano);
        // Left-hand chords overlap: a later low note need not release an
        // earlier high one. Discard only an expired prefix of the sorted track.
        while left.first().is_some_and(|n| n.end <= key.start - 0.035) {
            left = &left[1..];
        }
        let candidates = attacks.iter().filter_map(|n| {
            // Preserve the source's rolled onset, but not at the expense of
            // either neighboring melody key or the sounding left hand.
            let end = n.end.min(key.end);
            if !fill_candidate(n) || !(2..=10).contains(&n.pitch.abs_diff(key.pitch))
                || end - n.start.max(key.start) < 0.08 || (i > 0 && n.start < lead[i - 1].end)
                || left.iter().take_while(|b| b.start < end).any(|b| b.end > n.start && b.pitch >= n.pitch)
            { return None; }
            let confirmed = confirmed_attack(n, piano);
            // A middle-register partner must itself be corroborated, and
            // fills only a free voice; it never displaces an upper dyad.
            let upper = n.pitch > 65;
            if !confirmed && !(upper && supported && n.end - n.start >= 0.12) { return None; }
            Some(((upper, confirmed, n.velocity, n.pitch), Note {
                end, velocity: key.velocity.saturating_sub(10).max(1), ..*n
            }))
        });
        let Some((_, partner)) = candidates.clone().max_by_key(|&(rank, _)| rank) else { continue };
        if count >= 3 {
            let third = candidates.filter(|((_, confirmed, _, _), n)| {
                *confirmed && (2..=12).contains(&n.pitch.abs_diff(partner.pitch))
            }).max_by_key(|&(_, n)| (n.velocity, n.pitch));
            if let Some((_, n)) = third {
                partners.extend(if n.start < partner.start { [n, partner] } else { [partner, n] });
                continue;
            }
        }
        partners.push(partner);
    }
    partners
}

/// The monophonic path can hold a lower backing key across a distinct upper
/// attack. Keep the sustained key and add the attack at its own source time,
/// only if both fit one hand. An octave can be a partial of the held key.
fn interior_treble(lead: &[Note], instrumental: &[Note], piano: &[Note], vocals: &[Note],
    bass: &[Note], extra: &mut Vec<Note>, duration: f64) {
    const SEPARATE: f64 = 0.065;
    let partner_count = extra.len();
    for (i, held) in lead.iter().enumerate() {
        if held.end - held.start <= SEPARATE { continue; }
        let vocal = vocals.get(vocals.partition_point(|n| n.start < held.start));
        if vocal.is_some_and(|v| v.start == held.start) { continue; }
        let next = lead.get(i + 1);
        let until = held.end.min(next.map_or(duration, |n| n.start - SEPARATE))
            .min(vocal.map_or(duration, |n| n.start - 0.24));
        // A rolled partner of the following lead key can arrive 35 ms early.
        let release = next.map_or(duration, |n| n.start - 0.035);
        // A later strum partner can release before the earlier one. Look at
        // both, rather than just the last partner preceding an interior note.
        let first_partner = extra[..partner_count].partition_point(|p| p.start < held.start - 0.035);
        let from = instrumental.partition_point(|n| n.start < held.start + SEPARATE);
        let mut candidates = &instrumental[from..];
        while let Some(first) = candidates.first().filter(|n| n.start < until) {
            let (group, tail) = candidates.split_at(candidates.partition_point(|n| n.start < (first.start + SEPARATE).min(until)));
            candidates = tail;
            let chosen = group.iter().filter_map(|n| {
                let end = n.end.min(release);
                if !(66..=96).contains(&n.pitch) || !(2..=11).contains(&n.pitch.saturating_sub(held.pitch))
                    || n.velocity < 53 || n.end - n.start < 0.12 || end - n.start < SEPARATE
                    || extra[first_partner..partner_count].iter().take_while(|p| p.start < end).any(|p| p.end > n.start)
                    || overlapping(bass, n.start, end).any(|b| b.pitch >= n.pitch) { return None; }
                // A weaker, touching fragment of a recently struck key isn't
                // another attack unless the piano detector also heard it.
                let confirmed = confirmed_upper_attack(n, piano);
                if !confirmed {
                    let before = instrumental.partition_point(|p| p.start < n.start);
                    let previous = instrumental[..before].iter().rev()
                        .take_while(|p| n.start - p.start <= 0.50).find(|p| p.pitch == n.pitch);
                    if previous.is_some_and(|p| n.start - p.end <= 0.012 && n.velocity < p.velocity.saturating_add(5)) {
                        return None;
                    }
                }
                Some(((confirmed, n.velocity, n.pitch), Note {
                    end, velocity: (54. + 0.30 * f64::from(n.velocity)).round() as u8, ..*n
                }))
            }).max_by_key(|(rank, _)| *rank);
            if let Some((_, n)) = chosen {
                if extra.len() > partner_count {
                    let last = extra.last_mut().unwrap();
                    if n.start - last.start < SEPARATE { continue; }
                    last.end = last.end.min(n.start);
                }
                extra.push(n);
            }
        }
    }
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
    recorded: u128,
    upper_classes: u16,
    register: Register,
) -> Vec<u8> {
    let floor = bass.map_or(40, |p| {
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
    let mut playable: Vec<_> = (floor..=ceiling)
        .filter(|p| {
            let spectral = register.strength(*p) >= 0;
            let struck = recorded & (1_u128 << p) != 0;
            let weight = weights[(p % 12) as usize];
            (*p >= 43 || bass.is_some() || spectral)
                && (weight >= 0.42 * strongest || (weight > 0. && struck && spectral))
                && bass.is_none_or(|b| b % 12 != p % 12)
                && (upper_classes & (1 << (p % 12)) == 0 || struck || spectral)
        })
        .collect();
    // Once a real inner voice fits, don't manufacture a partner by folding
    // an observed key down or up an octave. Keep the chroma-only fallback
    // when the recording doesn't resolve any playable register.
    let observed = |p: u8| recorded & (1_u128 << p) != 0 || register.strength(p) >= 0;
    if playable.iter().any(|&p| observed(p)) {
        playable.retain(|&p| observed(p) || recorded & ((1_u128 << (p + 12)) | (1_u128 << (p - 12))) == 0);
    }
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
            + if recorded & (1u128 << p) != 0 { 0.50 } else { 0. }
            + match register.strength(p) { 1 => 0.95, 0 => 0.45, _ => 0. }
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
fn overlapping(line: &[Note], start: f64, end: f64) -> impl Iterator<Item = &Note> + Clone {
    let first = line.partition_point(|n| n.start < start).saturating_sub(1);
    line[first..]
        .iter()
        .take_while(move |n| n.start < end)
        .filter(move |n| n.end > start)
}

// The cursor moves forward with the chord onsets. A high, held member of an
// earlier strum still counts even after a later chord member has released.
fn sounding_partners<'a>(cursor: &mut &'a [Note], start: f64, end: f64) -> impl Iterator<Item = &'a Note> {
    while let Some((first, rest)) = cursor.split_first() {
        if first.end > start { break; }
        *cursor = rest;
    }
    let line = *cursor;
    line.iter().take_while(move |n| n.start < end).filter(move |n| n.end > start)
}

// Tie only touching, already-playable support segments. This changes the
// articulation, not the keys sounding at any point or the reach of either hand.
fn join_held_support(harmony: &mut Vec<Note>, backing: &[Note], instrumental: &[Note]) {
    let mut held_until = [0.0f64; 128];
    let mut previous = [usize::MAX; 128];
    let mut source = backing.iter().peekable();
    let mut written = 0;
    for read in 0..harmony.len() {
        let n = harmony[read];
        let key = usize::from(n.pitch);
        let prior = previous[key];
        if prior != usize::MAX && harmony[prior].end == n.start {
            while let Some(s) = source.next_if(|s| s.start <= n.start - 0.08) {
                let p = usize::from(s.pitch);
                if s.velocity >= 37 && p < held_until.len() {
                    held_until[p] = held_until[p].max(s.end);
                }
            }
            // Require an exact-key hold; since voicing folds octaves, even an
            // octave-displaced attack in either input argues against a tie.
            let attacked = |line: &[Note]| {
                let first = line.partition_point(|s| s.start < n.start - 0.075);
                line[first..]
                    .iter()
                    .take_while(|s| s.start <= n.start + 0.075)
                    .any(|s| s.pitch % 12 == n.pitch % 12)
            };
            if held_until[key] >= n.start + 0.08 && !attacked(backing) && !attacked(instrumental) {
                harmony[prior].end = n.end;
                continue;
            }
        }
        previous[key] = written;
        if written != read {
            harmony[written] = n;
        }
        written += 1;
    }
    harmony.truncate(written);
}

fn playable_bass(raw_bass: &[Note], lead: &[Note], duration: f64) -> Vec<Note> {
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
    bass
}

// Chord grouping may merge repeated strums. Split only the key that was
// attacked again, never the bass or the other fingers holding the chord.
fn restore_chord_repeats(harmony: &mut Vec<Note>, piano: &[Note], instrumental: &[Note]) {
    let mut repeats = Vec::new();
    for n in harmony.iter_mut() {
        let end = n.end;
        let lo = piano.partition_point(|s| s.start < n.start + 0.090);
        let mut tail = *n;
        for (offset, s) in piano[lo..].iter().take_while(|s| s.start <= end - 0.075).enumerate() {
            if s.pitch != n.pitch || s.start < tail.start + 0.090 || s.velocity < 45 || s.end - s.start < 0.075 { continue; }
            let i = instrumental.partition_point(|p| p.start < s.start - 0.040);
            let corroborated = instrumental[i..].iter().take_while(|p| p.start <= s.start + 0.040)
                .any(|p| p.pitch == s.pitch && p != s);
            if !corroborated {
                let prior = piano[..lo + offset].iter().rev().take_while(|p| p.start >= s.start - 1.)
                    .find(|p| p.pitch == s.pitch && p.start < s.start);
                if s.velocity < 55 || !prior.is_some_and(|p| (0.015..=0.8).contains(&(s.start - p.end))) { continue; }
            }
            tail.end = s.start;
            if tail.start == n.start { n.end = tail.end; } else { repeats.push(tail); }
            tail.start = s.start;
        }
        if tail.start > n.start { tail.end = end; repeats.push(tail); }
    }
    harmony.extend(repeats);
}

fn left_hand(mut bass: Vec<Note>, backing: &[Note], instrumental: &[Note], piano: &[Note],
    lead: &[Note], partners: &[Note], registers: &[Register], duration: f64, beat: f64) -> Vec<Note> {
    let mut upper = partners;
    let mut active: Vec<&Note> = vec![];
    let mut next = 0;
    let mut chords: Vec<Chord> = vec![];
    for group in &groups(backing) {
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
        let nearby = overlapping(lead, start, start + 0.32);
        if weights.iter().filter(|&&w| w > 0.).count() < 2
            && !bass_key.is_some_and(|b| {
                group.iter().any(|n| {
                    n.pitch <= 78
                        && n.velocity >= 45
                        && n.end - n.start >= (0.60 * beat).max(0.22)
                        && n.pitch % 12 != b % 12
                        && !nearby.clone().any(|p| p.pitch % 12 == n.pitch % 12)
                })
            })
        {
            continue;
        }
        let prior = chords.last().map_or(&[][..], |c| c.notes.as_slice());
        // Pitch-class weights cannot distinguish a recorded G3 from G4.
        // Prefer the struck register only among otherwise playable chord keys.
        // Stable spectral peaks are independent evidence for the octave.
        let first = piano.partition_point(|n| n.start < start - 0.045);
        let recorded = piano[first..].iter().take_while(|n| n.start <= start + 0.055)
            .filter(|n| (32..=89).contains(&n.pitch) && n.velocity >= 45 && n.end - n.start >= 0.075)
            .fold(0_u128, |keys, n| keys | (1_u128 << n.pitch));
        let lead_classes = if registers.is_empty() { 0 } else {
            nearby.clone().take_while(|n| n.start < start + 0.055).fold(0, |pcs, n| pcs | (1 << (n.pitch % 12)))
        };
        let (ceiling, upper_classes) = sounding_partners(&mut upper, start, start + 0.32)
            .fold((nearby.map(|n| n.pitch).min(), lead_classes), |(lowest, classes), n| {
                (Some(lowest.map_or(n.pitch, |p| p.min(n.pitch))), classes | (1 << (n.pitch % 12)))
            });
        let voiced = voicing(&weights, bass_key, ceiling, prior, recorded, upper_classes, register_at(registers, start));
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
    let mut upper = partners;
    for (i, chord) in chords.iter().enumerate() {
        let start = chord.start;
        let boundary = chords.get(i + 1).map_or(duration, |c| c.start);
        let shape_start = harmony.len();
        let register = register_at(registers, start);
        let mean = chord.notes.iter().map(|&(p, _)| f64::from(register.strength(p))).sum::<f64>() / chord.notes.len() as f64;
        // Keep the existing chord accent while varying the touch of its members.
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
            for n in sounding_partners(&mut upper, start, end) {
                if n.pitch <= pitch { end = end.min(n.start); }
            }
            if end - start >= 0.08 {
                harmony.push(Note {
                    pitch,
                    velocity: (f64::from(chord.velocity) * 10f64.powf(0.07 * (f64::from(register.strength(pitch)) - mean))).round().clamp(1., 127.) as u8,
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
    join_held_support(&mut harmony, backing, instrumental);
    // Grouping finds the chord, but a rolled member has its own onset.
    // Delay only unambiguous recorded strikes; never move a bass attack.
    for n in &mut harmony {
        let first = piano.partition_point(|s| s.start < n.start - 0.060);
        let mut strikes = piano[first..].iter().take_while(|s| s.start <= n.start + 0.055)
            .filter(|s| s.pitch == n.pitch && s.velocity >= 45 && s.end - s.start >= 0.075);
        if let Some(s) = strikes.next() {
            if strikes.next().is_some() { continue; }
            let i = instrumental.partition_point(|p| p.start < s.start - 0.055);
            let release = instrumental[i..].iter().take_while(|p| p.start <= s.start + 0.055)
                .filter(|p| p.pitch == s.pitch).map(|p| p.end).fold(s.end, f64::max);
            if release < n.end - 0.060 && release - n.start >= 0.075
                && register_at(registers, n.start).strength(n.pitch) >= 0
                && register_at(registers, release + 0.040).strength(n.pitch) < 0 {
                n.end = release;
            }
            if s.start > n.start + 0.012 && n.end - s.start >= 0.065 {
                n.start = s.start;
            }
        }
    }
    restore_chord_repeats(&mut harmony, piano, instrumental);
    bass.extend(harmony);
    order_in_place(&mut bass, duration);
    bass
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
    arrange_with_instruments(vocals, backing, backing, harmonic_notes, &[], bass, duration, tempos)
}

pub(crate) fn arrange_with_instruments(
    vocals: &[Note], instrumental: &[Note], backing: &[Note], harmonic_notes: &[Note], registers: &[Register],
    bass: Option<&[Note]>, duration: f64, tempos: &[(f64, f64)],
) -> PrettyMidi {
    let mut midi = PrettyMidi::with_tempo_map(960, tempos);
    let beat = midi.tick_scales[0].1 * f64::from(midi.resolution);
    let piano = ordered(backing, duration);
    let vocals = ordered(vocals, duration);
    let instrumental = ordered(instrumental, duration);
    let mut lead = melody(&vocals, &instrumental, &piano, duration, beat);
    let bass = match bass {
        Some(line) => ordered(line, duration),
        None => {
            let mut low: Vec<Note> = vec![];
            for &n in piano.iter().filter(|n| n.pitch < 48 && n.velocity >= 49) {
                if low.last().is_none_or(|last| n.start - last.start >= 0.095) {
                    low.push(n);
                }
            }
            low
        }
    };
    // Harmonic estimates can voice the left hand, but cannot independently
    // confirm a second right-hand attack.
    let mut combined;
    let evidence = if harmonic_notes.is_empty() { &piano } else {
        combined = Vec::with_capacity(piano.len() + harmonic_notes.len());
        combined.extend_from_slice(&piano);
        combined.extend_from_slice(harmonic_notes);
        order_in_place(&mut combined, duration);
        &combined
    };
    let low = playable_bass(&bass, &lead, duration);
    let mut extra = treble_partners(&lead, &instrumental, &piano, &vocals, &low);
    let left = left_hand(low, evidence, &instrumental, &piano, &lead, &extra, registers, duration, beat);
    interior_treble(&lead, &instrumental, &piano, &vocals, &bass, &mut extra, duration);
    if !extra.is_empty() {
        lead.extend(extra);
        lead.sort_unstable_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    }
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
#[cfg(test)]
mod treble_tests;
