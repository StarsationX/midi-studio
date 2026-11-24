//! When the recording itself is a piano performance, preserve its keys and
//! attacks rather than transposing them into the vocal/bass reduction.
use crate::pmidi::{Note, PrettyMidi};
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
            piano > 1e-5 && piano >= 9. * rest && (p >= other || p + other < 1e-4)
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
    fn shape(&self, group: &[Note]) -> Shape {
        let mut best = Shape::default();
        for (first, lowest) in group.iter().enumerate() {
            let mut value = 0.;
            for (i, n) in group[first..].iter().take(5).enumerate() {
                if n.pitch - lowest.pitch > 12 { break; }
                value += 48. + f64::from(n.velocity) * 0.25;
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

fn assign(group: &[Note], left: &mut Hand, right: &mut Hand, time: f64) {
    let mut best = (f64::NEG_INFINITY, 0..0, 0..0);
    for split in 0..=group.len() {
        let l = left.shape(&group[..split]);
        let r = right.shape(&group[split..]);
        if l.score + r.score > best.0 {
            let rf = split + r.first;
            best = (l.score + r.score, l.first..l.first+l.count, rf..rf+r.count);
        }
    }
    let (l,r) = (&group[best.1], &group[best.2]);
    left.strike(l, (21,r.first().map_or(108, |n| n.pitch - 1)), time);
    right.strike(r, (l.last().map_or(21, |n| n.pitch + 1),108), time);
}

pub fn arrange_piano_passages(midi: &mut PrettyMidi, piano: &[Note], passages: &[(f64,f64)]) {
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
            assign(&group, &mut left, &mut right, time);
            pending = &pending[group.len()..];
        }
    }
    if ranges.is_empty() { return; }
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
