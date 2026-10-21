//! python-engine/stem_to_midi.py: basic-pitch on a (loudness-normalised)
//! signal, then its MIDI cleanup (length / velocity floor, octave fold into
//! the piano range, optional polyphony cap, velocity expansion). The app's
//! Fast mode, and the sparse-piano check song_to_midi.py runs on the piano
//! stem.

use crate::audio::Audio;
use crate::basicpitch::{self, Model, Params};
use crate::pmidi::{Note, PrettyMidi};
use crate::post::{self, NormalizeOpts};
use anyhow::{anyhow, Result};

fn env_str(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

fn env_f64(k: &str, d: f64) -> Result<f64> {
    match env_str(k) {
        Some(v) => v.trim().parse().map_err(|_| anyhow!("{k}={v:?} is not a number")),
        None => Ok(d),
    }
}

fn env_i64(k: &str, d: i64) -> Result<i64> {
    match env_str(k) {
        Some(v) => v.trim().parse().map_err(|_| anyhow!("{k}={v:?} is not an integer")),
        None => Ok(d),
    }
}

fn env_flag(k: &str, d: bool) -> bool {
    match env_str(k) {
        Some(v) => matches!(v.as_str(), "1" | "true" | "True" | "yes"),
        None => d,
    }
}

/// stem_to_midi._env_freq: unset or unparsable -> the default, <= 0 -> no limit.
fn env_freq(k: &str, d: f64) -> Option<f64> {
    match env_str(k).unwrap_or_default().trim().parse::<f64>() {
        Ok(f) if f > 0.0 => Some(f),
        Ok(_) => None,
        Err(_) => Some(d),
    }
}

/// The knobs stem_to_midi.py reads, with its defaults.
#[derive(Debug, Clone)]
pub struct StemOpts {
    pub min_note_sec: f64,
    pub min_velocity: i64,
    pub min_pitch: i64,
    pub max_pitch: i64,
    pub bp_onset: f64,
    pub bp_frame: f64,
    pub bp_min_note_ms: i64,
    pub bp_min_freq: Option<f64>,
    pub bp_max_freq: Option<f64>,
    pub octave_fold: bool,
    pub fold_min: i64,
    pub fold_max: i64,
    pub max_polyphony: i64,
    pub loudness_norm: bool,
    pub normalize: NormalizeOpts,
    pub velocity_gamma: f64,
}

impl StemOpts {
    pub fn from_env() -> Result<StemOpts> {
        Ok(StemOpts {
            min_note_sec: env_f64("MIN_NOTE_SEC", 0.03)?,
            min_velocity: env_i64("MIN_VELOCITY", 20)?,
            min_pitch: env_i64("PIANO_MIN_PITCH", 0)?,
            max_pitch: env_i64("PIANO_MAX_PITCH", 127)?,
            bp_onset: env_f64("BP_ONSET_THRESHOLD", 0.5)?,
            bp_frame: env_f64("BP_FRAME_THRESHOLD", 0.3)?,
            bp_min_note_ms: env_i64("BP_MIN_NOTE_MS", 58)?,
            bp_min_freq: env_freq("BP_MIN_FREQ", 27.5),
            bp_max_freq: env_freq("BP_MAX_FREQ", 4186.0),
            octave_fold: env_flag("OCTAVE_FOLD", true),
            fold_min: env_i64("FOLD_MIN_PITCH", 21)?,
            fold_max: env_i64("FOLD_MAX_PITCH", 108)?,
            max_polyphony: env_i64("MAX_POLYPHONY", 0)?,
            loudness_norm: env_flag("LOUDNESS_NORM", true),
            normalize: NormalizeOpts { target_rms_db: env_f64("TARGET_RMS_DB", -20.0)?, peak_ceiling_db: env_f64("PEAK_CEILING_DB", -1.0)? },
            velocity_gamma: env_f64("VELOCITY_GAMMA", 0.85)?,
        })
    }

    pub fn params(&self) -> Params {
        Params {
            onset_threshold: self.bp_onset,
            frame_threshold: self.bp_frame,
            minimum_note_length: self.bp_min_note_ms as f64,
            minimum_frequency: self.bp_min_freq,
            maximum_frequency: self.bp_max_freq,
            melodia_trick: true,
            midi_tempo: 120.0,
        }
    }
}

/// Python's repr() of a float.
pub fn py_float(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e16 {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

fn py_opt(v: Option<f64>) -> String {
    v.map_or("None".into(), py_float)
}

fn py_bool(b: bool) -> &'static str {
    if b { "True" } else { "False" }
}

fn fold_pitch(p: i64, lo: i64, hi: i64) -> i64 {
    if hi - lo < 12 {
        return p.clamp(0, 127);
    }
    let mut p = p;
    while p < lo {
        p += 12;
    }
    while p > hi {
        p -= 12;
    }
    p
}

/// _cap_polyphony on pretty_midi notes.
pub fn cap_polyphony(mut notes: Vec<Note>, max_poly: i64) -> Vec<Note> {
    if max_poly <= 0 || notes.len() as i64 <= max_poly {
        return notes;
    }
    let max_poly = max_poly as usize;
    const Q: f64 = 0.035;
    notes.sort_by(|a, b| a.start.total_cmp(&b.start));
    let flush = |group: &mut Vec<Note>, out: &mut Vec<Note>| {
        if group.len() > max_poly {
            group.sort_by(|a, b| b.velocity.cmp(&a.velocity));
            group.truncate(max_poly);
        }
        out.append(group);
    };
    let mut out = Vec::with_capacity(notes.len());
    let mut group: Vec<Note> = Vec::new();
    let mut gstart: Option<f64> = None;
    for nt in notes {
        match gstart {
            Some(g) if nt.start - g > Q => {
                flush(&mut group, &mut out);
                group.push(nt);
                gstart = Some(nt.start);
            }
            _ => {
                gstart.get_or_insert(nt.start);
                group.push(nt);
            }
        }
    }
    flush(&mut group, &mut out);
    out
}

/// audio_utils.expand_velocities
pub fn expand_velocities(notes: &mut [Note], gamma: f64, floor: i64) {
    if notes.is_empty() || gamma == 1.0 {
        return;
    }
    let mut vels: Vec<u8> = notes.iter().map(|n| n.velocity).collect();
    vels.sort_unstable();
    let pivot = vels[vels.len() / 2] as f64;
    let span = pivot.max(127.0 - pivot).max(1.0);
    for n in notes.iter_mut() {
        let d = (n.velocity as f64 - pivot) / span;
        let sign = if d >= 0.0 { 1.0 } else { -1.0 };
        let d_new = sign * d.abs().powf(gamma);
        let v_new = pivot + d_new * span;
        n.velocity = (v_new.round_ties_even() as i64).min(127).max(floor).clamp(0, 127) as u8;
    }
}

/// stem_to_midi.clean_midi on a reloaded file. Returns (before, after).
pub fn clean_midi(pm: &mut PrettyMidi, o: &StemOpts) -> (usize, usize) {
    let before = pm.note_count();
    for inst in pm.instruments.iter_mut() {
        let mut notes: Vec<Note> = inst.notes.iter().copied().filter(|n| (n.end - n.start) >= o.min_note_sec && n.velocity as i64 >= o.min_velocity).collect();
        if o.octave_fold {
            for n in notes.iter_mut() {
                n.pitch = fold_pitch(n.pitch as i64, o.fold_min, o.fold_max) as u8;
            }
        }
        notes.retain(|n| (o.min_pitch..=o.max_pitch).contains(&(n.pitch as i64)));
        let mut notes = cap_polyphony(notes, o.max_polyphony);
        expand_velocities(&mut notes, o.velocity_gamma, o.min_velocity);
        inst.notes = notes;
    }
    (before, pm.note_count())
}

/// What one stem_to_midi.py run produced.
pub struct StemResult {
    pub bytes: Vec<u8>,
    pub before: usize,
    pub after: usize,
    pub predict_s: f64,
}

/// stem_to_midi.main from the (already windowed) audio onwards, printing
/// its lines through `say`. `src` is the file the script was given (its
/// `_norm.wav` sits next to it), `process_src` what it reads when loudness
/// normalisation is off.
pub fn run(model: &mut Model, a: &Audio, o: &StemOpts, src: &std::path::Path, process_src: &std::path::Path, say: &mut dyn FnMut(String)) -> Result<StemResult> {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let norm = src.with_file_name(format!("{stem}_norm.wav"));
    let (a, predict_src) = if o.loudness_norm {
        say(format!("Normalizing to {} dB RMS -> {stem}_norm.wav", py_float(o.normalize.target_rms_db)));
        (post::loudness_normalize(a, &o.normalize), norm)
    } else {
        (a.clone(), process_src.to_path_buf())
    };
    let t0 = std::time::Instant::now();
    say(format!("Predicting MIDI for {}...", predict_src.display()));
    let y = basicpitch::load_mono(&a, basicpitch::SAMPLE_RATE)?;
    let raw = basicpitch::predict(model, &y, &o.params())?;
    let raw_bytes = raw.to_bytes()?;
    let predict_s = t0.elapsed().as_secs_f64();
    say(format!("Transcribed in {predict_s:.1}s"));
    let mut pm = PrettyMidi::from_bytes(&raw_bytes)?;
    let (before, after) = clean_midi(&mut pm, o);
    say(format!("MIDI cleanup: {before} -> {after} notes (dropped {}); velocity gamma {}", before - after, py_float(o.velocity_gamma)));
    Ok(StemResult { bytes: pm.to_bytes()?, before, after, predict_s })
}

/// The settings lines stem_to_midi.py prints before it starts.
pub fn banner(o: &StemOpts, input: &str, output: &str) -> Vec<String> {
    vec![
        format!("Input:  {input}"),
        format!("Output: {output}"),
        format!("basic-pitch settings: onset={}, frame={}, min_note_ms={}", py_float(o.bp_onset), py_float(o.bp_frame), o.bp_min_note_ms),
        format!(
            "band: {}-{} Hz | octave-fold: {} [{}-{}] | max-polyphony: {}",
            py_opt(o.bp_min_freq),
            py_opt(o.bp_max_freq),
            py_bool(o.octave_fold),
            o.fold_min,
            o.fold_max,
            if o.max_polyphony != 0 { o.max_polyphony.to_string() } else { "unlimited".into() }
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_and_cap() {
        assert_eq!(fold_pitch(15, 21, 108), 27);
        assert_eq!(fold_pitch(115, 21, 108), 103);
        assert_eq!(fold_pitch(130, 60, 65), 127);
        let n = |s: f64, p: u8, v: u8| Note { velocity: v, pitch: p, start: s, end: s + 0.5 };
        let out = cap_polyphony(vec![n(0.0, 60, 50), n(0.01, 64, 90), n(0.02, 67, 70), n(1.0, 60, 10)], 2);
        let got: Vec<u8> = out.iter().map(|m| m.pitch).collect();
        assert_eq!(got, vec![64, 67, 60]);
    }

    #[test]
    fn env_freq_rules() {
        assert_eq!(env_freq("FORGE_RS_TEST_UNSET_FREQ", 27.5), Some(27.5));
    }
}
