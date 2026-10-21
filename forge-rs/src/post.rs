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

/// numpy's float64 `add.reduce` over a contiguous 1-D array: the first
/// element, plus the pairwise sum (8 accumulators, blocks of 128) of the rest.
pub fn numpy_sum_f64(a: &[f64]) -> f64 {
    fn pairwise(a: &[f64]) -> f64 {
        let n = a.len();
        if n < 8 {
            let mut res = 0.0;
            for &v in a {
                res += v;
            }
            res
        } else if n <= 128 {
            let mut r = [0f64; 8];
            r.copy_from_slice(&a[..8]);
            let mut i = 8;
            while i < n - (n % 8) {
                for j in 0..8 {
                    r[j] += a[i + j];
                }
                i += 8;
            }
            let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
            while i < n {
                res += a[i];
                i += 1;
            }
            res
        } else {
            let mut n2 = n / 2;
            n2 -= n2 % 8;
            pairwise(&a[..n2]) + pairwise(&a[n2..])
        }
    }
    match a.split_first() {
        None => 0.0,
        Some((first, rest)) => *first + pairwise(rest),
    }
}

/// The gain stage both normalisers share: `mono = audio.mean(channels)`
/// (float32), `rms = sqrt(mean(mono.astype(float64) ** 2))`, gain to the
/// target, then the peak ceiling, both applied in float32 as numpy does with
/// a Python-float scalar. None when the audio is empty or below 1e-9 RMS
/// (the Python leaves it untouched).
pub fn normalize_gain(audio: &Audio, o: &NormalizeOpts) -> Option<Vec<f32>> {
    if audio.samples.is_empty() {
        return None;
    }
    let mono = Audio::downmix(&audio.samples, audio.channels);
    let sq: Vec<f64> = mono.iter().map(|&v| (v as f64) * (v as f64)).collect();
    let rms = (numpy_sum_f64(&sq) / sq.len() as f64).sqrt();
    if rms < 1e-9 {
        return None;
    }
    let gain = 10f64.powf((o.target_rms_db - db(rms)) / 20.0);
    let g32 = gain as f32;
    let mut x: Vec<f32> = audio.samples.iter().map(|&v| v * g32).collect();
    let peak = x.iter().fold(0f32, |m, v| m.max(v.abs())) as f64;
    let ceiling = 10f64.powf(o.peak_ceiling_db / 20.0);
    if peak > ceiling {
        let s = (ceiling / peak) as f32;
        for v in x.iter_mut() {
            *v *= s;
        }
    }
    Some(x)
}

/// Unit-scale float samples written as soundfile PCM_16 and read back.
pub fn as_pcm16(audio: &Audio, samples: &[f32]) -> Audio {
    let x = samples.iter().map(|&v| crate::separate::f32_to_pcm16(v) as f32 / 32768.0).collect();
    Audio { sample_rate: audio.sample_rate, channels: audio.channels, samples: x, kind: crate::audio::SourceKind::Int(16) }
}

/// audio_utils.load_normalize_save (transcribe.py): the file is always
/// rewritten as PCM_16, normalised or not. Returns 16-bit-quantised audio in
/// readAudio scale (int16 / 2^15), same rate and channel count. `audio` must
/// be unit scale (as `audio::load`).
pub fn loudness_normalize(audio: &Audio, o: &NormalizeOpts) -> Audio {
    match normalize_gain(audio, o) {
        Some(x) => as_pcm16(audio, &x),
        None => as_pcm16(audio, &audio.samples),
    }
}

/// audio_utils.normalize_wav_in_place (song_to_midi.py): rewrites the stem as
/// PCM_16 only when it was loud enough to normalise; a silent stem keeps its
/// original file (and so its sample format).
pub fn normalize_in_place(audio: &Audio, o: &NormalizeOpts) -> Audio {
    match normalize_gain(audio, o) {
        Some(x) => as_pcm16(audio, &x),
        None => audio.clone(),
    }
}

#[derive(Debug, Clone)]
pub struct CleanOpts {
    pub min_note_sec: f64,
    pub min_velocity: u8,
    pub min_pitch: u8,
    pub max_pitch: u8,
    pub velocity_gamma: f64,
    /// song_to_midi's MAX_POLYPHONY (0 = no cap; transcribe.py has none).
    pub max_polyphony: usize,
}

impl Default for CleanOpts {
    fn default() -> Self {
        CleanOpts { min_note_sec: 0.03, min_velocity: 20, min_pitch: 21, max_pitch: 108, velocity_gamma: 0.85, max_polyphony: 0 }
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
    if o.max_polyphony > 0 {
        p.notes = cap_polyphony(std::mem::take(&mut p.notes), o.max_polyphony);
    }
    expand_velocities(&mut p, o.velocity_gamma, o.min_velocity);
    let after = p.notes.len();
    (before, after, Some(p))
}

/// song_to_midi._cap_polyphony: notes sorted by start (stable), grouped by
/// onsets within 35 ms of the group's first, and a group larger than
/// `max_poly` keeps its loudest `max_poly` (stable among equal velocities).
pub fn cap_polyphony(mut notes: Vec<midi::MidiNote>, max_poly: usize) -> Vec<midi::MidiNote> {
    if max_poly == 0 || notes.len() <= max_poly {
        return notes;
    }
    const Q: f64 = 0.035;
    notes.sort_by_key(|n| n.start);
    let flush = |group: &mut Vec<midi::MidiNote>, out: &mut Vec<midi::MidiNote>| {
        if group.len() > max_poly {
            group.sort_by(|a, b| b.velocity.cmp(&a.velocity));
            group.truncate(max_poly);
        }
        out.append(group);
    };
    let mut out = Vec::with_capacity(notes.len());
    let mut group = Vec::new();
    let mut gstart: Option<f64> = None;
    for nt in notes {
        let s = midi::tick_to_time(nt.start);
        match gstart {
            Some(g) if s - g > Q => {
                flush(&mut group, &mut out);
                group.push(nt);
                gstart = Some(s);
            }
            _ => {
                gstart.get_or_insert(s);
                group.push(nt);
            }
        }
    }
    flush(&mut group, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi::MidiNote;

    #[test]
    fn numpy_pairwise_sum_matches_reference_shape() {
        let v: Vec<f64> = (0..1000).map(|i| ((i * 7919) % 1000) as f64 * 1e-3 + 1e-9 * i as f64).collect();
        let s = numpy_sum_f64(&v);
        let naive: f64 = v.iter().sum();
        assert!((s - naive).abs() < 1e-9);
        assert_eq!(numpy_sum_f64(&[]), 0.0);
        assert_eq!(numpy_sum_f64(&[2.5]), 2.5);
    }

    #[test]
    fn polyphony_cap_keeps_loudest_per_chord() {
        let n = |start: u32, pitch: u8, velocity: u8| MidiNote { start, end: start + 480, pitch, velocity };
        // ticks at 120 BPM / 960: 1 tick = 0.52 ms, 35 ms = 67.2 ticks
        let notes = vec![n(0, 60, 50), n(10, 64, 90), n(60, 67, 70), n(67, 71, 90), n(2000, 60, 10), n(2001, 62, 20)];
        let out = cap_polyphony(notes, 2);
        let got: Vec<(u32, u8)> = out.iter().map(|m| (m.start, m.pitch)).collect();
        assert_eq!(got, vec![(10, 64), (67, 71), (2000, 60), (2001, 62)]);
        assert_eq!(cap_polyphony(vec![n(0, 60, 1)], 0).len(), 1);
    }
}