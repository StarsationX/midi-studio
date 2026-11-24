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

/// Resolve a dominant overtone only when other peaks share its proposed
/// fundamental. A loud fifth or octave on its own is not a bass note below it.
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
    let Some((dominant, level)) = peak(bin, 1.064) else {
        return candidate;
    };
    let partial = |bin, fraction| peak(bin, 1.019).filter(|&(_, a)| a >= level * fraction);
    let pitch = |mut bins: [f32; 3]| {
        bins.sort_unstable_by(f32::total_cmp);
        let hz = bins[1] * RATE as f32 / FFT as f32;
        (69. + 12. * (hz / 440.).log2()).round() as i16
    };

    if candidate >= 42 {
        let root = dominant / 3.;
        // Partials 2 and 4 could both belong to a note a fifth below the
        // dominant. Require a peak unique to the deeper series as well.
        if let Some((second, _)) = partial(root * 2., 0.20) {
            if let Some((fourth, _)) = partial(root * 4., 0.12) {
                if partial(root, 0.07).is_some() || partial(root * 5., 0.07).is_some() {
                    return pitch([second / 2., root, fourth / 4.]);
                }
            }
        }
    }

    let root = dominant / 2.;
    if let Some((third, amp3)) = partial(root * 3., 0.04) {
        // A pickup can nearly cancel either odd partial. Require both
        // peaks above the Hann sidelobes, but judge their power together.
        if let Some((first, amp1)) = partial(root, 0.05) {
            if amp1 * amp1 + amp3 * amp3 >= 0.09 * level * level {
                return pitch([first, root, third / 3.]);
            }
        }
        if amp3 >= level * 0.24 {
            if let Some((fourth, _)) = partial(root * 4., 0.10) {
                return pitch([root, third / 3., fourth / 4.]);
            }
        }
    }
    candidate
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

    #[test]
    fn strong_third_or_second_still_belongs_to_the_same_bass_key() {
        for amps in [[0.20, 0.42, 1., 0.28], [0.40, 1., 0.26, 0.04]] {
            let wave: Vec<_> = (0..RATE)
                .map(|i| {
                    let phase = std::f32::consts::TAU * 38.9 * i as f32 / RATE as f32;
                    amps.iter()
                        .enumerate()
                        .map(|(h, a)| a * ((h + 1) as f32 * phase).sin())
                        .sum()
                })
                .collect();
            let (labels, _, _) = scan_bass(&wave);
            assert!(labels[15..85].iter().all(|&p| p == 27), "{labels:?}");
        }
    }

    #[test]
    fn uneven_odd_partials_can_establish_an_octave_but_weak_leakage_cannot() {
        // A dominant second partial at bin 80 is MIDI 46. The lower
        // fundamental (34) and its third partial are at bins 40 and 120.
        for (first, third, expected) in [(0.65, 0.06, 34), (0.07, 0.36, 34), (0.07, 0.06, 46)] {
            let mut mag = vec![0.; FFT / 2 + 1];
            mag[40] = first;
            mag[80] = 1.;
            mag[120] = third;
            assert_eq!(bass_fundamental(&mag, 46), expected);
        }
    }

    #[test]
    fn fifth_and_its_octave_do_not_establish_a_deeper_fundamental() {
        let mut mag = vec![0.; FFT / 2 + 1];
        // Candidate 46 at bin 81, accompanied by a fifth below (54)
        // and that fifth's octave (108). No peak at bin 27 or 135.
        for (bin, level) in [(81, 1.), (54, 0.45), (108, 0.25)] {
            mag[bin] = level;
        }
        assert_eq!(bass_fundamental(&mag, 46), 46);
    }

    #[test]
    fn shallow_dip_needs_a_new_attack_not_a_slow_swell() {
        let mut envelope = [1.; 48];
        envelope[20..25].copy_from_slice(&[0.8, 0.65, 0.55, 0.72, 0.97]);
        assert_eq!(restrikes(&envelope, 0, 48, 1.), [0, 23, 48]);
        envelope[23..29].copy_from_slice(&[0.57, 0.61, 0.66, 0.74, 0.84, 0.94]);
        assert_eq!(restrikes(&envelope, 0, 48, 1.), [0, 48]);
    }

    #[test]
    fn damped_release_precedes_the_next_attack_but_a_quiet_sustain_does_not() {
        let mut env = [1.; 40];
        env[20..30].copy_from_slice(&[0.82, 0.54, 0.24, 0.09, 0.07, 0.06, 0.06, 0.07, 0.12, 0.25]);
        assert_eq!(damped_release(&env, 0, 30, 1.), 22);
        env[23..29].fill(0.22);
        assert_eq!(damped_release(&env, 0, 30, 1.), 30);
        env[16..26].copy_from_slice(&[0.68, 0.62, 0.57, 0.52, 0.48, 0.44, 0.40, 0.35, 0.30, 0.25]);
        env[26..30].fill(0.10);
        assert_eq!(damped_release(&env, 0, 30, 1.), 30);
    }

    #[test]
    fn apply_damping_only_to_the_original_written_bass_key() {
        use crate::pmidi::{Instrument, PrettyMidi};
        let bass = |start| Note { start, end: start + 0.5, pitch: 36, velocity: 60 };
        let line = BassLine {
            notes: (0..4).map(|t| bass(t as f64)).collect(),
            strokes: (0..4).map(|t| Stroke { residual_db: t as f32 * 5., end: t as f64 + 0.4 }).collect(),
        };
        let mut left = Instrument::new(0, false, "Left");
        left.notes = vec![
            bass(0.), Note { pitch: 43, ..bass(0.) }, // chord partner
            bass(1.), // piano passage
            Note { end: 2.3, ..bass(2.) }, // already clipped
            Note { pitch: 24, ..bass(3.) }, // octave-folded
        ];
        let mut midi = PrettyMidi::new(960, 120.);
        midi.instruments.push(Instrument::new(0, false, "Right"));
        midi.instruments.push(left);
        line.articulate(&mut midi, &[(1., 2.)]);
        let ends: Vec<_> = midi.instruments[1].notes.iter().map(|n| n.end).collect();
        assert_eq!(ends, [0.4, 0.5, 1.5, 2.3, 3.5]);
        let velocity: Vec<_> = midi.instruments[1].notes.iter().map(|n| n.velocity).collect();
        assert!(velocity[0] < 60);
        assert_eq!(velocity[1..], [60; 4]);
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
        let valley = smooth[v];
        let shoulders = before.min(after);
        if after < 0.12 * reference || valley > 0.60 * shoulders {
            continue;
        }
        // A ringing string need not go quiet before the next pluck. For
        // shallower valleys insist on a comparable, fast attack (30 ms);
        // gradual swells during a held note must not create extra strikes.
        if valley > 0.40 * shoulders
            && (after < 0.65 * before
                || !smooth[v + 1..=v + 3]
                    .iter()
                    .any(|&x| x > valley + 0.75 * (after - valley)))
        {
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

// A pitch window can ring across a mute, or keep a note tied until the
// next pluck. Only move the release on a fast level drop into a quiet trough.
fn damped_release(smooth: &[f32], frame: usize, release: usize, level: f32) -> usize {
    if release - frame < 10 {
        return release;
    }
    let start = (frame + 8).max(release.saturating_sub(10)) - 1;
    let Some(last_loud) = smooth[start..release].iter().rposition(|&x| x >= 0.50 * level) else {
        return release;
    };
    let fall = start + last_loud + 1;
    let until = (fall + 6).min(release + 3).min(smooth.len());
    if fall < release && smooth[fall - 3..fall].iter().any(|&x| x >= 0.75 * level)
        && smooth[fall..until].windows(2).any(|w| w[0].max(w[1]) <= 0.15 * level)
    {
        fall
    } else {
        release
    }
}

pub fn bass_notes(mono: &[f32], sample_rate: u32) -> Result<Vec<Note>> {
    detect_bass(mono, sample_rate, |_, _| {})
}

struct Stroke {
    // Recorded attack power minus the nominal piano velocity, both in dB.
    residual_db: f32,
    end: f64,
}

/// Pitch occupancy is evidence for harmony and voicing. Physical damping is
/// articulation of the written bass key, not permission to revoice its chord.
pub(crate) struct BassLine {
    pub(crate) notes: Vec<Note>,
    strokes: Vec<Stroke>,
}

impl BassLine {
    pub(crate) fn articulate(&self, midi: &mut crate::pmidi::PrettyMidi, piano: &[(f64, f64)]) {
        let Some(hand) = midi.instruments.get_mut(1) else { return };
        for (i, (&n, stroke)) in self.notes.iter().zip(&self.strokes).enumerate() {
            let section = piano.partition_point(|&(_, stop)| stop <= n.start);
            if piano.get(section).is_some_and(|&(start, _)| start <= n.start) { continue; }
            let first = hand.notes.partition_point(|k| k.start < n.start);
            // Exact copied fields distinguish the original bass from a folded
            // key, a chord partner or a note already clipped for playability.
            if let Some(key) = hand.notes[first..].iter_mut().take_while(|k| k.start == n.start)
                .find(|k| k.pitch == n.pitch && k.end == n.end)
            {
                key.end = stroke.end;
                // Compare nearby plucks, not absolute stem volume. This keeps
                // phrase-level dynamics and makes the touch mastering-independent.
                let mut nearby = [0.0; 9];
                let lo = i.saturating_sub(4);
                let hi = (i + 5).min(self.notes.len());
                let mut count = 0;
                for (other, played) in self.notes[lo..hi].iter().zip(&self.strokes[lo..hi]) {
                    if (other.start - n.start).abs() <= 2.0 {
                        nearby[count] = played.residual_db;
                        count += 1;
                    }
                }
                if count > 1 {
                    nearby[..count].sort_unstable_by(f32::total_cmp);
                    let anchor = (nearby[count / 2] + nearby[(count - 1) / 2]) * 0.5;
                    let db = (0.55 * (stroke.residual_db - anchor)).clamp(-4., 2.5);
                    key.velocity = (f32::from(key.velocity) * 10.0_f32.powf(db / 25.)).round().clamp(1., 127.) as u8;
                }
            }
        }
    }
}

pub(crate) fn bass_line(mono: &[f32], sample_rate: u32) -> Result<BassLine> {
    let mut strokes = Vec::new();
    let rate = f64::from(sample_rate);
    let notes = detect_bass(mono, sample_rate, |n, end| {
        let from = (n.start * rate).round() as usize;
        let to = ((n.end.min(n.start + 0.16) * rate).round() as usize).min(mono.len());
        let samples = &mono[from.min(to)..to];
        let power = samples.iter().map(|&x| f64::from(x) * f64::from(x)).sum::<f64>() / samples.len().max(1) as f64;
        let residual_db = (10. * power.max(1e-10).log10() - 25. * f64::from(n.velocity).log10()) as f32;
        strokes.push(Stroke { residual_db, end });
    })?;
    Ok(BassLine { notes, strokes })
}

fn detect_bass(mono: &[f32], sample_rate: u32, mut on_note: impl FnMut(Note, f64)) -> Result<Vec<Note>> {
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
                let damped = damped_release(&smooth, frame, release, level);
                let note = Note {
                    pitch: keys[a] as u8,
                    start: begin,
                    end: (release as f64 * 0.01).min(audio.len() as f64 / RATE as f64),
                    velocity: (51. + 19. * (level / reference).min(1.)).round() as u8,
                };
                on_note(note, note.end.min(damped as f64 * 0.01));
                notes.push(note);
            }
        }
        a = b;
    }
    Ok(notes)
}
