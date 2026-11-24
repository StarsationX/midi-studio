//! Shared sample clock for Medley's vocal, bass, drums and harmony.

use super::{apply_window, ep_name, file_stem, roformer_model, run_separation, safe_name,
    say_device, say_engine, start_runtime, transcribe, transkun_assets, work_root, write_stem_wav,
    Args, Knobs};
use crate::audio::{self, Audio, SourceKind};
use crate::demix::{Planar, Stems};
use crate::pmidi::Note;
use crate::roformer::{Ep, INSTRUMENTS, SAMPLE_RATE};
use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};

pub struct Evidence {
    pub vocals: Vec<f32>,
    pub bass: Vec<f32>,
    pub bass_notes: Vec<Note>,
    pub drums: Vec<f32>,
    pub sample_rate: u32,
    pub backing: Vec<Note>,
    pub instrumental: Vec<Note>,
    /// Existing mono detector input, reused to locate attacks in the selected instrumental keys.
    pub(super) instrumental_wave: Vec<f32>,
    pub piano_passages: Vec<(f64, f64)>,
    pub sustain: Vec<(f64, f64)>,
    /// Mean square energy of pitched stems, excluding percussion; half-second bins.
    pub(super) pitched_power: Vec<f64>,
    pub harmonic_notes: Vec<Note>,
    pub duration: f64,
    pub mixture_tempos: Vec<(f64, f64)>,
    /// Add this to a clip-relative note time to obtain its original recording time.
    pub source_start: f64,
}

// Reserve a distinct diagnostic folder even for simultaneous jobs on the same file.
fn keep_directory(base: &Path) -> Result<PathBuf> {
    let root = base.parent().context("no work folder")?;
    std::fs::create_dir_all(root)?;
    let stem = base.file_name().context("no work name")?.to_string_lossy();
    let dir = tempfile::Builder::new().prefix(&format!("{stem}-")).tempdir_in(root)?;
    Ok(dir.keep())
}

fn mono(mut channels: Planar, expected_frames: usize) -> Result<Vec<f32>> {
    if channels.is_empty() || channels.iter().any(|c| c.len() != expected_frames) {
        bail!("Separated instruments do not share the original sample clock.");
    }
    let gain = 1.0 / channels.len() as f32;
    let mut mix = channels.pop().unwrap();
    for channel in channels {
        for (sample, value) in mix.iter_mut().zip(channel) {
            *sample += value;
        }
    }
    for value in &mut mix {
        *value *= gain;
    }
    Ok(mix)
}

struct Signals {
    vocals: Vec<f32>,
    bass: Vec<f32>,
    drums: Vec<f32>,
    harmony: Audio,
    piano_passages: Vec<(f64, f64)>,
    pitched_power: Vec<f64>,
}

fn split(stems: Stems, expected_frames: usize) -> Result<Signals> {
    if stems.len() != INSTRUMENTS.len() || expected_frames == 0 {
        bail!("Incomplete six-stem audio for Medley.");
    }
    let mut vocals = None;
    let mut bass = None;
    let mut drums = None;
    let mut harmony = Vec::<f32>::new();
    let half_second = SAMPLE_RATE as usize / 2;
    let mut energy = vec![[0.; 2]; expected_frames.div_ceil(half_second)];
    let mut pitched_power = vec![0.; energy.len()];
    for (name, channels) in INSTRUMENTS.into_iter().zip(stems) {
        let channel = mono(channels, expected_frames)?;
        let column = usize::from(name != "piano");
        for ((bin, pitched), samples) in energy.iter_mut().zip(&mut pitched_power).zip(channel.chunks(half_second)) {
            let power = samples.iter().map(|&x| f64::from(x) * f64::from(x)).sum::<f64>();
            bin[column] += power;
            if name != "drums" { *pitched += power / samples.len() as f64; }
        }
        match name {
            "vocals" => vocals = Some(channel),
            "bass" => bass = Some(channel),
            "drums" => drums = Some(channel),
            "piano" | "guitar" | "other" => {
                if harmony.is_empty() {
                    harmony = channel;
                } else {
                    for (sample, value) in harmony.iter_mut().zip(channel) {
                        *sample += value;
                    }
                }
            }
            _ => bail!("Unexpected separator instrument: {name}."),
        }
    }
    for sample in &mut harmony {
        *sample /= 3.0;
    }
    Ok(Signals {
        vocals: vocals.context("missing vocals")?,
        bass: bass.context("missing bass")?,
        drums: drums.context("missing drums")?,
        harmony: Audio { channels: 1, kind: SourceKind::Float, sample_rate: SAMPLE_RATE, samples: harmony },
        piano_passages: crate::expressive_arrange::piano_passages(&energy, expected_frames as f64 / f64::from(SAMPLE_RATE)),
        pitched_power,
    })
}

pub fn extract(args: &Args, knobs: &Knobs, src: &Path) -> Result<Evidence> {
    let rofo_path = roformer_model(args.models.as_deref(), args.rofo_model.as_deref())?;
    let tk_paths = transkun_assets(args.models.as_deref(), args.aux.as_deref())?;
    let rt = start_runtime(args)?;
    say_device(&rt);
    say_engine(&rt);
    let input = audio::load(src)?;
    let input_rate = input.sample_rate as f64;
    let first_sample = knobs.start_raw.parse::<f64>().unwrap_or(0.0).max(0.0) * input_rate;
    let source_start = first_sample.floor() / input_rate;
    let (input, label) = apply_window(input, &knobs.start_raw, &knobs.end_raw)?;
    if let Some(label) = label {
        println!("{label}");
    }
    let duration = input.frames() as f64 / input_rate;
    // Harmony and subdivisions can establish a quarter-note pulse even when
    // snare accents alone suggest half time. Drop the mono mix before demixing.
    let mixture_tempos = if input.channels == 1 {
        crate::expressive_arrange::tempo_map(&input.samples, input.sample_rate)
    } else {
        let mix = Audio::downmix(&input.samples, input.channels);
        crate::expressive_arrange::tempo_map(&mix, input.sample_rate)
    };
    let work = work_root(src, "-expressive");
    let work = if knobs.keep_stems { keep_directory(&work)? } else { work };
    let name = safe_name(&file_stem(src));
    let separated = run_separation(args, knobs, &rt, &rofo_path, &input, &work, &name)?;
    drop(input);
    let frames = separated.stems.first().and_then(|channels| channels.first())
        .map(Vec::len).ok_or_else(|| anyhow!("No separated vocal or instrument audio."))?;
    // soxr may round the sample count when resampling to the separator rate.
    if (frames as f64 - duration * SAMPLE_RATE as f64).abs() > 2.0 {
        bail!("Separated audio length differs from the source window.");
    }
    let Signals { vocals, bass, drums, harmony, piano_passages, pitched_power } = split(separated.stems, frames)?;
    let mut instrumental = Vec::new();
    let mut instrumental_wave = Vec::new();
    let mut backing = Vec::new();
    let mut sustain = Vec::new();
    let tk_ep = if args.transkun_gpu { separated.ep } else { Ep::Cpu };
    println!("[3/6] Transcribe accompaniment with Transkun V2 ({})", ep_name(tk_ep));
    // Transkun's input reader scales float-container WAVs differently from 16-bit PCM.
    // Keep real unit-scale PCM and optionally normalize the backing's level.
    let present = harmony.samples.iter().any(|v| v.abs() >= 0.001);
    let bass_notes = crate::expressive_arrange::bass_notes(&bass, SAMPLE_RATE)?;
    let harmonic_notes = crate::expressive_arrange::harmony_notes(&harmony.samples, harmony.sample_rate, &bass_notes)?;
    let input = if knobs.loudness_norm {
        crate::post::loudness_normalize(&harmony, &knobs.normalize)
    } else {
        crate::post::as_pcm16(&harmony, &harmony.samples)
    };
    drop(harmony);
    if knobs.keep_stems {
        write_stem_wav(&work.join("backing.wav"), &input)?;
    }
    if present {
        let raw = transcribe(&tk_paths, &input, args, knobs, tk_ep)?;
        for note in raw.notes {
            let end = note.end.min(duration);
            let start = note.start.max(0.0);
            if (21..=108).contains(&note.pitch) && end > start {
                backing.push(Note { pitch: note.pitch as u8, start, end, velocity: note.velocity });
            } else if note.pitch == -64 && note.velocity >= 64 && end > start && !piano_passages.is_empty() {
                sustain.push((start, end));
            }
        }
        println!("Detect instrumental lead with Basic Pitch (CPU)");
        let mono = crate::resample::resample_hq(&input.samples, 1,
            f64::from(input.sample_rate), f64::from(crate::basicpitch::SAMPLE_RATE))?;
        let mut model = crate::basicpitch::Model::load(&super::bp_model_path(args)?, Some(args.threads.unwrap_or(4)))?;
        instrumental = model.instrumental_notes(&mono)?;
        instrumental_wave = mono;
        // Keep the piano detector's attacks where the instrumental detector
        // has no playable attack. Never turn two views of one onset into a trill.
        supplement_instrumental(&mut instrumental, &backing);
    }
    if knobs.keep_stems {
        let mut pm = crate::pmidi::PrettyMidi::new(960, 120.0);
        let mut track = crate::pmidi::Instrument::new(0, false, "Pitched backing");
        track.notes.clone_from(&backing);
        let mut lead_track = crate::pmidi::Instrument::new(0, false, "Instrumental lead candidates");
        lead_track.notes.clone_from(&instrumental);
        let mut candidates = crate::pmidi::PrettyMidi::new(960, 120.0);
        candidates.instruments.push(lead_track);
        candidates.write(&work.join("instrumental.mid"))?;
        pm.instruments.push(track);
        pm.write(&work.join("backing.mid"))?;
        println!("  (kept stems: {})", work.display());
    }
    Ok(Evidence { vocals, bass, bass_notes, drums, sample_rate: SAMPLE_RATE, backing, instrumental, instrumental_wave, harmonic_notes, piano_passages, sustain, pitched_power, duration, source_start, mixture_tempos })
}

fn supplement_instrumental(instrumental: &mut Vec<Note>, piano: &[Note]) {
    instrumental.retain(|n| n.velocity >= 45 && n.end - n.start >= 0.03);
    instrumental.sort_unstable_by(|a, b| a.start.total_cmp(&b.start));
    let detected = instrumental.len();
    for &n in piano.iter().filter(|n| (53..=96).contains(&n.pitch)) {
        let i = instrumental[..detected].partition_point(|p| p.start < n.start - 0.055);
        if i == detected || instrumental[i].start > n.start + 0.055 {
            instrumental.push(n);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instrument_attack_wins_once_and_piano_fills_missing_attacks() {
        let n = |pitch, start, velocity| Note { pitch, start, end: start + 0.15, velocity };
        let mut lead = vec![n(76, 1., 72), n(74, 1.5, 29)];
        supplement_instrumental(&mut lead, &[n(76, 1.02, 91), n(77, 1.50, 80), n(36, 2., 90)]);
        assert_eq!(lead.iter().map(|n| (n.pitch, n.start)).collect::<Vec<_>>(), [(76, 1.), (77, 1.5)]);
    }


    #[test]
    fn pitched_backing_excludes_the_three_independent_analysis_stems() {
        let stems = INSTRUMENTS.iter().map(|&name| {
            let v = match name { "bass" => 2., "drums" => 4., "vocals" => 6., _ => 0.3 };
            vec![vec![0., v], vec![0., v * 0.5]]
        }).collect();
        let split = split(stems, 2).unwrap();
        assert_eq!(split.bass, vec![0., 1.5]);
        assert_eq!(split.drums, vec![0., 3.]);
        assert_eq!(split.vocals, vec![0., 4.5]);
        assert!((split.harmony.samples[1] - 0.225).abs() < 1e-6);
        // The loud drum is not part of the piano dynamic target. The short
        // final bin is normalized by its two real samples, not half a second.
        let pitched = (1.5_f64.powi(2) + 4.5_f64.powi(2) + 3. * 0.225_f64.powi(2)) / 2.;
        assert!((split.pitched_power[0] - pitched).abs() < 1e-6);
    }

    #[test]
    fn mismatched_stems_never_silently_shift_the_recording_clock() {
        let mut stems = vec![vec![vec![0.; 2]; 2]; INSTRUMENTS.len()];
        stems[0][1].pop();
        assert!(split(stems, 2).is_err());
    }
}
