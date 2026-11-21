use crate::{pmidi::Note, resample::resample_hq};
use anyhow::{ensure, Result};
use realfft::RealFftPlanner;

const RATE: usize = 11025;
const WINDOW: usize = 3072;
const FFT: usize = 4096;
const HOP: usize = 256;
type Chroma = [f32; 12];

// Inversions share one mask. Triad templates propose voices only when all
// three pitch classes have independent spectral support.
fn triads() -> Vec<(u16, usize, f32)> {
    let mut masks = Vec::new();
    for root in 0..12 {
        for shape in [[0, 4, 7], [0, 3, 7], [0, 3, 6], [0, 5, 7], [0, 4, 8]] {
            let mask = shape
                .iter()
                .fold(0, |bits, interval| bits | 1 << ((root + interval) % 12));
            if !masks.iter().any(|&(existing, _, _)| existing == mask) {
                // A suspended or altered triad needs stronger evidence. In a
                // busy mix a passing note can briefly obscure a major third.
                let penalty = if matches!(shape, [0, 4, 7] | [0, 3, 7]) {
                    0.
                } else {
                    0.06
                };
                masks.push((mask, root, penalty));
            }
        }
    }
    masks
}

fn chroma(mag: &[f32]) -> Chroma {
    let mut pitch = [0f32; 128];
    let mut bands = [0.; 12];
    let mut energy = 0.;
    let mut tonal = 0.;
    for bin in 28..1250 {
        let value = mag[bin];
        energy += value * value;
        if value < 0.001 || value <= mag[bin - 1] || value < mag[bin + 1] {
            continue;
        }
        let left = mag[bin - 1].max(1e-12).ln();
        let mid = value.ln();
        let right = mag[bin + 1].max(1e-12).ln();
        let curvature = left + right - 2. * mid;
        if curvature >= -0.004 {
            continue;
        }
        let offset = (0.5 * (left - right) / curvature).clamp(-0.5, 0.5);
        let hz = (bin as f32 + offset) * RATE as f32 / FFT as f32;
        let midi = 69. + 12. * (hz / 440.).log2();
        let distance = (midi - midi.round()).abs();
        if distance > 0.41 {
            continue;
        }
        let prominence = (value - (mag[bin - 3] + mag[bin + 3]) * 0.32).max(0.);
        let strength = prominence * (1. - 1.3 * distance * distance);
        let key = midi.round() as usize;
        pitch[key] = pitch[key].max(strength);
        tonal += strength * strength;
    }
    if tonal < 0.12 * energy || energy < 0.001 {
        return bands;
    }
    // Peel harmonics from lower notes before folding octaves. Otherwise a
    // bright solo note supplies its own fifth and major third.
    for key in 38..=95 {
        let value = pitch[key];
        for (interval, weight) in [
            (12, 0.55),
            (19, 0.43),
            (24, 0.32),
            (28, 0.26),
            (31, 0.21),
            (34, 0.16),
            (36, 0.14),
        ] {
            if let Some(partial) = pitch.get_mut(key + interval) {
                *partial = (*partial - value * weight).max(0.);
            }
        }
        if (47..=89).contains(&key) {
            bands[key % 12] += value * if (52..=79).contains(&key) { 1. } else { 0.60 };
        }
    }
    bands
}

fn classify(bands: &Chroma, masks: &[(u16, usize, f32)], previous: u16, bass: &Chroma) -> u16 {
    let sum: f32 = bands.iter().sum();
    if sum <= 1e-5 {
        return 0;
    }
    let max = bands.iter().copied().fold(0., f32::max);
    let mut best = (0., 0);
    for &(mask, root, penalty) in masks {
        let mut support = 0.;
        let mut weakest = max;
        let mut bass_support = 0.;
        for (i, &strength) in bands.iter().enumerate() {
            if mask & (1 << i) != 0 {
                support += strength;
                weakest = weakest.min(strength);
                bass_support += bass[i] * if i == root { 0.12 } else { 0.04 };
            }
        }
        // The low line often anchors an ordinary triad. Altered shapes and
        // pedals over unrelated harmonies still need backing-spectrum support.
        let prior = if penalty > 0. {
            bass_support * 0.1
        } else {
            bass_support
        };
        if weakest < max * 0.18 || support + prior * sum < 0.43 * sum {
            continue;
        }
        let score = support + sum * (prior + if mask == previous { 0.06 } else { 0. } - penalty);
        if score > best.0 {
            best = (score, mask);
        }
    }
    best.1
}

/// Extract source-timed evidence for inner harmony from a pitched backing stem.
pub fn harmony_notes(mono: &[f32], sample_rate: u32, bass: &[Note]) -> Result<Vec<Note>> {
    ensure!(sample_rate > 0, "invalid backing sample rate");
    if mono.is_empty() {
        return Ok(Vec::new());
    }
    let samples = resample_hq(mono, 1, sample_rate as f64, RATE as f64)?;
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT);
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let mut mag = vec![0.; output.len()];
    let window: Vec<_> = (0..WINDOW)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WINDOW - 1) as f32).cos())
        .collect();
    let mut padded = vec![0.; samples.len() + WINDOW];
    padded[WINDOW / 2..WINDOW / 2 + samples.len()].copy_from_slice(&samples);
    let mut frames = Vec::with_capacity(samples.len().div_ceil(HOP));
    for center in (0..samples.len()).step_by(HOP) {
        input.fill(0.);
        for (i, w) in window.iter().enumerate() {
            input[i] = padded[center + i] * w;
        }
        fft.process_with_scratch(&mut input, &mut output, &mut scratch)?;
        for (dst, bin) in mag.iter_mut().zip(&output) {
            *dst = bin.norm();
        }
        frames.push(chroma(&mag));
    }
    let masks = triads();
    let step = HOP as f64 / RATE as f64;
    // Smooth the spectrum in time before looking at bass compatibility.
    let pooled: Vec<Chroma> = (0..frames.len())
        .map(|i| {
            let neighborhood = &frames[i.saturating_sub(8)..(i + 9).min(frames.len())];
            let mut sum = [0.; 12];
            for frame in neighborhood {
                for (total, v) in sum.iter_mut().zip(frame) {
                    *total += v;
                }
            }
            sum
        })
        .collect();
    let mut labels = Vec::with_capacity(frames.len());
    let mut previous = 0;
    for i in 0..frames.len() {
        let t = i as f64 * step;
        let mut bands = pooled[i];
        let mut bass_weights = [0.; 12];
        let first = bass.partition_point(|n| n.end <= t - 0.18);
        for n in bass[first..].iter().take_while(|n| n.start < t + 0.18) {
            let overlap = n.end.min(t + 0.18) - n.start.max(t - 0.18);
            bass_weights[(n.pitch % 12) as usize] += (overlap / 0.36) as f32;
            // Pool evidence within a held bass note, capped at 0.4 seconds
            // either side so that the harmony can still change over a pedal.
            if n.end - n.start >= 0.26 && n.start <= t && t < n.end {
                let lo = i.saturating_sub(17).max((n.start / step).ceil() as usize);
                let hi = (i + 18)
                    .min((n.end / step).ceil() as usize)
                    .min(pooled.len());
                let mut held = [0.; 12];
                for frame in &pooled[lo..hi] {
                    for (v, f) in held.iter_mut().zip(frame) {
                        *v += f;
                    }
                }
                let scale = bands.iter().sum::<f32>() / held.iter().sum::<f32>().max(1e-9);
                for (v, h) in bands.iter_mut().zip(held) {
                    *v = 0.25 * *v + 0.75 * scale * h;
                }
            }
        }
        for w in &mut bass_weights {
            *w = ((*w - 0.35) / 0.65).clamp(0., 1.);
        }
        let near = &frames[i.saturating_sub(1)..(i + 2).min(frames.len())];
        let local: f32 = near.iter().flatten().sum::<f32>() / near.len() as f32;
        let count = (i + 9).min(frames.len()) - i.saturating_sub(8);
        let mean: f32 = pooled[i].iter().sum::<f32>() / count as f32;
        previous = if local > 0.16 * mean {
            classify(&bands, &masks, previous, &bass_weights)
        } else {
            0
        };
        labels.push(previous);
    }
    let mut i = 1;
    while i + 1 < labels.len() {
        let start = i;
        while i < labels.len() && labels[i] == labels[start] {
            i += 1;
        }
        if i < labels.len() && i - start <= 3 && labels[start - 1] == labels[i] {
            let neighbor = labels[i];
            labels[start..i].fill(neighbor);
        }
    }
    let duration = mono.len() as f64 / sample_rate as f64;
    let mut notes = Vec::new();
    let mut start = 0;
    while start < frames.len() {
        let mask = labels[start];
        let mut end = start + 1;
        while end < frames.len() && labels[end] == mask {
            end += 1;
        }
        if mask != 0 && end - start >= 8 {
            let mut levels = [0.; 12];
            for frame in &frames[start..end] {
                for (pc, level) in frame.iter().enumerate() {
                    levels[pc] += level;
                }
            }
            let peak = levels.iter().copied().fold(1e-9, f32::max);
            for (pc, level) in levels.iter().enumerate() {
                if mask & (1 << pc) == 0 {
                    continue;
                }
                notes.push(Note {
                    pitch: 60 + pc as u8,
                    velocity: 43 + (9. * level / peak).round() as u8,
                    start: (start as f64 * step - step * 0.5).max(0.),
                    end: (end as f64 * step - step * 0.5).min(duration),
                });
            }
        }
        start = end;
    }
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tones(changes: &[(f32, &[u8])], end: f32) -> Vec<f32> {
        (0..(end * RATE as f32) as usize)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let &(onset, keys) = changes.iter().rev().find(|(at, _)| *at <= t).unwrap();
                keys.iter()
                    .map(|&k| {
                        let phase = (t - onset)
                            * 440.
                            * 2f32.powf((k as f32 - 69.) / 12.)
                            * std::f32::consts::TAU;
                        (1..=7)
                            .map(|h| (phase * h as f32).sin() / h as f32)
                            .sum::<f32>()
                            * 0.08
                    })
                    .sum()
            })
            .collect()
    }

    #[test]
    fn inversion_and_chord_change_keep_source_time() {
        let audio = tones(
            &[
                (0., &[]),
                (0.45, &[52, 55, 60]),
                (1.48, &[50, 57, 65]),
                (2.48, &[]),
            ],
            3.,
        );
        // The pedal is an inversion. A brief unrelated passing bass tone
        // between the two chords must not replace either voicing.
        let bass = [
            Note {
                start: 0.45,
                end: 1.36,
                pitch: 40,
                velocity: 62,
            },
            Note {
                start: 1.36,
                end: 1.48,
                pitch: 42,
                velocity: 62,
            },
            Note {
                start: 1.48,
                end: 2.48,
                pitch: 41,
                velocity: 62,
            },
        ];
        let notes = harmony_notes(&audio, RATE as u32, &bass).unwrap();
        assert_eq!(notes.len(), 6, "{notes:?}");
        for (part, onset, end, keys) in [
            (&notes[..3], 0.45, 1.48, [60, 64, 67]),
            (&notes[3..], 1.48, 2.48, [62, 65, 69]),
        ] {
            for (n, k) in part.iter().zip(keys) {
                assert_eq!(n.pitch, k);
                assert!(
                    (n.start - onset).abs() < 0.14 && (n.end - end).abs() < 0.14,
                    "{n:?}"
                );
            }
        }
    }

    #[test]
    fn lone_bright_notes_noise_and_silence_do_not_form_chords() {
        let solo = tones(&[(0., &[55]), (0.65, &[62]), (1.23, &[67])], 2.);
        let bass = [Note {
            start: 0.,
            end: 2.,
            pitch: 43,
            velocity: 65,
        }];
        assert!(harmony_notes(&solo, RATE as u32, &bass).unwrap().is_empty());
        let mut seed = 131u32;
        let noise = (0..RATE * 2)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed as f32 / u32::MAX as f32 - 0.5) * 0.3
            })
            .collect::<Vec<_>>();
        assert!(harmony_notes(&noise, RATE as u32, &bass)
            .unwrap()
            .is_empty());
        assert!(harmony_notes(&vec![0.; RATE], RATE as u32, &bass)
            .unwrap()
            .is_empty());
    }
}
