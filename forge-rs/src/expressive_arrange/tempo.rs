use crate::dsp::percentile_f64;
use realfft::RealFftPlanner;

/// Keep a 10 ms spectral-flux envelope and one FFT frame of audio.
fn onsets(mono: &[f32], rate: u32) -> (Vec<f64>, f64) {
    let hop = ((rate as f64 / 100.).round() as usize).max(1);
    let width = 4 * hop;
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(width);
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let mut previous = vec![0f32; output.len()];
    let window: Vec<_> = (0..width)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (width - 1) as f32).cos())
        .collect();
    let mut envelope = Vec::with_capacity(mono.len() / hop);
    for frame in 0..mono.len() / hop {
        let end = (frame + 1) * hop;
        for (i, sample) in input.iter_mut().enumerate() {
            *sample = (end + i).checked_sub(width).map_or(0.0, |n| mono[n]) * window[i];
        }
        fft.process_with_scratch(&mut input, &mut output, &mut scratch)
            .unwrap();
        let mut rise = 0.;
        for (bin, old) in output.iter().zip(previous.iter_mut()) {
            let power = (bin.norm() * (100. / width as f32)).ln_1p();
            rise += (power - *old).max(0.);
            *old = power;
        }
        envelope.push(f64::from(rise) / output.len() as f64);
    }
    (envelope, rate as f64 / hop as f64)
}

fn correlation(window: &[f64], fps: f64) -> Vec<f64> {
    let mean = window.iter().sum::<f64>() / window.len() as f64;
    let centered: Vec<_> = window.iter().map(|v| v - mean).collect();
    let energy = centered.iter().map(|v| v * v).sum::<f64>().max(1e-11);
    let count = window.len().min((fps * 10.).ceil() as usize + 2);
    (0..count)
        .map(|lag| {
            centered[lag..]
                .iter()
                .zip(&centered)
                .map(|(x, y)| x * y)
                .sum::<f64>()
                / energy
        })
        .collect()
}

fn pulse(correlation: &[f64], fps: f64, bpm: f64) -> f64 {
    [(1., 0.36), (2., 0.29), (4., 0.23), (8., 0.12)]
        .into_iter()
        .map(|(n, weight)| {
            let lag = n * 60. * fps / bpm;
            let base = lag as usize;
            match correlation.get(base..base + 2) {
                Some(pair) => weight * (pair[0] + lag.fract() * (pair[1] - pair[0])),
                None => 0.,
            }
        })
        .sum()
}

fn part(envelope: &[f64], fps: f64, center: f64, radius: f64) -> &[f64] {
    let first = ((center - radius).max(0.) * fps).round() as usize;
    let last = ((center + radius) * fps).round() as usize;
    &envelope[first.min(envelope.len())..last.min(envelope.len())]
}

/// At a metrical change the incoming and outgoing pulse often share one
/// attack. Estimate their phases independently from surrounding subdivisions.
/// Weak or inconsistent phases leave the coarser periodicity estimate intact.
fn shared_pulse(env: &[f64], fps: f64, estimate: f64, old: f64, new: f64) -> f64 {
    let mut phases = vec![];
    let mut energy = 0.;
    for (bpm, start, end) in [
        (old, estimate - 11., estimate - 2.),
        (new, estimate + 2., estimate + 11.),
    ] {
        let first = (start.max(0.) * fps).ceil() as usize;
        let last = ((end * fps).ceil() as usize).min(env.len());
        if last <= first + (2. * fps) as usize {
            return estimate;
        }
        let mut moments = [(0., 0.); 2];
        let mut total = 0.;
        for i in first..last {
            let mut neighbors = std::array::from_fn::<_, 11, _>(|n| {
                env[(i + n).saturating_sub(5).min(env.len() - 1)]
            });
            neighbors.sort_unstable_by(f64::total_cmp);
            let weight = (env[i] - neighbors[5]).max(0.);
            total += weight;
            for (j, harmonic) in [2., 4.].into_iter().enumerate() {
                let angle = std::f64::consts::TAU * harmonic * bpm * i as f64 / (60. * fps);
                let (sin, cos) = angle.sin_cos();
                moments[j].0 += weight * cos;
                moments[j].1 += weight * sin;
            }
        }
        if total <= 1e-10 {
            return estimate;
        }
        let mut coherence = 0.;
        for ((x, y), harmonic) in moments.into_iter().zip([2., 4.]) {
            let (re, im) = (x / total, y / total);
            coherence += re.hypot(im);
            phases.push((std::f64::consts::TAU * harmonic * bpm / 60., re, im));
        }
        if coherence < 0.45 {
            return estimate;
        }
        energy += coherence;
    }
    let mut best = (estimate, f64::NEG_INFINITY);
    for step in -250..=250 {
        let t = estimate + f64::from(step) * 0.005;
        let value: f64 = phases
            .iter()
            .map(|(frequency, re, im)| {
                let (sin, cos) = (frequency * t).sin_cos();
                re * cos + im * sin
            })
            .sum();
        if value > best.1 {
            best = (t, value);
        }
    }
    let local = part(env, fps, best.0, 0.06);
    let context = part(env, fps, best.0, 1.);
    if best.1 >= 0.8 * energy
        && local.iter().copied().fold(0., f64::max) >= percentile_f64(context, 70.)
    {
        best.0
    } else {
        estimate
    }
}

struct TempoRun {
    first: f64,
    last: f64,
    bpms: Vec<f64>,
    peaked: usize,
}

/// Stable local periodicities, in source seconds and BPM. Empty means the
/// caller can retry the backing when a drum stem has no measurable pulse.
pub fn tempo_map(mono: &[f32], sample_rate: u32) -> Vec<(f64, f64)> {
    if sample_rate == 0 || mono.len() < 4 * sample_rate as usize {
        return vec![];
    }
    let (envelope, fps) = onsets(mono, sample_rate);
    if !envelope.iter().any(|&value| value > 0.00012) {
        return vec![];
    }
    let duration = envelope.len() as f64 / fps;
    let radius = 6f64.min(duration / 2.);
    let windows = (duration - radius * 2. + 0.01).floor() as usize + 1;
    let candidates: Vec<_> = (0..=656)
        .map(|i| {
            let bpm = 48. + i as f64 * 0.25;
            (bpm, (-0.16 * (bpm / 118.).log2().powi(2)).exp())
        })
        .collect();
    let mut runs: Vec<TempoRun> = Vec::new();
    for i in 0..windows {
        let t = i as f64 + radius;
        let corr = correlation(part(&envelope, fps, t, radius), fps);
        let (bpm, confidence, strength) = candidates
            .iter()
            .map(|&(b, prior)| {
                let strength = pulse(&corr, fps, b);
                (b, strength * prior, strength)
            })
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .unwrap();
        if confidence < 0.16 {
            continue;
        }
        // A decaying sound can correlate even at unrelated lags. Count windows
        // that distinguish the proposed pulse from the tempi on either side.
        let skirts = pulse(&corr, fps, bpm / 1.08) + pulse(&corr, fps, bpm * 1.08);
        let peaked = usize::from(skirts * 0.5 < strength * 0.9);
        if let Some(run) = runs.last_mut() {
            let typical = percentile_f64(&run.bpms[run.bpms.len().saturating_sub(5)..], 50.);
            if (bpm / typical).log2().abs() < 0.048 {
                run.last = t;
                run.bpms.push(bpm);
                run.peaked += peaked;
                continue;
            }
        }
        runs.push(TempoRun { first: t, last: t, bpms: vec![bpm], peaked });
    }
    let mut changes: Vec<(f64, f64)> = vec![];
    let mut last_center: f64 = 0.;
    let mut anchor = 0.;
    let mut support = 0;
    for run in runs.iter().filter(|r| r.bpms.len() >= windows.min(5)) {
        let mut bpm = percentile_f64(&run.bpms, 50.);
        let mut begin = 0.;
        if let Some((_, previous)) = changes.last_mut() {
            bpm *= (anchor / bpm).log2().round().exp2();
            if (bpm / anchor).log2().abs() < 0.043 {
                // A short intro need not set the BPM for the whole section.
                // Keep its metrical level and change threshold fixed, though.
                if run.peaked > support {
                    *previous = bpm;
                    support = run.peaked;
                }
                last_center = run.last;
                continue;
            }
            if run.peaked * 2 < run.bpms.len() {
                continue;
            }
            let mut t = (last_center - 3.).max(run.first - 8.).max(1.);
            let stop = (run.first + 3.).min(duration - 1.);
            let mut sum = 0.;
            let mut best = f64::NEG_INFINITY;
            begin = run.first;
            while t < stop {
                let corr = correlation(part(&envelope, fps, t, 2.), fps);
                sum += pulse(&corr, fps, *previous) - pulse(&corr, fps, bpm);
                if sum > best {
                    best = sum;
                    begin = t;
                }
                t += 0.15;
            }
            begin = shared_pulse(&envelope, fps, begin, *previous, bpm);
        }
        changes.push((begin, bpm));
        anchor = bpm;
        support = run.peaked;
        last_center = run.last;
    }
    if changes.is_empty() {
        if let Some(run) = runs.iter().max_by_key(|r| r.bpms.len()) {
            if run.bpms.len() >= windows.min(3) {
                changes.push((0., percentile_f64(&run.bpms, 50.)));
            }
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::tempo_map;

    const RATE: usize = 8000;

    fn clicks(wave: &mut [f32], bpm: f64) {
        let mut position: f64 = 0.;
        while position.round() as usize + 80 <= wave.len() {
            let start = position.round() as usize;
            for (k, sample) in wave[start..start + 80].iter_mut().enumerate() {
                let phase = std::f64::consts::TAU * k as f64;
                *sample = ((0.5 - 0.5 * (phase / 79.).cos()) * (phase * 1830. / RATE as f64).sin()) as f32;
            }
            position += 60. * RATE as f64 / bpm;
        }
    }

    #[test]
    fn unmetered_decay_does_not_replace_the_clock() {
        let mut wave = vec![0.; 48 * RATE];
        clicks(&mut wave[..19 * RATE], 120.);
        let mut state = 0xabc123u32;
        for (i, x) in wave[20 * RATE..].iter_mut().enumerate() {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = f64::from(state >> 8) / 8388608. - 1.;
            *x = (0.3 * noise * (-(i as f64) / (2. * RATE as f64)).exp()) as f32;
        }
        assert_eq!(tempo_map(&wave, RATE as u32), vec![(0., 120.)]);
    }

    #[test]
    fn longer_half_time_pulse_refines_the_intro_without_switching_metrical_level() {
        let mut wave = vec![0.; 52 * RATE];
        clicks(&mut wave[..19 * RATE], 121.5);
        clicks(&mut wave[20 * RATE..], 60.);
        assert_eq!(tempo_map(&wave, RATE as u32), vec![(0., 120.)]);
    }
}
