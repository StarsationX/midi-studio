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
fn struck(wave: &[f32], n: Note, soft: bool) -> bool {
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
    let partial = |h: f64| super::partials::contrast(before, after, &*WINDOW, omega * h);
    let (peak, sides, pre) = partial(1.);
    // A low detector velocity alone isn't reliable. On exposed guitar, accept
    // it only with a stronger rise and clearer pitch peaks in both bands.
    let (fund_rise, fund_contrast, overtone_rise, overtone_contrast) = if soft {
        (3., 1.6, 2., 1.4)
    } else {
        (if short { 2. } else { 1.5 }, 1.25, 1.3, 1.15)
    };
    peak > fund_contrast * sides && peak > fund_rise * pre.max(0.001) && [2., 3.].into_iter().any(|h| {
        let (peak, sides, pre) = partial(h);
        peak > overtone_contrast * sides && peak > overtone_rise * pre.max(0.001)
    })
}

// Only expire prefixes: chord members need not release in attack order.
fn advance(notes: &[Note], cursor: &mut usize, before: f64) {
    while *cursor < notes.len() && notes[*cursor].end <= before { *cursor += 1; }
}

pub(super) fn apply(midi: &mut PrettyMidi, backing: &[Note], wave: &[f32], piano: &[(f64, f64)], guitar_isolated: &[bool]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if wave.is_empty() || backing.is_empty() { return; }
    let mut added: Vec<Note> = Vec::new();
    let (mut r, mut l, mut a) = (0, 0, 0);
    for &s in backing {
        if !(40..=55).contains(&s.pitch) || s.velocity < 24 || s.end - s.start < MIN_HOLD { continue; }
        let soft = s.velocity < 45;
        if soft {
            // Cover both spectral windows, including the pre-attack baseline,
            // with the existing 50 ms, 30 dB guitar-isolation mask.
            let first = ((s.start - 0.090) * 20.) as usize;
            let last = ((s.start + 0.090) * 20.) as usize;
            if s.end - s.start < 0.064 || !guitar_isolated.get(first..=last)
                .is_some_and(|bins| bins.iter().all(|&exposed| exposed)) { continue; }
        }
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
        if struck(wave, s, soft) { added.push(Note { end, velocity: s.velocity.min(68), ..s }); }
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
            apply(&mut m, &[n], wave, piano.as_slice(), &[]);
            assert_eq!(m.instruments[1].notes.as_slice(), if expected { std::slice::from_ref(&n) } else { &[] });
        }
    }

    #[test]
    fn quiet_low_string_needs_isolation_and_a_fresh_tonal_attack() {
        let n = Note { pitch: 50, velocity: 36, start: 0.32, end: 0.46 };
        let guitar = |pluck: bool| (0..SAMPLE_RATE).map(|i| {
            let t = f64::from(i) / f64::from(SAMPLE_RATE);
            if pluck && !(n.start..n.end).contains(&t) { return 0.; }
            let phase = std::f64::consts::TAU * 146.832 * (t - n.start);
            (0.10 * phase.sin() + 0.04 * (2. * phase).sin()) as f32
        }).collect::<Vec<_>>();
        let pluck = guitar(true);
        let sustained = guitar(false);
        let exposed = [true; 20];
        let mut interrupted = exposed;
        interrupted[5] = false; // before key-on but inside the measurement
        for (wave, mask, note, expected) in [
            (&pluck, &exposed[..], n, true),
            (&pluck, &interrupted, n, false),
            (&pluck, &[][..], n, false),
            (&sustained, &exposed, n, false),
            (&pluck, &exposed, Note { end: n.start + 0.045, ..n }, false),
        ] {
            let mut m = PrettyMidi::new(960, 120.);
            m.instruments.extend([Instrument::new(0, false, "Right"), Instrument::new(0, false, "Left")]);
            apply(&mut m, &[note], wave, &[], mask);
            assert_eq!(m.instruments[1].notes.as_slice(), if expected { std::slice::from_ref(&note) } else { &[] });
        }
    }
}
