//! An instrumental detector can anticipate a pluck. Trust a later onset only
//! when the same key actually swells in the pitched backing, not in the drums.
use crate::{basicpitch::SAMPLE_RATE, pmidi::{Note, PrettyMidi}};

// 32 ms Hann window, sampled every 4 ms on the existing 22.05 kHz detector input.
const WIDTH: usize = 706;
const HOP: usize = 88;
const SIDE: usize = 18;
const FRAMES: usize = 2 * SIDE + 1;

fn hann() -> [f32; WIDTH] {
    std::array::from_fn(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos())
}

fn coefficients(pitch: u8) -> [f32; 3] {
    let omega = std::f32::consts::TAU * 440.0 * 2.0_f32.powf((f32::from(pitch) - 69.0) / 12.0) / SAMPLE_RATE as f32;
    [1.0, 2.0, 3.0].map(|h| 2.0 * (omega * h).cos())
}

// Three Goertzel bins instead of a song-sized spectrogram.
fn magnitude(frame: &[f32], hann: &[f32; WIDTH], coeff: &[f32; 3]) -> f32 {
    let (mut a, mut b) = ([0.0_f32; 3], [0.0_f32; 3]);
    for (&s, &w) in frame.iter().zip(hann) {
        let x = s * w;
        for k in 0..3 {
            let next = x + coeff[k] * a[k] - b[k];
            b[k] = a[k];
            a[k] = next;
        }
    }
    [1.0, 0.45, 0.25].iter().enumerate().map(|(k, weight)| {
        weight * (a[k]*a[k] + b[k]*b[k] - coeff[k]*a[k]*b[k]).max(0.0).sqrt()
    }).sum()
}

fn audible_attack(wave: &[f32], note: &Note, hann: &[f32; WIDTH]) -> Option<f64> {
    let sample = (note.start * f64::from(SAMPLE_RATE) / HOP as f64).round() as usize * HOP;
    let first = sample.checked_sub(SIDE * HOP + WIDTH / 2)?;
    let block = wave.get(first..first + WIDTH + (FRAMES - 1) * HOP)?;
    let coeff = coefficients(note.pitch);
    let mut env = [0.0; FRAMES];
    for (frame, loud) in env.iter_mut().enumerate() {
        *loud = magnitude(&block[frame * HOP..][..WIDTH], hann, &coeff);
    }
    let mut peak = 0;
    for j in 1..FRAMES-5 {
        if env[j+5] - env[j] > env[peak+5] - env[peak] { peak = j; }
    }
    let at = sample as f64 / f64::from(SAMPLE_RATE)
        + (peak as f64 + 3.0 - SIDE as f64) * HOP as f64 / f64::from(SAMPLE_RATE);
    let delta = at - note.start;
    if !(0.005..=0.042).contains(&delta) { return None; }
    let mut floor = std::array::from_fn::<_, 5, _>(|i| env[peak.saturating_sub(4 - i)]);
    floor.sort_unstable_by(f32::total_cmp);
    let high = &env[peak+5..(peak+11).min(FRAMES)];
    let level = high.iter().sum::<f32>() / high.len() as f32;
    if level < 3.0 * floor[2].max(0.001) || env[peak+5] - env[peak] < 0.38 * level { return None; }
    // A piano sample takes time to speak after key-on. A full correction
    // follows the pluck envelope on paper but puts the rendered piano late.
    Some(note.start + (0.4 * delta).min(0.0165))
}

pub(super) fn align(midi: &mut PrettyMidi, wave: &[f32], vocals: &[Note], piano: &[(f64, f64)]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if wave.is_empty() || right.notes.is_empty() { return; }
    let hann = hann();
    let mut prev = f64::NEG_INFINITY;
    for i in 0..right.notes.len() {
        let n = right.notes[i];
        let next = right.notes.get(i+1).map_or(f64::INFINITY, |p| p.start);
        let separate = n.start - prev > 0.025 && next - n.start > 0.025;
        prev = n.start;
        if !separate || !(53..=96).contains(&n.pitch) || n.end - n.start <= 0.045 { continue; }
        if vocals.binary_search_by(|p| p.start.total_cmp(&n.start)).is_ok() { continue; }
        let passage = piano.get(piano.partition_point(|&(_, end)| end <= n.start));
        if passage.is_some_and(|&(a, _)| a <= n.start + 0.033) { continue; }
        let l = left.notes.partition_point(|k| k.start < n.start - 0.011);
        if left.notes.get(l).is_some_and(|k| k.start <= n.start + 0.011) { continue; }
        if let Some(at) = audible_attack(wave, &n, &hann) {
            // Delay only: never introduce overlap or move a note past its release.
            if n.end - at > 0.04 && next - at > 0.015 { right.notes[i].start = at; }
        }
    }
}

// Difference between acoustic attack level and the existing piano velocity
// in dB. Only differences *between repeats of the same key* are meaningful:
// this cancels mix gain, register and the piano sample's own loudness.
fn residual(wave: &[f32], n: Note, hann: &[f32; WIDTH]) -> Option<f64> {
    let coeff = coefficients(n.pitch);
    let level = |offset: f64| {
        let center = ((n.start + offset) * f64::from(SAMPLE_RATE)).round() as usize;
        let start = center.checked_sub(WIDTH / 2)?;
        Some(magnitude(wave.get(start..start + WIDTH)?, hann, &coeff))
    };
    let before = level(-0.032)?;
    let mut attack = [level(0.024)?, level(0.048)?, level(0.072)?];
    attack.sort_unstable_by(f32::total_cmp);
    (attack[1] > 1.6 * before.max(0.00035)).then(||
        20.0 * f64::from(attack[1]).log10() - 25.0 * f64::from(n.velocity).log10())
}

#[derive(Clone, Copy)]
struct Repeat { index: usize, db: f64, before: Option<f64> }

impl Repeat {
    fn apply(self, notes: &mut [Note], after: Option<f64>) {
        let reference = match (self.before, after) {
            (Some(a), Some(b)) => (a + b) * 0.5,
            (Some(a), None) | (None, Some(a)) => a,
            _ => return,
        };
        let key = &mut notes[self.index];
        let db = (0.30 * (self.db - reference)).clamp(-2., 2.);
        key.velocity = (f64::from(key.velocity) * 10.0_f64.powf(db / 25.)).round().clamp(1., 127.) as u8;
    }
}

pub(super) fn accent_repeats(midi: &mut PrettyMidi, wave: &[f32], instrumental: &[Note], vocals: &[Note], piano: &[(f64, f64)]) {
    let Some(right) = midi.instruments.first_mut() else { return };
    if wave.is_empty() || instrumental.is_empty() { return; }
    let notes = &mut right.notes;
    let window = hann();
    let mut pending: [Option<Repeat>; 44] = [None; 44];
    for i in 0..notes.len() {
        let n = notes[i];
        if !(53..=96).contains(&n.pitch) || n.end - n.start < 0.080
            || i > 0 && n.start - notes[i-1].start < 0.030
            || notes.get(i+1).is_some_and(|k| k.start - n.start < 0.030) { continue; }
        if piano.get(piano.partition_point(|&(_, end)| end <= n.start)).is_some_and(|&(a, _)| a <= n.start)
            || vocals.binary_search_by(|v| v.start.total_cmp(&n.start)).is_ok() { continue; }
        // align() may already have moved this key up to 16.5 ms later.
        let j = instrumental.partition_point(|k| k.start < n.start - 0.017);
        if !instrumental[j..].iter().take_while(|k| k.start <= n.start).any(|k| k.pitch == n.pitch) { continue; }
        let Some(db) = residual(wave, n, &window) else { continue };
        let slot = &mut pending[usize::from(n.pitch - 53)];
        let before = slot.take().and_then(|prev| {
            let near = n.start - notes[prev.index].start <= 4.0;
            prev.apply(notes, near.then_some(db));
            near.then_some(prev.db)
        });
        *slot = Some(Repeat { index: i, db, before });
    }
    for last in pending.into_iter().flatten() { last.apply(notes, None); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;

    #[test]
    fn late_pluck_moves_but_block_chords_and_sustained_tones_do_not() {
        let tone = |t: f32| (std::f32::consts::TAU * 440. * t).sin();
        let rate = SAMPLE_RATE as usize;
        let wave: Vec<_> = (0..rate*2).map(|i| {
            let t = i as f32 / rate as f32;
            if (0.32..0.50).contains(&t) || t >= 0.72 { tone(t) } else { 0.0 }
        }).collect();
        let mut midi = PrettyMidi::new(960, 120.0);
        let mut right = Instrument::new(0, false, "Right");
        for start in [0.3, 0.7, 1.0] { right.notes.push(Note { pitch: 69, start, end: start+0.15, velocity: 70 }); }
        let mut left = Instrument::new(0, false, "Left");
        left.notes.push(Note { pitch: 45, start: 0.7, end: 0.9, velocity: 64 });
        midi.instruments.extend([right, left]);
        align(&mut midi, &wave, &[], &[]);
        let keys = &midi.instruments[0].notes;
        assert!((0.305..0.317).contains(&keys[0].start));
        assert_eq!((keys[0].end, keys[1].start, keys[2].start), (0.3+0.15, 0.7, 1.0));
    }

    #[test]
    fn repeated_plucks_keep_the_recorded_accent_without_accenting_a_vocal_or_piano() {
        let starts = [0.2, 0.7, 1.2, 1.7];
        let keys: Vec<_> = starts.map(|start| Note { pitch: 69, start, end: start+0.16, velocity: 80 }).into();
        let wave = (0..2*SAMPLE_RATE).map(|i| {
            let t = f64::from(i) / f64::from(SAMPLE_RATE);
            starts.iter().zip([0.08, 0.3, 0.01, 0.01]).find(|(s, _)| (**s..**s+0.16).contains(&t))
                .map_or(0.0, |(_, gain)| gain * (std::f64::consts::TAU * 440.0 * t).sin() as f32)
        }).collect::<Vec<_>>();
        let mut midi = PrettyMidi::new(960, 120.);
        let mut hand = Instrument::new(0, false, "Right");
        hand.notes.clone_from(&keys);
        midi.instruments.push(hand);
        accent_repeats(&mut midi, &wave, &keys, &keys[2..3], &[(1.6, 2.)]);
        let out = &midi.instruments[0].notes;
        assert!(out[0].velocity < 80 && out[1].velocity > 80);
        assert_eq!(out[2..], keys[2..]);
    }
}
