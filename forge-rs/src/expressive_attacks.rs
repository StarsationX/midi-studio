//! An instrumental detector can anticipate a pluck. Trust a later onset only
//! when the same key actually swells in the pitched backing, not in the drums.
use crate::{basicpitch::SAMPLE_RATE, pmidi::{Note, PrettyMidi}};

// 32 ms Hann window, sampled every 4 ms on the existing 22.05 kHz detector input.
const WIDTH: usize = 706;
const HOP: usize = 88;
const SIDE: usize = 18;
const FRAMES: usize = 2 * SIDE + 1;

fn audible_attack(wave: &[f32], note: &Note, hann: &[f32; WIDTH]) -> Option<f64> {
    let sample = (note.start * f64::from(SAMPLE_RATE) / HOP as f64).round() as usize * HOP;
    let first = sample.checked_sub(SIDE * HOP + WIDTH / 2)?;
    let block = wave.get(first..first + WIDTH + (FRAMES - 1) * HOP)?;
    let omega = std::f32::consts::TAU * 440.0 * 2.0_f32.powf((f32::from(note.pitch) - 69.0) / 12.0) / SAMPLE_RATE as f32;
    let coeff = [1.0, 2.0, 3.0].map(|h| 2.0 * (omega * h).cos());
    let mut env = [0.0; FRAMES];
    for (frame, loud) in env.iter_mut().enumerate() {
        // Three Goertzel bins instead of a song-sized spectrogram. Require
        // power at the played pitch; harmonics contribute progressively less.
        let (mut a, mut b) = ([0.0_f32; 3], [0.0_f32; 3]);
        for (&s, &w) in block[frame * HOP..][..WIDTH].iter().zip(hann) {
            let x = s * w;
            for k in 0..3 {
                let next = x + coeff[k] * a[k] - b[k];
                b[k] = a[k];
                a[k] = next;
            }
        }
        for (k, weight) in [1.0, 0.45, 0.25].into_iter().enumerate() {
            *loud += weight * (a[k]*a[k] + b[k]*b[k] - coeff[k]*a[k]*b[k]).max(0.0).sqrt();
        }
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
    let hann = std::array::from_fn(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos());
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
}
