//! Restore lower backing notes lost when chord reduction drops a short or single-key attack.
use crate::{basicpitch::SAMPLE_RATE, pmidi::{Note, PrettyMidi}};
use std::sync::LazyLock;

const WIDTH: usize = SAMPLE_RATE as usize * 80 / 1000;
const MIN_HOLD: f64 = 0.032;
const WINDOW: LazyLock<[f32; WIDTH]> = LazyLock::new(|| std::array::from_fn(|i| {
    0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos()
}));

// A new key must rise above both its pre-attack level and neighboring frequencies.
// Goertzel on the fundamental and up to two overtones uses existing mono audio;
// no song-sized spectrogram or inference pass. Two semitones per side resolves
// low keys adequately even in the 80 ms window around a muted pluck.
fn struck(wave: &[f32], n: Note) -> bool {
    let frame = |offset: f64| {
        let t = n.start + offset;
        if t < 0. { return None; }
        let i = (t * f64::from(SAMPLE_RATE)).round() as usize;
        wave.get(i..i + WIDTH)
    };
    let short = n.end - n.start < 0.080;
    let offset = if short { (n.end - n.start) * 0.5 - 0.040 } else { 0.005 };
    let (Some(before), Some(after)) = (frame(-0.089), frame(offset)) else { return false };
    let omega = std::f64::consts::TAU * 440. * 2_f64.powf((f64::from(n.pitch) - 69.) / 12.) / f64::from(SAMPLE_RATE);
    let partial = |h: f64| {
        let coeff = [1., 0.8908987181403393, 1.122462048309373].map(|r| 2. * (omega * h * r).cos());
        let (mut a, mut b) = ([0.; 4], [0.; 4]);
        for ((&x, &old), &w) in after.iter().zip(before).zip(WINDOW.iter()) {
            let prev = a;
            let x = f64::from(x * w);
            for j in 0..3 { a[j] = x + coeff[j] * prev[j] - b[j]; }
            a[3] = f64::from(old * w) + coeff[0] * prev[3] - b[3];
            b = prev;
        }
        let magnitude = |i: usize, c: f64| (a[i]*a[i] + b[i]*b[i] - c*a[i]*b[i]).max(0.).sqrt();
        (magnitude(0, coeff[0]), (magnitude(1, coeff[1]) + magnitude(2, coeff[2])) * 0.5, magnitude(3, coeff[0]))
    };
    let (peak, sides, pre) = partial(1.);
    let rise = if short { 2. } else { 1.5 };
    peak > 1.25 * sides && peak > rise * pre.max(0.001) && [2., 3.].into_iter().any(|h| {
        let (peak, sides, pre) = partial(h);
        peak > 1.15 * sides && peak > 1.3 * pre.max(0.001)
    })
}

// Only expire prefixes: chord members need not release in attack order.
fn advance(notes: &[Note], cursor: &mut usize, before: f64) {
    while *cursor < notes.len() && notes[*cursor].end <= before { *cursor += 1; }
}

pub(super) fn apply(midi: &mut PrettyMidi, backing: &[Note], wave: &[f32], piano: &[(f64, f64)]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if wave.is_empty() || backing.is_empty() { return; }
    let mut added: Vec<Note> = Vec::new();
    let (mut r, mut l, mut a) = (0, 0, 0);
    for &s in backing {
        if !(40..=55).contains(&s.pitch) || s.velocity < 45 || s.end - s.start < MIN_HOLD { continue; }
        let mut end = s.end.min(s.start + 0.65);
        if let Some(&(start, _)) = piano.get(piano.partition_point(|&(_, stop)| stop <= s.start)) { end = end.min(start); }
        if end - s.start < MIN_HOLD { continue; }
        let overlaps = |n: &Note| n.end > s.start && n.start < end;
        let duplicate = |n: &Note| n.pitch == s.pitch && n.end > s.start - 0.05;
        advance(&right.notes, &mut r, s.start - 0.05);
        advance(&left.notes, &mut l, s.start - 0.05);
        advance(&added, &mut a, s.start - 0.05);
        let mut rh = right.notes[r..].iter().take_while(|n| n.start < end + 0.03);
        if rh.any(|n| duplicate(n) || overlaps(n) && n.pitch <= s.pitch + 1) { continue; }
        let lh = left.notes[l..].iter().take_while(|n| n.start < end + 0.03).chain(&added[a..]);
        let mut fingers = 0;
        if lh.into_iter().any(|n| {
            if duplicate(n) { return true; }
            if !overlaps(n) { return false; }
            fingers += 1;
            n.pitch.abs_diff(s.pitch) > 12 || fingers > 3
        }) { continue; }
        if struck(wave, s) { added.push(Note { end, velocity: s.velocity.min(68), ..s }); }
    }
    if !added.is_empty() {
        left.notes.append(&mut added);
        left.notes.sort_unstable_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;

    #[test]
    fn muted_key_requires_a_tonal_attack_and_room_for_the_left_hand() {
        let n = Note { pitch: 52, velocity: 61, start: 0.32, end: 0.368 };
        let audio: Vec<_> = (0..SAMPLE_RATE).map(|i| {
            let time = f64::from(i) / f64::from(SAMPLE_RATE);
            if time < n.start || time >= n.end { return 0.; }
            let phase = std::f64::consts::TAU * 164.814 * (time - n.start);
            (0.2 * phase.sin() + 0.1 * (2. * phase).sin()) as f32
        }).collect();
        let mut click = vec![0.; audio.len()];
        click[(n.start * f64::from(SAMPLE_RATE)) as usize] = 1.;
        for (wave, piano, blocker, expected) in [
            (&audio, None, None, true), (&click, None, None, false),
            (&audio, Some((0.1, 0.6)), None, false), (&audio, None, Some(48), false),
        ] {
            let mut m = PrettyMidi::new(960, 120.);
            let mut right = Instrument::new(0, false, "Melody");
            if let Some(pitch) = blocker { right.notes.push(Note { pitch, ..n }); }
            m.instruments.push(right);
            m.instruments.push(Instrument::new(0, false, "Bass"));
            apply(&mut m, &[n], wave, piano.as_slice());
            assert_eq!(m.instruments[1].notes.as_slice(), if expected { std::slice::from_ref(&n) } else { &[] });
        }
    }
}
