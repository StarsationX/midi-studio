//! Source-clock vocal transcription for the two-hand piano arranger.
use std::path::Path;

use anyhow::{anyhow, ensure, Context, Result};
use ort::{session::Session, value::Tensor};
use realfft::RealFftPlanner;

use crate::{dsp::percentile_f32, pmidi::Note, resample::resample_hq};

const RATE: usize = 44100;
const FRAME: f64 = 0.005;

struct Game {
    encoder: Session,
    segmenter: Session,
    estimator: Session,
    bd2dur: Session,
    dur2bd: Session,
}

impl Game {
    fn open(dir: &Path, threads: usize) -> Result<Self> {
        let open = |name: &str| -> Result<Session> {
            let path = dir.join(format!("{name}.onnx"));
            let mut builder = Session::builder(crate::backbone::environment()?)?
                .with_intra_threads(threads.clamp(1, 8))
                .map_err(|e| anyhow!("{e}"))?
                .with_inter_threads(1)
                .map_err(|e| anyhow!("{e}"))?
                .with_execution_providers([ort::ep::CPU::default().build()])
                .map_err(|e| anyhow!("{e}"))?;
            builder
                .commit_from_file(&path)
                .with_context(|| format!("loading vocal model {}", path.display()))
        };
        Ok(Self {
            encoder: open("encoder")?,
            segmenter: open("segmenter")?,
            estimator: open("estimator")?,
            bd2dur: open("bd2dur")?,
            dur2bd: open("dur2bd")?,
        })
    }

    fn notes(
        &mut self,
        samples: &[f32],
        offset: f64,
        duration: f64,
        seam: f64,
        rejected: &mut Vec<Note>,
    ) -> Result<Vec<Note>> {
        let length = samples.len() as f32 / RATE as f32;
        let encoded = self.encoder.run(ort::inputs![
            "waveform" => Tensor::from_array(([1, samples.len()], samples.to_vec()))?,
            "duration" => Tensor::from_array(([1], vec![length]))?
        ])?;
        let mask = &encoded["maskT"];
        let (_, valid) = mask.try_extract_tensor::<bool>()?;
        let initial = self.dur2bd.run(ort::inputs![
            "durations" => Tensor::from_array(([1, 1], vec![length]))?, "maskT" => mask
        ])?;
        let (_, init) = initial["boundaries"].try_extract_tensor::<bool>()?;
        ensure!(
            init.len() == valid.len(),
            "GAME boundary and frame masks have different lengths"
        );
        let ends: Vec<_> = init.iter().zip(valid).map(|(a, b)| *a && *b).collect();
        let known = Tensor::from_array(([1, ends.len()], ends.clone()))?;
        let mut previous = Tensor::from_array(([1, ends.len()], ends))?.into_dyn();
        let language = Tensor::from_array(([1], vec![0i64]))?;
        let threshold = Tensor::from_array(([] as [usize; 0], vec![0.23f32]))?;
        let radius = Tensor::from_array(([] as [usize; 0], vec![2i64]))?;
        for step in 0..6 {
            let mut result = self.segmenter.run(ort::inputs![
                "x_seg" => &encoded["x_seg"], "language" => &language, "known_boundaries" => &known,
                "prev_boundaries" => &previous, "t" => Tensor::from_array(([1], vec![step as f32 / 6.]))?,
                "maskT" => mask, "threshold" => &threshold, "radius" => &radius
            ])?;
            previous = result
                .remove("boundaries")
                .context("GAME segmenter returned no boundaries")?;
        }
        let durations = self
            .bd2dur
            .run(ort::inputs!["boundaries" => &previous, "maskT" => mask])?;
        let estimates = self.estimator.run(ort::inputs![
            "x_est" => &encoded["x_est"], "boundaries" => &previous, "maskT" => mask, "maskN" => &durations["maskN"],
            "threshold" => Tensor::from_array(([] as [usize; 0], vec![0.21f32]))?
        ])?;
        let (_, spans) = durations["durations"].try_extract_tensor::<f32>()?;
        let (_, voiced) = estimates["presence"].try_extract_tensor::<bool>()?;
        let (_, pitches) = estimates["scores"].try_extract_tensor::<f32>()?;
        ensure!(
            spans.len() == voiced.len() && spans.len() == pitches.len(),
            "GAME returned inconsistent note counts"
        );
        let mut notes = Vec::new();
        let mut elapsed = 0.;
        for ((span, present), pitch) in spans.iter().zip(voiced).zip(pitches) {
            let start = offset + elapsed;
            elapsed += f64::from(*span);
            let end = (offset + elapsed).min(duration);
            if !(36.0..=91.0).contains(pitch) || end - start < 0.045 {
                continue;
            }
            let note = Note {
                pitch: pitch.round_ties_even() as u8,
                start,
                end,
                velocity: 80,
            };
            if *present {
                notes.push(note);
            } else if end - start >= 0.30 && (seam..seam + 12.).contains(&start) {
                // Keep the estimator's key, but not a note, from the owning window.
                rejected.push(note);
            }
        }
        Ok(notes)
    }
}

fn join_windows(notes: &mut Vec<Note>, mut incoming: Vec<Note>, seam: f64) {
    if notes.is_empty() {
        *notes = incoming;
        return;
    }
    let mut anchor = None;
    let mut best = f64::INFINITY;
    for (j, right) in incoming.iter().enumerate() {
        if right.start > seam + 1.8 {
            break;
        }
        if right.end < seam - 1.8 {
            continue;
        }
        for (i, left) in notes.iter().enumerate().rev() {
            if left.end < right.start {
                break;
            }
            let delta = (left.start - right.start).abs();
            let overlap = left.end.min(right.end) - left.start.max(right.start);
            let cost = (seam - right.start).abs() + 2. * delta;
            if left.pitch == right.pitch && delta <= 0.06 && overlap >= 0.035 && cost < best {
                best = cost;
                anchor = Some((i, j));
            }
        }
    }
    if let Some((i, j)) = anchor {
        incoming[j].start = notes[i].start;
        notes.truncate(i);
        notes.extend_from_slice(&incoming[j..]);
        return;
    }
    notes.truncate(notes.partition_point(|n| n.start < seam));
    let split = incoming.partition_point(|n| n.start < seam);
    if let Some(last) = notes.last_mut() {
        if last.end > seam {
            if let Some(held) = incoming[..split]
                .last()
                .filter(|n| n.end > seam && n.pitch == last.pitch)
            {
                last.end = held.end;
            }
        }
        if let Some(next) = incoming.get(split) {
            last.end = last.end.min(next.start);
        }
    }
    notes.extend_from_slice(&incoming[split..]);
}

/// McLeod and Wyvill's normalized square difference function. Its periodicity
/// measure gates local pitch evidence independently of the vocal note model.
fn vocal_frames(wave: &[f32]) -> Result<(Vec<f32>, Vec<f32>)> {
    let audio = resample_hq(wave, 1, RATE as f64, 12000.)?;
    let count = 1 + audio.len() / 60;
    let mut rms = Vec::with_capacity(count);
    let mut pitch = Vec::with_capacity(count);
    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(1024);
    let inverse = planner.plan_fft_inverse(1024);
    let mut input = forward.make_input_vec();
    let mut spec = forward.make_output_vec();
    let mut fs = forward.make_scratch_vec();
    let mut is = inverse.make_scratch_vec();
    let mut energy = [0f32; 481];
    let mut clarity = [0f32; 194];
    for ix in 0..count {
        for (k, v) in input[..480].iter_mut().enumerate() {
            *v = (ix * 60 + k)
                .checked_sub(240)
                .and_then(|j| audio.get(j))
                .copied()
                .unwrap_or(0.);
        }
        let power = (input[120..360].iter().map(|x| x * x).sum::<f32>() / 240.).sqrt();
        rms.push(power);
        if power < 0.001 {
            pitch.push(f32::NAN);
            continue;
        }
        let mean = input[..480].iter().sum::<f32>() / 480.;
        for (j, v) in input[..480].iter_mut().enumerate() {
            *v -= mean;
            energy[j + 1] = energy[j] + *v * *v;
        }
        input[480..].fill(0.);
        forward.process_with_scratch(&mut input, &mut spec, &mut fs)?;
        for bin in &mut spec {
            bin.re = bin.norm_sqr() / 1024.;
            bin.im = 0.;
        }
        inverse.process_with_scratch(&mut spec, &mut input, &mut is)?;
        for lag in 7..194 {
            let pairs = energy[480 - lag] + energy[480] - energy[lag];
            clarity[lag] = 2. * input[lag] / pairs.max(1e-8);
        }
        let is_peak = |k: usize| clarity[k] > clarity[k - 1] && clarity[k] >= clarity[k + 1];
        let strongest = (8..193)
            .filter(|&k| is_peak(k))
            .map(|k| clarity[k])
            .fold(0., f32::max);
        let peak =
            (8..193).find(|&k| strongest >= 0.85 && is_peak(k) && clarity[k] >= strongest * 0.94);
        pitch.push(peak.map_or(f32::NAN, |k| {
            let (a, b, c) = (clarity[k - 1], clarity[k], clarity[k + 1]);
            let delta = (0.5 * (a - c) / (a - 2. * b + c).min(-1e-8)).clamp(-0.5, 0.5);
            69. + 12. * (12000. / ((k as f32 + delta) * 440.)).log2()
        }));
    }
    let weights: Vec<_> = (-3..=3)
        .map(|k| (-0.5 * (f64::from(k) / 0.85).powi(2)).exp() as f32)
        .collect();
    let total = weights.iter().sum::<f32>();
    let smooth = (0..count)
        .map(|i| {
            weights
                .iter()
                .enumerate()
                .map(|(j, w)| {
                    let k = (i + j).saturating_sub(3).min(count - 1);
                    rms[k] * w
                })
                .sum::<f32>()
                / total
        })
        .collect();
    Ok((smooth, pitch))
}

fn near(pitch: f32, expected: u8, tolerance: f32) -> bool {
    (pitch - f32::from(expected)).abs() < tolerance
}

fn pitch_boundary(pitch: &[f32], center: usize, old: u8, new: u8, radius: usize) -> Option<f64> {
    let lo = center.saturating_sub(radius + 8);
    let hi = (center + radius + 9).min(pitch.len());
    let mut last_old = None;
    let mut best = None;
    for (j, window) in pitch[lo..hi].windows(7).enumerate() {
        let at = j + lo;
        if window.iter().all(|p| near(*p, old, 0.42)) {
            last_old = Some(at + 6);
        }
        if !window.iter().all(|p| near(*p, new, 0.42)) {
            continue;
        }
        if let Some(left) = last_old.filter(|&left| left < at && at - left <= 5) {
            let edge = (left + at) as f64 / 2.;
            let distance = (edge - center as f64).abs();
            if distance <= radius as f64 && best.is_none_or(|(prior, _)| distance < prior) {
                best = Some((distance, edge));
            }
        }
    }
    best.map(|(_, edge)| edge)
}

fn clipped(x: &[f32], a: usize, b: usize) -> &[f32] {
    &x[a.min(x.len())..b.max(a).min(x.len())]
}

fn min_level(x: &[f32]) -> f32 {
    x.iter().copied().fold(f32::INFINITY, f32::min)
}
fn max_level(x: &[f32]) -> f32 {
    x.iter().copied().fold(0., f32::max)
}
fn frame(t: f64) -> usize {
    (t / FRAME).round_ties_even() as usize
}

fn refine_connected(previous: &mut Note, note: &mut Note, rms: &[f32], pitches: &[f32]) {
    let at = frame(note.start);
    let edge = if previous.pitch != note.pitch {
        pitch_boundary(pitches, at, previous.pitch, note.pitch, 11).filter(|&edge| {
            let k = edge.round_ties_even() as usize;
            let after = clipped(rms, k + 2, k + 10);
            edge <= at as f64
                || (!after.is_empty()
                    && min_level(clipped(rms, k.saturating_sub(6), k + 2))
                        < 0.50 * percentile_f32(after, 50.))
        })
    } else {
        let lo = (frame(previous.start) + 8).max(at.saturating_sub(15));
        let hi = (at + 7)
            .min(frame(note.end).saturating_sub(9))
            .min(rms.len().saturating_sub(10));
        if hi <= lo {
            return;
        }
        let dip = (lo..=hi)
            .min_by(|&a, &b| rms[a].total_cmp(&rms[b]))
            .unwrap();
        let flank = percentile_f32(&rms[dip - 8..dip - 3], 50.)
            .min(percentile_f32(&rms[dip + 5..dip + 10], 50.));
        let tonal = clipped(pitches, dip + 3, dip + 11)
            .iter()
            .filter(|&&p| near(p, note.pitch, 0.45))
            .count();
        if rms[dip] >= 0.36 * flank || flank <= 0.004 || tonal < 5 {
            return;
        }
        (dip..dip + 9)
            .find(|&j| rms[j] >= 0.55 * flank)
            .map(|x| x as f64)
    };
    if let Some(edge) = edge {
        let target = edge * FRAME;
        let diff = target - note.start;
        if diff.abs() <= 0.012 || diff.abs() > 0.055 {
            return;
        }
        let start = if previous.pitch == note.pitch {
            target
        } else {
            note.start + 0.75 * diff
        };
        let gap = (note.start - previous.end).max(0.);
        if start - gap >= previous.start + 0.045 && note.end >= start + 0.045 {
            previous.end = start - gap;
            note.start = start;
        }
    }
}

fn refine_phrase(
    note: &mut Note,
    last_end: f64,
    first: bool,
    rms: &[f32],
    pitch: &[f32],
) -> Option<Note> {
    let at = frame(note.start);
    let body = clipped(rms, at + 2, (at + 18).min(frame(note.end) + 1));
    if body.len() < 3 {
        return None;
    }
    let level = percentile_f32(body, 65.);
    if first
        && (0.015..=0.12).contains(&note.start)
        && level > 0.004
        && min_level(clipped(rms, 0, 4)) >= 0.55 * level
        && clipped(pitch, 2, at.max(6))
            .iter()
            .all(|&p| near(p, note.pitch, 0.4))
    {
        note.start = 0.;
        return None;
    }
    let search = frame(last_end + 0.012).max(at.saturating_sub(24)).max(5);
    let quiet = clipped(rms, search.saturating_sub(24), search.saturating_sub(2));
    if quiet.is_empty() {
        return None;
    }
    let noise = percentile_f32(quiet, 30.);
    if level < 0.006f32.max(3.5 * noise) {
        return None;
    }
    let threshold = (0.46 * level).max(3.1 * noise).max(0.0025);
    for j in search..at {
        if rms[j] < threshold || percentile_f32(&rms[j - 4..j], 50.) >= threshold {
            continue;
        }
        let peak = max_level(clipped(rms, j, j + 11));
        if min_level(clipped(rms, j, j + 5)) < 0.70 * threshold || peak < 0.50 * level {
            continue;
        }
        let initial: Vec<_> = clipped(pitch, j + 2, j + 10)
            .iter()
            .copied()
            .filter(|p| p.is_finite())
            .collect();
        let pitched = initial.len() >= 5 && near(percentile_f32(&initial, 50.), note.pitch, 5.4);
        let joined = clipped(pitch, j + 5, j + 20)
            .iter()
            .filter(|&&p| near(p, note.pitch, 0.6))
            .count()
            >= 6
            && min_level(clipped(rms, j, j + 20)) >= 0.55 * threshold;
        let gap = clipped(rms, j + 4, at + 3)
            .windows(3)
            .any(|s| max_level(s) < 0.40 * threshold);
        if pitched || joined || (!gap && peak >= 0.63 * level) {
            note.start = j as f64 * FRAME;
            break;
        }
    }
    let start = frame(note.start);
    let initial: Vec<_> = clipped(pitch, start + 2, start + 15)
        .iter()
        .copied()
        .filter(|p| p.is_finite())
        .collect();
    if initial.len() < 11 {
        return None;
    }
    let pickup = percentile_f32(&initial, 50.).round_ties_even() as u8;
    if !(1..=5).contains(&pickup.abs_diff(note.pitch))
        || initial.iter().any(|&p| !near(p, pickup, 0.35))
    {
        return None;
    }
    let first_edge = start + 15;
    let last_edge = (start + 38).min(frame(note.end).saturating_sub(13));
    if last_edge <= first_edge {
        return None;
    }
    let edge = pitch_boundary(
        pitch,
        (first_edge + last_edge) / 2,
        pickup,
        note.pitch,
        (last_edge - first_edge) / 2,
    )?;
    let sustained = clipped(
        pitch,
        start + 2,
        (edge.round_ties_even() as usize).saturating_sub(2),
    );
    let matches = sustained.iter().filter(|&&p| near(p, pickup, 0.40)).count();
    if matches as f32 >= 0.88 * sustained.len() as f32 {
        let old = Note {
            pitch: pickup,
            end: edge * FRAME,
            ..*note
        };
        note.start = old.end;
        return Some(old);
    }
    None
}

// A breath and a quiet vowel can both fall below the frame tracker's clarity
// threshold. Test the known key's period locally before dropping a noisy tail.
fn faint_vowel(wave: &[f32], key: u8, first: usize, end: usize) -> bool {
    let period = RATE as f64 / (440. * 2.0_f64.powf((f64::from(key) - 69.) / 12.));
    let lags = [0.975, 1., 1.025].map(|scale| (period * scale).round() as usize);
    let width = ((3. * period).round() as usize).max(RATE / 40);
    let sample = |f: usize| (f as f64 * FRAME * RATE as f64).round() as usize;
    let step = RATE / 100;
    let start = sample(first);
    let Some(last) = sample(end).min(wave.len()).checked_sub(width + lags[2]) else { return true };
    if last < start + step { return true; }
    let mut previous = false;
    for i in (start..=last).step_by(step) {
        let window = &wave[i..i + width + lags[2]];
        let periodic = lags.iter().any(|&lag| {
            let (mut cross, mut power) = (0., 0.);
            for j in (0..width).step_by(4) {
                let (a, b) = (window[j], window[j + lag]);
                cross += a * b;
                power += a * a + b * b;
            }
            power > 1e-8 && 2. * cross >= 0.5 * power
        });
        if periodic && previous { return true; }
        previous = periodic;
    }
    false
}

// A model segment may include the consonant after the sung vowel. Keep a
// quiet pitched decay; an audible but aperiodic breath is not a held key.
fn refine_release(note: &mut Note, rms: &[f32], pitches: &[f32], wave: &[f32]) {
    let start = frame(note.start);
    let end = frame(note.end);
    if end < start + 26 || end >= rms.len().saturating_sub(1) {
        return;
    }
    let first = (start + 20).max(end.saturating_sub(48));
    let Some(last) = (first..end).rfind(|&i| near(pitches[i], note.pitch, 0.85)) else {
        return;
    };
    if end - last < 10
        || pitches[last - 9..=last].iter().filter(|&&p| near(p, note.pitch, 0.85)).count() < 6
    {
        return;
    }
    let level = rms[last - 9..=last].iter().sum::<f32>() / 10.;
    let tail = &pitches[last + 3..end];
    if level <= 0.012 { return; }
    let voiced = tail.iter().filter(|p| p.is_finite()).count();
    let envelope = &rms[last + 3..end];
    if end - last <= 35 && max_level(envelope) < 0.48 * level {
        if 10 * voiced >= 3 * tail.len() { return; }
        let threshold = (0.34 * level).max(0.003);
        let release = (last..end).rfind(|&i| rms[i] >= threshold).map_or(last, |i| i + 1);
        if end - release >= 6 { note.end = release as f64 * FRAME; }
    } else if level > 0.015 && 100 * voiced <= 14 * tail.len()
        && pitches[last - 12..=last].iter().filter(|&&p| near(p, note.pitch, 0.70)).count() >= 10
        && envelope.iter().sum::<f32>() < 0.80 * level * envelope.len() as f32
        && !faint_vowel(wave, note.pitch, last + 3, end)
    {
        // Leave a short transition after the last periodic cycle. Do not
        // shorten a slide into another pitch or a full-level tracker dropout.
        note.end = (last + 3) as f64 * FRAME;
    }
}

// A GAME segment can contain a sung note followed by enough silence to fail
// presence detection. Recover only a repeat of the *next* recognized key, when
// the rejected segment names it too. A quiet echo or an octave is not a repeat.
fn missed_repeat(
    previous: &Note,
    next: &Note,
    rejected: &[Note],
    flank: f32,
    rms: &[f32],
    pitches: &[f32],
) -> Option<Note> {
    let start = frame(previous.end);
    let stop = frame(next.start).min(rms.len());
    if stop < start + 60 || !(1..=7).contains(&previous.pitch.abs_diff(next.pitch)) {
        return None;
    }
    let first = rejected.partition_point(|n| n.start < previous.end - 0.06);
    if !rejected[first..]
        .iter()
        .take_while(|n| n.start <= previous.end + 0.06)
        .any(|n| n.pitch == next.pitch && (n.end - next.start).abs() <= 0.06)
    {
        return None;
    }
    let head = &rms[start..start + 24];
    let level = percentile_f32(head, 50.);
    if level < 0.02f32.max(0.45 * flank) || min_level(head) < 0.13 * level {
        return None;
    }
    // Stop at the first sustained decay. A pitch dropout by itself isn't a release.
    let search = start + 36;
    let end = search + rms[search..stop.min(start + 400)].windows(8)
        .position(|w| max_level(w) < 0.40 * level)?;
    if end - start < 45
        || end + 24 > stop
        || rms[end..end + 24].iter().filter(|&&v| v > 0.55 * level).count() > 2
    {
        return None;
    }
    let preceding = &pitches[start.saturating_sub(20)..start.saturating_sub(3)];
    if 10 * preceding.iter().filter(|&&p| near(p, next.pitch, 0.65)).count() > 3 * preceding.len() {
        return None;
    }
    let body = &pitches[start + 3..end - 2];
    let (attack, hold) = body.split_at(body.len() / 2);
    let count = |x: &[f32]| x.iter().filter(|&&p| near(p, next.pitch, 0.55)).count();
    let (a, h) = (count(attack), count(hold));
    if 100 * (a + h) < 72 * body.len()
        || 100 * a < 53 * attack.len()
        || 100 * h < 53 * hold.len()
    {
        return None;
    }
    Some(Note {
        start: previous.end,
        end: end as f64 * FRAME,
        ..*next
    })
}

fn align_attacks(wave: &[f32], notes: &mut Vec<Note>, rejected: &[Note]) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }
    let (rms, pitches) = vocal_frames(wave)?;
    let mut pickups = Vec::new();
    for i in 0..notes.len() {
        let (before, current) = notes.split_at_mut(i);
        let note = &mut current[0];
        let last_end = before.last().map_or(0., |n| n.end);
        if let Some(previous) = before.last_mut() {
            if note.start - last_end <= 0.025 {
                refine_connected(previous, note, &rms, &pitches);
                continue;
            }
            if note.start - last_end < 0.12 {
                continue;
            }
        }
        if let Some(pickup) = refine_phrase(note, last_end, i == 0, &rms, &pitches) {
            pickups.push(pickup);
        }
    }
    notes.append(&mut pickups);
    notes.sort_by(|a, b| a.start.total_cmp(&b.start));
    let levels: Vec<_> = notes
        .iter()
        .map(|n| {
            let first = (frame(n.start) + 2).min(rms.len() - 1);
            percentile_f32(
                clipped(&rms, first, (first + 1).max(frame(n.end).saturating_sub(1))),
                65.,
            )
        })
        .collect();
    let reference = percentile_f32(&levels, 50.).max(0.001);
    let velocity = |level: f32| {
        let db = 20. * (level.max(0.001) / reference).log10();
        (80. + (0.72 * db).clamp(-8., 10.)).round_ties_even() as u8
    };
    let mut recovered = pickups; // Already appended above; reuse its storage.
    for (pair, levels) in notes.windows(2).zip(levels.windows(2)) {
        if let Some(mut n) = missed_repeat(
            &pair[0], &pair[1], rejected, levels[0].max(levels[1]), &rms, &pitches,
        ) {
            let body = &rms[frame(n.start) + 2..frame(n.end) - 1];
            n.velocity = velocity(percentile_f32(body, 65.));
            recovered.push(n);
        }
    }
    for (note, level) in notes.iter_mut().zip(levels) {
        note.velocity = velocity(level);
        refine_release(note, &rms, &pitches, wave);
    }
    if !recovered.is_empty() {
        notes.append(&mut recovered);
        notes.sort_by(|a, b| a.start.total_cmp(&b.start));
    }
    Ok(())
}

/// Extract the monophonic singer from an isolated, unit-scale vocal stem.
/// The caller initializes the ONNX runtime and provides the verified GAME directory.
pub fn transcribe_vocals(
    mono: &[f32],
    sample_rate: u32,
    model_dir: &Path,
    threads: usize,
) -> Result<Vec<Note>> {
    if mono.is_empty() {
        return Ok(Vec::new());
    }
    let mut wave = if sample_rate == RATE as u32 {
        mono.to_vec()
    } else {
        resample_hq(mono, 1, sample_rate as f64, RATE as f64)?
    };
    if wave.is_empty() {
        return Ok(Vec::new());
    }
    let peaks: Vec<_> = wave.iter().step_by(16).map(|p| p.abs()).collect();
    let level = percentile_f32(&peaks, 99.5);
    if max_level(&peaks) < 0.001 {
        return Ok(Vec::new());
    }
    let gain = 1.8f32.min(0.9 / level.max(0.001));
    for value in &mut wave {
        *value *= gain;
    }
    let duration = wave.len() as f64 / RATE as f64;
    let mut notes = Vec::new();
    let mut rejected = Vec::new();
    {
        let mut model = Game::open(model_dir, threads)?;
        let count = wave.len().div_ceil(12 * RATE);
        for part in 0..count {
            let begin = part * 12 * RATE;
            let left = begin.saturating_sub(3 * RATE);
            let right = (begin + 15 * RATE).min(wave.len());
            let input = &wave[left..right];
            let mut padded;
            let input = if input.len() < RATE {
                padded = input.to_vec();
                padded.resize(RATE, 0.);
                &padded
            } else {
                input
            };
            let seam = begin as f64 / RATE as f64;
            let next = model.notes(input, left as f64 / RATE as f64, duration, seam, &mut rejected)?;
            join_windows(&mut notes, next, seam);
            println!("Vocal analysis: {}/{}", part + 1, count);
        }
    }
    align_attacks(&wave, &mut notes, &rejected)?;
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(pitch: u8, start: f64, end: f64) -> Note {
        Note {
            velocity: 80,
            pitch,
            start,
            end,
        }
    }

    fn sing(tones: &[(u8, f64, f64, f32)], vibrato: f64) -> Vec<f32> {
        let mut phase = 0.;
        (0..RATE)
            .map(|i| {
                let t = i as f64 / RATE as f64;
                let Some(&(key, start, _, gain)) =
                    tones.iter().find(|(_, s, e, _)| *s <= t && t < *e)
                else {
                    return 0.;
                };
                let pitch = f64::from(key) + vibrato * (std::f64::consts::TAU * 5.7 * t).sin();
                phase +=
                    std::f64::consts::TAU * 440. * 2f64.powf((pitch - 69.) / 12.) / RATE as f64;
                gain * ((t - start) / 0.006).clamp(0., 1.) as f32
                    * (phase.sin() + 0.35 * (2. * phase).sin()) as f32
            })
            .collect()
    }

    #[test]
    fn preserves_grounded_pickup_and_dynamics() {
        let wave = sing(
            &[
                (68, 0.30, 0.405, 0.16),
                (69, 0.405, 0.66, 0.3),
                (72, 0.74, 1., 0.05),
            ],
            0.,
        );
        let mut notes = vec![note(69, 0.385, 0.66), note(72, 0.74, 1.)];
        align_attacks(&wave, &mut notes, &[]).unwrap();
        assert_eq!(
            notes.iter().map(|n| n.pitch).collect::<Vec<_>>(),
            [68, 69, 72]
        );
        for (n, t) in notes.iter().zip([0.30, 0.405, 0.74]) {
            assert!((n.start - t).abs() < 0.016);
        }
        assert!(notes[1].velocity > notes[0].velocity && notes[0].velocity > notes[2].velocity);
    }

    #[test]
    fn respects_syllables_with_late_vowels_and_repeated_attacks() {
        let mut notes = vec![
            note(62, 0.12, 0.46),
            note(65, 0.46, 0.65),
            note(64, 0.65, 0.99),
        ];
        let wave = sing(
            &[
                (62, 0.12, 0.42, 0.19),
                (65, 0.42, 0.69, 0.22),
                (64, 0.69, 0.99, 0.16),
            ],
            0.,
        );
        align_attacks(&wave, &mut notes, &[]).unwrap();
        assert!((notes[1].start - 0.42).abs() < 0.016);
        assert_eq!(notes[2].start, 0.65);
        let mut repeat = vec![note(64, 0.12, 0.534), note(64, 0.534, 1.)];
        let wave = sing(&[(64, 0.12, 0.46, 0.16), (64, 0.49, 1., 0.16)], 0.);
        align_attacks(&wave, &mut repeat, &[]).unwrap();
        assert!((repeat[1].start - 0.493).abs() < 0.016);
        let mut held = vec![note(64, 0.12, 1.)];
        align_attacks(&sing(&[(64, 0.12, 1., 0.16)], 0.58), &mut held, &[]).unwrap();
        assert_eq!(held.len(), 1);
    }

    #[test]
    fn recovers_sounding_head_of_rejected_repeat_without_filling_the_rest() {
        let previous = note(63, 0., 0.20);
        let next = note(61, 0.90, 1.);
        let candidate = [note(61, 0.20, 0.90)];
        let mut rms = [0.2; 200];
        let mut pitches = [63.; 200];
        pitches[40..110].fill(61.);
        rms[110..180].fill(0.01);
        let recover = |e: &[Note], r: &[f32], p: &[f32]| missed_repeat(&previous, &next, e, 0.2, r, p);
        assert_eq!(recover(&candidate, &rms, &pitches), Some(note(61, 0.20, 0.55)));
        assert!(recover(&[], &rms, &pitches).is_none());
        assert!(recover(&[note(62, 0.20, 0.90)], &rms, &pitches).is_none());
        assert!(recover(&candidate, &[0.2; 200], &pitches).is_none());
        rms[40..110].fill(0.035); // Echo below neighboring syllable level.
        assert!(recover(&candidate, &rms, &pitches).is_none());
        rms[40..110].fill(0.2);
        pitches[40..75].fill(59.); // Only lands on the target late in a slide.
        assert!(recover(&candidate, &rms, &pitches).is_none());
        pitches[20..110].fill(61.); // Already sounding before the alleged attack.
        assert!(recover(&candidate, &rms, &pitches).is_none());
    }

    #[test]
    fn trims_quiet_unvoiced_tails_but_not_short_attacks_or_pitch_dropouts() {
        let mut rms = [0.2; 120];
        let mut pitches = [65.; 120];
        pitches[50..].fill(f32::NAN);
        rms[50..55].fill(0.085); // Audible decay, no longer pitch-trackable.
        rms[55..].fill(0.012);
        let mut held = note(65, 0., 0.35);
        let breath = vec![0.; RATE];
        refine_release(&mut held, &rms, &pitches, &breath);
        assert_eq!(held, note(65, 0., 55. * FRAME));

        for candidate in [note(65, 0.20, 0.31), note(65, 0., 0.24)] {
            let mut unchanged = candidate;
            refine_release(&mut unchanged, &rms, &pitches, &breath);
            assert_eq!(unchanged, candidate);
        }
        let candidate = note(65, 0., 0.35);
        for (level, pitch) in [(0.2, f32::NAN), (0.012, 65.), (0.012, 67.)] {
            rms[50..].fill(level);
            pitches[50..].fill(pitch);
            let mut unchanged = candidate;
            refine_release(&mut unchanged, &rms, &pitches, &breath);
            assert_eq!(unchanged, candidate);
        }
        pitches[50..].fill(f32::NAN);
        rms[50..].fill(0.13); // An audible consonant, not silence.
        let mut syllable = candidate;
        refine_release(&mut syllable, &rms, &pitches, &breath);
        assert_eq!(syllable, note(65, 0., 52. * FRAME));
        let vowel = sing(&[(65, 0., 0.5, 0.13)], 0.05);
        let mut sustained = candidate;
        refine_release(&mut sustained, &rms, &pitches, &vowel);
        assert_eq!(sustained, candidate);
    }

    #[test]
    fn drop_or_duplicate_at_chunk_seams() {
        for (a, b) in [(12.02, 11.98), (11.98, 12.02)] {
            let mut old = vec![note(60, 11.5, a), note(64, a, 12.3)];
            let new = vec![
                note(60, 11.49, b),
                note(64, b, 12.32),
                note(60, 12.33, 12.6),
            ];
            join_windows(&mut old, new, 12.);
            assert_eq!(
                old.iter().map(|n| n.pitch).collect::<Vec<_>>(),
                [60, 64, 60]
            );
            assert!(old.windows(2).all(|w| w[0].end <= w[1].start));
        }
        let mut old = vec![note(65, 4., 15.)];
        join_windows(&mut old, vec![note(65, 9., 21.)], 12.);
        assert_eq!(old, vec![note(65, 4., 21.)]);
    }

    #[test]
    #[ignore = "requires the pinned GAME models and a real vocal stem"]
    fn real_game_vocal_clip() -> Result<()> {
        crate::backbone::init_ort(None)?;
        let directory = std::env::var("FORGE_GAME_TEST_MODELS")?;
        let stem = std::env::var("FORGE_GAME_TEST_AUDIO")?;
        let start: f64 = std::env::var("FORGE_GAME_TEST_START")
            .unwrap_or_else(|_| "0".into())
            .parse()?;
        let audio = crate::audio::load(Path::new(&stem))?;
        let first = (start * f64::from(audio.sample_rate)) as usize;
        let last = (first + 3 * audio.sample_rate as usize).min(audio.frames());
        ensure!(first < last, "test clip must contain audio");
        let mono = crate::audio::Audio::downmix(
            &audio.samples[first * audio.channels..last * audio.channels],
            audio.channels,
        );
        let notes = transcribe_vocals(&mono, audio.sample_rate, Path::new(&directory), 2)?;
        assert!(!notes.is_empty());
        assert!(notes.windows(2).all(|n| n[0].end <= n[1].start));
        println!(
            "{} events; first notes {:?}",
            notes.len(),
            &notes[..notes.len().min(6)]
        );
        Ok(())
    }
}
