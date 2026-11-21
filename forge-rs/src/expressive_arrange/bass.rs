use crate::{dsp::percentile_f32, pmidi::Note, resample::resample_hq};
use anyhow::{ensure, Result};
use realfft::RealFftPlanner;

const RATE: usize = 6000;
const HOP: usize = 60;
const FFT: usize = 4096;
const HALF: usize = 480;

struct Harmonic {
    center: usize,
    width: usize,
    weight: f32,
}

fn pitch_templates() -> Vec<Vec<Harmonic>> {
    (24..=60)
        .map(|key| {
            let frequency = 440. * 2f64.powf((key as f64 - 69.) / 12.);
            (1..=6)
                .map(|h| {
                    let bin = frequency * h as f64 * FFT as f64 / RATE as f64;
                    Harmonic {
                        center: bin.round() as usize,
                        width: (bin * 0.025).round().max(1.) as usize,
                        weight: if h == 1 { 1.35 } else { (h as f32).powf(-0.67) },
                    }
                })
                .collect()
        })
        .collect()
}

/// A weak bass fundamental can leave its second harmonic as the winning
/// template. Confirm the lower octave with an odd partial at 3/2 and a
/// fourth partial at twice that strong peak before changing the note.
fn bass_fundamental(mag: &[f32], candidate: i16) -> i16 {
    if candidate < 35 {
        return candidate;
    }
    let bin = 440. * 2f32.powf((candidate as f32 - 69.) / 12.) * FFT as f32 / RATE as f32;
    let peak = |center: f32, tolerance: f32| -> Option<(f32, f32)> {
        let lo = (center / tolerance).floor().max(2.) as usize;
        let hi = (center * tolerance).ceil().min((mag.len() - 2) as f32) as usize;
        let k = (lo..=hi)
            .filter(|&i| mag[i] > mag[i - 1] && mag[i] >= mag[i + 1])
            .max_by(|&a, &b| mag[a].total_cmp(&mag[b]))?;
        let a = mag[k - 1].max(1e-15).ln();
        let b = mag[k].max(1e-15).ln();
        let c = mag[k + 1].max(1e-15).ln();
        let curvature = a - 2. * b + c;
        if curvature >= -1e-5 {
            return None;
        }
        let location = k as f32 + ((a - c) / (2. * curvature)).clamp(-0.5, 0.5);
        (location >= center / tolerance && location <= center * tolerance)
            .then_some((location, mag[k]))
    };
    let Some((second, level)) = peak(bin, 1.064) else {
        return candidate;
    };
    let Some((third, level3)) = peak(second * 1.5, 1.019) else {
        return candidate;
    };
    let Some((fourth, level4)) = peak(second * 2., 1.019) else {
        return candidate;
    };
    if level3 < level * 0.24 || level4 < level * 0.10 {
        return candidate;
    }
    let mut fundamentals = [second / 2., third / 3., fourth / 4.];
    fundamentals.sort_by(f32::total_cmp);
    let hz = fundamentals[1] * RATE as f32 / FFT as f32;
    (69. + 12. * (hz / 440.).log2()).round() as i16
}

fn scan_bass(mono: &[f32]) -> (Vec<i16>, Vec<f32>, Vec<f32>) {
    let bank = pitch_templates();
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT);
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let mut magnitudes = vec![0.; output.len()];
    let mut padded = vec![0.; HALF + mono.len() + HALF];
    padded[HALF..HALF + mono.len()].copy_from_slice(mono);
    let window: Vec<_> = (0..2 * HALF)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (2 * HALF - 1) as f32).cos())
        .collect();
    let count = mono.len().div_ceil(HOP);
    let mut labels = Vec::with_capacity(count);
    let mut power = Vec::with_capacity(count);
    let mut energy = Vec::with_capacity(count);
    for at in (0..mono.len()).step_by(HOP) {
        input.fill(0.);
        for (i, w) in window.iter().enumerate() {
            input[i] = w * padded[at + i];
        }
        fft.process_with_scratch(&mut input, &mut output, &mut scratch)
            .unwrap();
        for (mag, z) in magnitudes.iter_mut().zip(&output) {
            *mag = z.norm();
        }
        let mut best = (0, 0.);
        for (pitch, harmonics) in bank.iter().enumerate() {
            let mut strength = 0.;
            for h in harmonics {
                let c = h.center;
                let w = h.width;
                let peak = magnitudes[c - w..=c + w].iter().copied().fold(0., f32::max);
                let shoulders = (magnitudes[c.saturating_sub(2 * w + 1).max(1)]
                    + magnitudes[c + 2 * w + 1])
                    * 0.5;
                strength += h.weight * (peak - 0.68 * shoulders).max(0.);
            }
            if strength > best.1 {
                best = (pitch, strength);
            }
        }
        labels.push(bass_fundamental(&magnitudes, best.0 as i16 + 24));
        power.push(best.1);
        energy.push(
            (padded[at + HALF - 100..at + HALF + 100]
                .iter()
                .map(|x| x * x)
                .sum::<f32>()
                / 200.)
                .sqrt(),
        );
    }
    (labels, power, energy)
}

#[cfg(test)]
mod fundamental_tests {
    use super::*;

    #[test]
    fn dominant_second_and_odd_partial_recover_low_bass_pitch() {
        for (fundamental, expected) in [(44.2, 29), (51.7, 32)] {
            let wave: Vec<_> = (0..RATE)
                .map(|i| {
                    let phase = std::f32::consts::TAU * fundamental * i as f32 / RATE as f32;
                    0.025 * phase.sin()
                        + 0.6 * (2. * phase).sin()
                        + 0.36 * (3. * phase).sin()
                        + 0.22 * (4. * phase).sin()
                })
                .collect();
            let (labels, _, _) = scan_bass(&wave);
            assert!(labels[15..85].iter().all(|&p| p == expected), "{labels:?}");
        }
        let wave: Vec<_> = (0..RATE)
            .map(|i| {
                let phase = std::f32::consts::TAU * 87.3 * i as f32 / RATE as f32;
                0.6 * phase.sin() + 0.22 * (2. * phase).sin()
            })
            .collect();
        let (labels, _, _) = scan_bass(&wave);
        assert!(labels[15..85].iter().all(|&p| p == 41), "{labels:?}");
    }
}

fn restrikes(smooth: &[f32], a: usize, b: usize, reference: f32) -> Vec<usize> {
    let mut cuts = vec![a];
    for v in a + 8..b.saturating_sub(7) {
        let last = *cuts.last().unwrap();
        if v < last + 8 || smooth[v] > smooth[v - 1] || smooth[v] >= smooth[v + 1] {
            continue;
        }
        let before = smooth[last.max(v.saturating_sub(28))..v]
            .iter()
            .copied()
            .fold(0., f32::max);
        let after = smooth[v + 1..b.min(v + 8)]
            .iter()
            .copied()
            .fold(0., f32::max);
        if smooth[v] > 0.40 * before.min(after) || after < 0.12 * reference {
            continue;
        }
        let threshold = smooth[v] + 0.25 * (after - smooth[v]);
        if let Some(attack) = (v..b.min(v + 8)).find(|&i| smooth[i] > threshold) {
            if attack >= last + 9 && b >= attack + 8 {
                cuts.push(attack);
            }
        }
    }
    cuts.push(b);
    cuts
}

pub fn bass_notes(mono: &[f32], sample_rate: u32) -> Result<Vec<Note>> {
    ensure!(sample_rate > 0, "Bass sample rate must be positive");
    if mono.is_empty() {
        return Ok(vec![]);
    }
    let downsampled;
    let audio = if sample_rate as usize == RATE {
        mono
    } else {
        downsampled = resample_hq(mono, 1, sample_rate as f64, RATE as f64)?;
        &downsampled
    };
    if audio.is_empty() {
        return Ok(vec![]);
    }
    let (labels, power, energy) = scan_bass(audio);
    let reference =
        percentile_f32(&energy, 94.).max(0.12 * energy.iter().copied().fold(0., f32::max));
    if reference < 0.0005 {
        return Ok(vec![]);
    }
    let floor = percentile_f32(&power, 92.) * 0.035;
    let count = labels.len();
    let mut keys = Vec::with_capacity(count);
    let mut smooth = Vec::with_capacity(count);
    for i in 0..count {
        let mut nearby =
            std::array::from_fn::<_, 7, _>(|n| labels[(i + n).saturating_sub(3).min(count - 1)]);
        nearby.sort_unstable();
        keys.push(if energy[i] < reference * 0.055 || power[i] < floor {
            -1
        } else {
            nearby[3]
        });
        let mut levels = [
            energy[i.saturating_sub(1)],
            energy[i],
            energy[(i + 1).min(count - 1)],
        ];
        levels.sort_unstable_by(f32::total_cmp);
        smooth.push(levels[1]);
    }
    let mut a = 0;
    while a < count {
        let mut b = a + 1;
        while b < count && keys[b] == keys[a] {
            b += 1;
        }
        if a > 0 && b < count && keys[a - 1] == keys[b] {
            let surrounding = keys[a - 1];
            // The weaker odd partial can disappear briefly around a pluck.
            // Keep its established pitch; the amplitude envelope still
            // determines whether a second attack occurred on the same key.
            let brief_octave = surrounding >= 0 && keys[a] == surrounding + 12 && b - a <= 10;
            if b - a <= 4 || brief_octave {
                keys[a..b].fill(surrounding);
            }
        }
        a = b;
    }
    let mut notes: Vec<Note> = vec![];
    a = 0;
    while a < count {
        let mut b = a + 1;
        while b < count && keys[b] == keys[a] {
            b += 1;
        }
        if keys[a] >= 0 && b - a >= 9 {
            for pair in restrikes(&smooth, a, b, reference).windows(2) {
                let (frame, release) = (pair[0], pair[1]);
                let mut begin = frame as f64 * 0.01;
                let level = percentile_f32(&energy[frame..release], 80.);
                let previous_end = notes.last().map_or(0., |n| n.end);
                if begin - previous_end >= 0.045 {
                    let search = frame
                        .saturating_sub(9)
                        .max((previous_end * 100.).round() as usize);
                    if frame >= search + 3 && smooth[search] < 0.12 * level {
                        if let Some(rise) = (search..=frame).find(|&i| smooth[i] >= 0.30 * level) {
                            begin = rise as f64 * 0.01;
                        }
                    }
                }
                notes.push(Note {
                    pitch: keys[a] as u8,
                    start: begin,
                    end: (release as f64 * 0.01).min(audio.len() as f64 / RATE as f64),
                    velocity: (51. + 19. * (level / reference).min(1.)).round() as u8,
                });
            }
        }
        a = b;
    }
    Ok(notes)
}
