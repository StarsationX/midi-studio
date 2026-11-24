//! When the recording itself is a piano performance, preserve its keys and
//! attacks rather than transposing them into the vocal/bass reduction.
use crate::pmidi::{ControlChange, Note, PrettyMidi};
use std::borrow::Cow;

/// Half-second sums of squared mono samples: piano stem, all other stems.
/// Require a sustained majority, not a single exposed note in a band mix.
pub fn piano_passages(energy: &[[f64; 2]], duration: f64) -> Vec<(f64, f64)> {
    let mut passages = Vec::new();
    let mut begin = None;
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
                passages.push((first as f64 * 0.5, duration.min(i as f64 * 0.5)));
            }
        }
    }
    passages
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

    fn strike(&mut self, new: &[Note], limits: (u8,u8), time: f64) {
        self.active.retain(|&i| self.notes[i].end > time);
        let mut kept = 0;
        self.active.retain(|&i| {
            let n = &mut self.notes[i];
            if kept + new.len() >= 5 || n.pitch < limits.0 || n.pitch > limits.1 ||
                new.iter().any(|m| n.pitch.abs_diff(m.pitch) > 12 || n.pitch == m.pitch) {
                n.end = time;
                false
            } else { kept += 1; true }
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

fn assign(group: &[Note], upcoming: &[Note], left: &mut Hand, right: &mut Hand, time: f64) {
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
            hold_advantage += left_hold_advantage(&group[split], upcoming, time + 2.);
        }
    }
    let (l,r) = if best.1.len() + best.2.len() == group.len() {
        group.split_at(complete.1)
    } else {
        (&group[best.1], &group[best.2])
    };
    left.strike(l, (21,r.first().map_or(108, |n| n.pitch - 1)), time);
    right.strike(r, (l.last().map_or(21, |n| n.pitch + 1),108), time);
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
            group.sort_unstable_by_key(|n| n.pitch);
            pending = &pending[group.len()..];
            assign(&group, pending, &mut left, &mut right, time);
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
    fn sustained_middle_chord_leaves_a_hand_for_the_upcoming_leap() {
        let key = |pitch, start, end| Note { pitch, start, end, velocity: 72 };
        let chord = [key(58, 0., 1.8), key(64, 0.02, 1.7)];
        let leap = [key(79, 0.6, 0.8)];
        let (mut left, mut right) = (Hand::new(48.), Hand::new(72.));
        assign(&chord, &leap, &mut left, &mut right, 0.);
        assign(&leap, &[], &mut left, &mut right, 0.6);
        assert_eq!(left.notes, chord);
        assert_eq!(right.notes, leap);
    }
}
