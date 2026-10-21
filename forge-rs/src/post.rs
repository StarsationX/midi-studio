//! The steps transcribe.py wraps around Transkun:
//!
//! * `loudness_normalize`: audio_utils.load_normalize_save (librosa.load ->
//!   RMS to -20 dBFS, peak ceiling -1 dBFS -> soundfile PCM_16 WAV), returned
//!   as the samples transkun then reads back from that WAV.
//! * `clean_midi`: transcribe.clean_midi (pretty_midi reload, drop notes
//!   shorter than 30 ms / quieter than 20 / outside 21..108, then
//!   audio_utils.expand_velocities with gamma 0.85).

use crate::audio::Audio;
use crate::midi::{self, Piano};

#[derive(Debug, Clone)]
pub struct NormalizeOpts {
    pub target_rms_db: f64,
    pub peak_ceiling_db: f64,
}

impl Default for NormalizeOpts {
    fn default() -> Self {
        NormalizeOpts { target_rms_db: -20.0, peak_ceiling_db: -1.0 }
    }
}

fn db(x: f64) -> f64 {
    20.0 * x.max(1e-12).log10()
}

/// Returns 16-bit-quantised audio in readAudio scale (int16 / 2^15), same
/// rate and channel count. `audio` must be unit scale (as `audio::load`).
pub fn loudness_normalize(audio: &Audio, o: &NormalizeOpts) -> Audio {
    let c = audio.channels;
    let mut x = audio.samples.clone();
    // mono = audio.mean(axis=0) (float32), rms in float64
    let mono = Audio::downmix(&x, c);
    let sq: f64 = mono.iter().map(|&v| (v as f64) * (v as f64)).sum();
    let rms = (sq / mono.len().max(1) as f64).sqrt();
    if rms >= 1e-9 {
        let gain = 10f64.powf((o.target_rms_db - db(rms)) / 20.0);
        let g32 = gain as f32; // numpy: float32 array * python float -> float32
        for v in x.iter_mut() {
            *v *= g32;
        }
        let peak = x.iter().fold(0f32, |m, v| m.max(v.abs())) as f64;
        let ceiling = 10f64.powf(o.peak_ceiling_db / 20.0);
        if peak > ceiling {
            let s = (ceiling / peak) as f32;
            for v in x.iter_mut() {
                *v *= s;
            }
        }
    }
    // soundfile PCM_16 write (libsndfile 1.2.2: floor(x * 32768), clipped),
    // then pydub reads int16 / 2^15.
    for v in x.iter_mut() {
        *v = (*v * 32768.0).floor().clamp(-32768.0, 32767.0) / 32768.0;
    }
    Audio { sample_rate: audio.sample_rate, channels: c, samples: x, kind: crate::audio::SourceKind::Int(16) }
}

#[derive(Debug, Clone)]
pub struct CleanOpts {
    pub min_note_sec: f64,
    pub min_velocity: u8,
    pub min_pitch: u8,
    pub max_pitch: u8,
    pub velocity_gamma: f64,
}

impl Default for CleanOpts {
    fn default() -> Self {
        CleanOpts { min_note_sec: 0.03, min_velocity: 20, min_pitch: 21, max_pitch: 108, velocity_gamma: 0.85 }
    }
}

/// audio_utils.expand_velocities(notes, gamma, floor)
fn expand_velocities(p: &mut Piano, gamma: f64, floor: u8) {
    if p.notes.is_empty() || gamma == 1.0 {
        return;
    }
    let mut vels: Vec<u8> = p.notes.iter().map(|n| n.velocity).collect();
    vels.sort_unstable();
    let pivot = vels[vels.len() / 2] as f64;
    let span = pivot.max(127.0 - pivot).max(1.0);
    for n in p.notes.iter_mut() {
        let d = (n.velocity as f64 - pivot) / span;
        let sign = if d >= 0.0 { 1.0 } else { -1.0 };
        let d_new = sign * d.abs().powf(gamma);
        let v_new = pivot + d_new * span;
        let r = v_new.round_ties_even() as i64;
        n.velocity = r.clamp(floor as i64, 127) as u8;
    }
}

/// transcribe.clean_midi on the MIDI `midi::piano_from_notes` describes.
/// Returns (notes before, notes after, cleaned instrument or None).
pub fn clean_midi(written: &Piano, o: &CleanOpts) -> (usize, usize, Option<Piano>) {
    let Some(mut p) = midi::reload(written) else {
        return (0, 0, None);
    };
    let before = p.notes.len();
    p.notes.retain(|n| {
        (midi::tick_to_time(n.end) - midi::tick_to_time(n.start)) >= o.min_note_sec
            && n.velocity >= o.min_velocity
            && (o.min_pitch..=o.max_pitch).contains(&n.pitch)
    });
    expand_velocities(&mut p, o.velocity_gamma, o.min_velocity);
    let after = p.notes.len();
    (before, after, Some(p))
}
