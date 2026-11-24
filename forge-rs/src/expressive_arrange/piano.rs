//! When the recording itself is a piano performance, preserve its keys and
//! attacks rather than transposing them into the vocal/bass reduction.
use crate::pmidi::{ControlChange, Note, PrettyMidi};
use std::borrow::Cow;

// A short breath between two confirmed piano passages need not release the
// pedal. Require it to be quiet relative to an attack on *each* side, with
// no foreground instrument rising above the neighboring background.
fn quiet_piano_gap(energy: &[[f64; 2]], from: usize, to: usize) -> bool {
    if to - from > 4 { return false; }
    let level = |bins: &[[f64; 2]]| bins.iter().fold((0_f64, 0.), |(peak, rest), &[p, r]| {
        (peak.max(p), rest + r)
    });
    // Each accepted passage has at least four half-second bins.
    let (before, left_rest) = level(&energy[from-4..from]);
    let (after, right_rest) = level(&energy[to..to+4]);
    let quiet = 0.1 * before.min(after);
    let background = (left_rest + right_rest) * 0.25; // twice the adjacent mean
    energy[from..to].iter().all(|&[p, r]| p + r < quiet && r <= background)
}

/// Half-second sums of squared mono samples: piano stem, all other stems.
/// Require a sustained majority, not a single exposed note in a band mix.
pub fn piano_passages(energy: &[[f64; 2]], duration: f64) -> Vec<(f64, f64)> {
    let mut passages = Vec::new();
    let mut begin = None;
    let mut previous_end = 0;
    for i in 0..=energy.len() {
        let solo = energy.get(i).is_some_and(|&[p, other]| {
            let window = &energy[i.saturating_sub(2)..energy.len().min(i + 3)];
            let (piano, rest) = window.iter().fold((0., 0.), |(a,b), e| (a+e[0], b+e[1]));
            if piano > 1e-5 && piano >= 9. * rest && (p >= other || p + other < 1e-4) {
                return true;
            }
            // At a quiet release, room sound can outweigh the dying piano for
            // a few frames. Keep the performance across the breath, but never
            // explain a foreground band entrance as room sound.
            let phrase = &energy[i.saturating_sub(8)..energy.len().min(i + 9)];
            let (keys, band) = phrase.iter().fold((0., 0.), |(a,b), e| (a+e[0], b+e[1]));
            keys > 1e-4 && keys >= 9. * band
                && (p >= 2. * other || other * (phrase.len() as f64) < 0.03 * keys)
                && phrase.iter().filter(|e| e[0] > 2. * e[1] && e[0] > keys * 0.005).take(4).count() == 4
        });
        if solo { begin.get_or_insert(i); }
        else if let Some(first) = begin.take() {
            if i - first >= 4 {
                let end = duration.min(i as f64 * 0.5);
                if let Some((_, prior_end)) = passages.last_mut().filter(|_| quiet_piano_gap(energy, previous_end, first)) {
                    *prior_end = end;
                } else {
                    passages.push((first as f64 * 0.5, end));
                }
                previous_end = i;
            }
        }
    }
    passages
}

// Stem classification runs on half-second bins; a measured rolled chord
// needn't begin on their edge. Move the entry only for a different key that
// is already ringing into the first measured strike, not a preceding pickup.
pub(crate) fn align_piano_entries(passages: &mut [(f64, f64)], keys: &[Note]) {
    let mut prior_end = 0.;
    for (start, end) in passages {
        let i = keys.partition_point(|n| n.start < *start);
        if let Some(head) = keys.get(i).filter(|n| n.start < *end && n.start - *start <= 0.035
            && n.velocity > 0 && n.end - n.start >= 0.08) {
            let from = keys[..i].partition_point(|n| n.start < (head.start - 0.035).max(prior_end));
            if let Some(first) = keys[from..i].iter().find(|n| n.pitch != head.pitch
                && n.velocity > 0 && n.end >= head.start + 0.08) {
                *start = first.start;
            }
        }
        prior_end = *end;
    }
}

#[derive(Clone, Copy, Default)]
struct Shape { first: usize, count: usize, score: f64 }

struct Hand {
    center: f64,
    home: f64,
    active: Vec<usize>,
    notes: Vec<Note>,
}

impl Hand {
    fn new(home: f64) -> Self { Self { center: home, home, active: Vec::with_capacity(5), notes: Vec::new() } }

    // A contiguous cluster of at most five attacks within an octave. Prefer
    // retaining the actual pitches to moving the hand less; use motion and
    // normal playing register to break ties between playable distributions.
    fn shape(&self, group: &[Note], outer: (u8, u8)) -> Shape {
        let mut best = Shape::default();
        for (first, lowest) in group.iter().enumerate() {
            let mut value = 0.;
            for (i, n) in group[first..].iter().take(5).enumerate() {
                if n.pitch - lowest.pitch > 12 { break; }
                value += 48. + f64::from(n.velocity) * 0.25;
                // When the chord exceeds hand reach, favor its bass and top
                // line over an inner doubling without changing their pitches.
                if n.pitch == outer.0 || n.pitch == outer.1 { value += 20.; }
                let center = f64::from(n.pitch + lowest.pitch) * 0.5;
                let cost = 0.65 * (center - self.center).abs() + 0.32 * (center - self.home).abs();
                let score = value - cost;
                if score > best.score { best = Shape { first, count: i+1, score }; }
            }
        }
        best
    }

    fn held_seconds(&self, time: f64, unreachable: impl Fn(u8) -> bool) -> f64 {
        self.active.iter().map(|&i| &self.notes[i])
            .filter(|n| n.end > time && unreachable(n.pitch))
            .map(|n| (n.end - time).min(1.)).sum()
    }

    fn strike(&mut self, new: &[Note], other: &[Note], crosses: impl Fn(u8, u8) -> bool, time: f64, dry_roll: bool) {
        self.active.retain(|&i| self.notes[i].end > time);
        // When every finger has room, a rolled chord need not lift this key
        // until the particular attack that conflicts. Under pedal the source
        // tail may be resonance; don't extend the existing finger assignment.
        let release_on_attack = dry_roll && self.active.len() + new.len() <= 5;
        let mut kept = 0;
        self.active.retain(|&i| {
            let n = &mut self.notes[i];
            if kept + new.len() >= 5 { n.end = time; return false; }
            let mut conflicts = new.iter().filter(|m| n.pitch.abs_diff(m.pitch) > 12 || n.pitch == m.pitch)
                .chain(other.iter().filter(|m| crosses(n.pitch, m.pitch)));
            let cutoff = if release_on_attack { conflicts.map(|m| m.start).reduce(f64::min) }
                else { conflicts.next().map(|_| time) };
            if let Some(t) = cutoff { n.end = n.end.min(t); false }
            else { kept += 1; true }
        });
        if let (Some(lo), Some(hi)) = (new.first(), new.last()) {
            self.center = f64::from(lo.pitch + hi.pitch) * 0.5;
        }
        for note in new { self.active.push(self.notes.len()); self.notes.push(*note); }
    }
}

// With uncrossed hands, a leap above a held RH key (or below a held LH key)
// by more than an octave forces its release. Reserve that hand for the leap
// when the other hand can take the same attacks. Ignore short release tails:
// the transcription can include resonance rather than a finger on the key.
fn left_hold_advantage(n: &Note, upcoming: &[Note], horizon: f64) -> f64 {
    let cutoff = (n.end - 0.25).min(horizon);
    let (mut left_loss, mut right_loss) = (0., 0.);
    for next in upcoming.iter().take(16).take_while(|m| m.start < cutoff) {
        let loss = if next.pitch > n.pitch + 12 { &mut right_loss }
            else if n.pitch > next.pitch + 12 { &mut left_loss }
            else { continue };
        if *loss == 0. {
            *loss = (n.end - next.start - 0.25).min(1.);
            if left_loss > 0. && right_loss > 0. { break; }
        }
    }
    24. * (right_loss - left_loss)
}

fn assign(group: &[Note], upcoming: &[Note], left: &mut Hand, right: &mut Hand, time: f64, dry: bool) {
    let mut best = (f64::NEG_INFINITY, 0..0, 0..0);
    let mut complete = (f64::NEG_INFINITY, 0);
    let mut hold_advantage = 0.;
    let outer = (group[0].pitch, group[group.len()-1].pitch);
    for split in 0..=group.len() {
        let l = left.shape(&group[..split], outer);
        let r = right.shape(&group[split..], outer);
        let score = l.score + r.score;
        if score > best.0 {
            let rf = split + r.first;
            best = (score, l.first..l.first+l.count, rf..rf+r.count);
        }
        if l.count + r.count == group.len() && score + hold_advantage > complete.0 {
            complete = (score + hold_advantage, split);
        }
        // Moving the split past one pitch changes only that key's hold cost.
        if group.len() <= 10 && split < group.len() {
            let n = &group[split];
            hold_advantage += left_hold_advantage(n, upcoming, time + 2.);
            // A lone moving note can use the other hand instead of damping
            // already-held keys an octave away. Under pedal, a transcribed
            // tail may be resonance rather than an occupied finger.
            if dry && group.len() == 1 {
                hold_advantage += 24. * (right.held_seconds(time, |p| p > n.pitch + 12)
                    - left.held_seconds(time, |p| n.pitch > p + 12));
            }
        }
    }
    let (l,r) = if best.1.len() + best.2.len() == group.len() {
        group.split_at(complete.1)
    } else {
        (&group[best.1], &group[best.2])
    };
    let dry_roll = dry && group.len() > 1;
    left.strike(l, r, |held, rh| held >= rh, time, dry_roll);
    right.strike(r, l, |held, lh| held <= lh, time, dry_roll);
}

pub fn arrange_piano_passages(midi: &mut PrettyMidi, piano: &[Note], passages: &[(f64,f64)], sustain: &[(f64,f64)]) {
    if passages.is_empty() || piano.is_empty() { return; }
    let valid = |n: &Note| (21..=108).contains(&n.pitch) && n.velocity > 0 && n.end > n.start;
    // Native transcription is already on the recording clock and onset-sorted.
    let keys = if piano.is_sorted_by(|a, b| a.start <= b.start) && piano.iter().all(valid) {
        Cow::Borrowed(piano)
    } else {
        let mut ordered: Vec<_> = piano.iter().copied().filter(valid).collect();
        ordered.sort_unstable_by(|a, b| a.start.total_cmp(&b.start));
        Cow::Owned(ordered)
    };
    let mut ranges = Vec::new();
    let (mut left, mut right) = (Hand::new(48.), Hand::new(72.));
    let mut group: Vec<Note> = Vec::with_capacity(10);
    for &(start,end) in passages {
        let first = keys.partition_point(|n| n.start < start);
        let mut pending = &keys[first..keys.partition_point(|n| n.start < end)];
        if pending.len() < 2 { continue; }
        ranges.push((start,end));
        left.center = left.home; right.center = right.home;
        while let Some(head) = pending.first() {
            let time = head.start;
            group.clear();
            for &n in pending {
                if n.start > time + 0.035 || group.iter().any(|m| m.pitch == n.pitch) { break; }
                group.push(Note { end: n.end.min(end), ..n });
            }
            let dry = group.last().is_some_and(|last|
                sustain.get(sustain.partition_point(|&(_,up)| up <= time)).is_none_or(|&(down,_)| down > last.start));
            group.sort_unstable_by_key(|n| n.pitch);
            pending = &pending[group.len()..];
            assign(&group, pending, &mut left, &mut right, time, dry);
        }
    }
    if ranges.is_empty() { return; }
    // A MIDI pedal is channel-local. Clip it to the actual piano ranges so
    // the following band passage never inherits a held pedal from either hand.
    for &(start, end) in &ranges {
        let first = sustain.partition_point(|&(_,up)| up <= start);
        for &(down, up) in sustain[first..].iter().take_while(|&&(down,_)| down < end) {
            let (a,b) = (down.max(start), up.min(end));
            if midi.time_to_tick(a) >= midi.time_to_tick(b) { continue; }
            for track in midi.instruments.iter_mut().take(2) {
                track.control_changes.extend([
                    ControlChange { time: a, number: 64, value: 127 },
                    ControlChange { time: b, number: 64, value: 0 },
                ]);
            }
        }
    }
    for (track, hand) in midi.instruments.iter_mut().zip([right,left]) {
        track.notes.retain_mut(|n| {
            let i = ranges.partition_point(|&(_,end)| end <= n.start);
            if let Some(&(start,_)) = ranges.get(i) {
                if n.start >= start { return false; }
                n.end = n.end.min(start);
            }
            n.end > n.start
        });
        track.notes.extend(hand.notes);
        track.notes.sort_unstable_by(|a,b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piano_entry_keeps_a_chord_crossing_the_bin_but_not_an_earlier_pickup() {
        let key = |pitch, start, end| Note { pitch, start, end, velocity: 60 };
        let mut passages = [(1., 4.), (5., 8.)];
        let keys = [key(47, 0.95, 1.6), key(69, 0.994, 2.), key(64, 1.004, 2.),
            key(72, 4.985, 4.999), key(67, 5.012, 5.5)];
        align_piano_entries(&mut passages, &keys);
        assert_eq!(passages, [(0.994, 4.), (5., 8.)]);
    }

    #[test]
    fn sustained_middle_chord_leaves_a_hand_for_the_upcoming_leap() {
        let key = |pitch, start, end| Note { pitch, start, end, velocity: 72 };
        let chord = [key(58, 0., 1.8), key(64, 0.02, 1.7)];
        let leap = [key(79, 0.6, 0.8)];
        let (mut left, mut right) = (Hand::new(48.), Hand::new(72.));
        assign(&chord, &leap, &mut left, &mut right, 0., true);
        assign(&leap, &[], &mut left, &mut right, 0.6, false);
        assert_eq!(left.notes, chord);
        assert_eq!(right.notes, leap);
    }

    #[test]
    fn dry_roll_releases_at_first_conflicting_attack_not_first_chord_onset() {
        let key = |pitch, start, end| Note { pitch, start, end, velocity: 72 };
        let rh = [key(67, 0.5, 0.8), key(76, 0.52, 0.8)];
        for (dry, end) in [(true, 0.52), (false, 0.5)] {
            let mut hand = Hand::new(72.);
            hand.strike(&[key(60, 0., 0.9)], &[], |a,b| a <= b, 0., false);
            hand.strike(&rh, &[], |a,b| a <= b, 0.5, dry);
            assert_eq!(hand.notes[0].end, end);
        }
    }

    #[test]
    fn dry_moving_note_can_leave_an_unreachable_key_ringing() {
        let high = Note { pitch: 80, start: 0., end: 1.6, velocity: 68 };
        let moving = Note { pitch: 65, start: 0.3, end: 0.5, velocity: 68 };
        for dry in [true, false] {
            let (mut left, mut right) = (Hand::new(48.), Hand::new(72.));
            assign(&[high], &[moving], &mut left, &mut right, 0., dry);
            assign(&[moving], &[], &mut left, &mut right, moving.start, dry);
            if dry {
                assert_eq!(left.notes, [moving]);
                assert_eq!(right.notes, [high]);
            } else {
                assert!(left.notes.is_empty());
                assert_eq!(right.notes, [Note { end: moving.start, ..high }, moving]);
            }
        }
    }

    #[test]
    fn only_a_background_level_breath_joins_confirmed_piano_passages() {
        let mut energy = [[1., 0.025]; 11];
        energy[4..7].fill([0.002, 0.04]);
        assert_eq!(piano_passages(&energy, 5.5), [(0., 5.5)]);
        energy[5] = [0.002, 0.09];
        assert_eq!(piano_passages(&energy, 5.5), [(0., 2.), (3.5, 5.5)]);
    }
}
