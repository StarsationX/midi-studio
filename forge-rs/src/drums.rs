//! python-engine/drums_to_midi.py: onset-detect the drum stem (librosa),
//! classify each hit by band energy onto the eight-pad kit, and write a
//! General MIDI drum track.

use crate::dsp::{self, N_BINS, N_FFT};
use crate::pmidi::{Instrument, Note, PrettyMidi};

pub const KICK: u8 = 36;
pub const SNARE: u8 = 38;
pub const CHAT: u8 = 42;
pub const OHAT: u8 = 46;
pub const TOM_LO: u8 = 41;
pub const TOM_MID: u8 = 45;
pub const TOM_HI: u8 = 48;
pub const CRASH: u8 = 49;
pub const RIDE: u8 = 51;

fn gap_scale(note: u8) -> f64 {
    match note {
        36 => 0.8,
        38 => 0.7,
        42 => 0.5,
        46 => 0.9,
        41 | 45 | 48 => 0.9,
        49 => 3.5,
        51 => 1.6,
        _ => 1.0,
    }
}

pub fn note_name(n: u8) -> String {
    match n {
        36 => "kick".into(),
        38 => "snare".into(),
        42 => "chat".into(),
        46 => "ohat".into(),
        41 => "tomL".into(),
        45 => "tomM".into(),
        48 => "tomH".into(),
        49 => "crash".into(),
        51 => "ride".into(),
        o => o.to_string(),
    }
}

/// band_energy(S, freqs, lo, hi): `S[mask].sum(axis=0)` (a running sum down
/// the selected rows, float32).
fn band_energy(s: &[f32], frames: usize, freqs: &[f64], lo: f64, hi: f64) -> Vec<f32> {
    let rows: Vec<usize> = (0..freqs.len()).filter(|&i| freqs[i] >= lo && freqs[i] < hi).collect();
    let mut out = vec![0f32; frames];
    for (k, &r) in rows.iter().enumerate() {
        let row = &s[r * frames..(r + 1) * frames];
        if k == 0 {
            out.copy_from_slice(row);
        } else {
            for (o, v) in out.iter_mut().zip(row) {
                *o += v;
            }
        }
    }
    out
}

/// _norm(v): v / (percentile(v, 95) + 1e-9), float32.
fn norm(v: &[f32]) -> Vec<f32> {
    let p = dsp::percentile_f32(v, 95.0) + 1e-9f64 as f32;
    v.iter().map(|&x| x / p).collect()
}

/// `S[mask, a:b].mean(axis=1)` then the frequency of the largest.
fn frame_peak_freq(s: &[f32], frames: usize, freqs: &[f64], a: usize, b: usize, lo: f64, hi: f64) -> f64 {
    let rows: Vec<usize> = (0..freqs.len()).filter(|&i| freqs[i] >= lo && freqs[i] < hi).collect();
    if rows.is_empty() || b <= a {
        return 0.0;
    }
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (k, &r) in rows.iter().enumerate() {
        let seg = &s[r * frames + a..r * frames + b];
        let sum = dsp::np_sum_f32_pairwise(seg);
        let m = (sum as f64 / seg.len() as f64) as f32;
        if m.is_nan() {
            best = k;
            break;
        }
        if k == 0 || m > best_v {
            best_v = m;
            best = k;
        }
    }
    freqs[rows[best]]
}

fn max_f32(v: &[f32]) -> f32 {
    let mut m = v[0];
    for &x in &v[1..] {
        if x.is_nan() || m.is_nan() {
            m = f32::NAN;
        } else if x > m {
            m = x;
        }
    }
    m
}

struct Measured {
    t: f64,
    a: usize,
    b: usize,
    sub: f64,
    low: f64,
    body: f64,
    crack: f64,
    metal: f64,
    ring: f64,
    strength: f64,
}

/// classify_hits on 22.05 kHz mono audio: (time, note, velocity 0-1).
pub fn classify_hits(y: &[f32], onset_delta: f64, min_gap_ms: i64) -> Vec<(f64, u8, f64)> {
    let sr = 22050.0;
    let hop = 256;
    let (s, n_frames) = dsp::stft_power(y, hop);
    let freqs = dsp::fft_frequencies(sr, N_FFT);
    debug_assert_eq!(freqs.len(), N_BINS);
    let sub = norm(&band_energy(&s, n_frames, &freqs, 25.0, 115.0));
    let low = norm(&band_energy(&s, n_frames, &freqs, 115.0, 260.0));
    let body = norm(&band_energy(&s, n_frames, &freqs, 260.0, 900.0));
    let crack = norm(&band_energy(&s, n_frames, &freqs, 900.0, 3500.0));
    let metal = norm(&band_energy(&s, n_frames, &freqs, 3500.0, 11500.0));

    let env = dsp::onset_strength(&s, n_frames, sr, hop);
    let onsets = dsp::onset_detect(&env, 3, 3, 8, 8, onset_delta as f32, 1);
    // FORGE_RS_DRUMS_DUMP=<dir>: the signal, power spectrogram, onset
    // envelope and onsets, for diffing against librosa.
    if let Some(d) = std::env::var_os("FORGE_RS_DRUMS_DUMP").filter(|v| !v.is_empty()).map(std::path::PathBuf::from) {
        let _ = std::fs::create_dir_all(&d);
        let _ = crate::dump::write_npy_f32(&d.join("y.npy"), &[y.len()], y);
        let _ = crate::dump::write_npy_f32(&d.join("S.npy"), &[N_BINS, n_frames], &s);
        let _ = crate::dump::write_npy_f32(&d.join("env.npy"), &[env.len()], &env);
        let _ = std::fs::write(d.join("onsets.json"), serde_json::to_string(&onsets).unwrap_or_default());
    }
    let env_p95 = dsp::percentile_f32(&env, 95.0) + 1e-9f64 as f32;

    let mut measured = Vec::new();
    for &f in &onsets {
        let t = ((f * hop) as f64) / sr;
        let a = f;
        let b = (f + 7).min(n_frames);
        let c = (f + 18).min(n_frames - 1);
        let peak_metal = max_f32(&metal[a..b]) as f64;
        let strength = (env[f] / env_p95).clamp(0.15, 1.0) as f64;
        measured.push(Measured {
            t,
            a,
            b,
            sub: max_f32(&sub[a..b]) as f64,
            low: max_f32(&low[a..b]) as f64,
            body: max_f32(&body[a..b]) as f64,
            crack: max_f32(&crack[a..b]) as f64,
            metal: peak_metal,
            ring: if b > a { (metal[c] / (peak_metal + 1e-9) as f32) as f64 } else { 0.0 },
            strength,
        });
    }
    if measured.is_empty() {
        return Vec::new();
    }
    let level = |get: fn(&Measured) -> f64, pct: f64, floor: f64| -> f64 {
        let v: Vec<f64> = measured.iter().map(get).collect();
        floor.max(dsp::percentile_f64(&v, pct))
    };
    let kick_at = level(|m| m.sub, 62.0, 0.30);
    let snare_at = level(|m| m.crack, 58.0, 0.22);
    let metal_at = level(|m| m.metal, 45.0, 0.22);
    let body_at = level(|m| m.body, 55.0, 0.25);

    let mut hits: Vec<(f64, u8, f64)> = Vec::new();
    for m in &measured {
        let (e_sub, e_low, e_body, e_crack, e_metal, ring) = (m.sub, m.low, m.body, m.crack, m.metal, m.ring);
        let mut drum: Option<u8> = None;
        let mut cymbal: Option<u8> = None;
        if e_sub > kick_at && e_sub > e_low * 0.95 && e_sub > e_metal * 0.55 {
            drum = Some(KICK);
        }
        let snare_score = e_low * 0.55 + e_body * 0.45 + e_crack * 0.65;
        let tom_score = e_low * 0.65 + e_body * 0.75;
        if drum.is_none() {
            if snare_score > body_at * 2.0 && e_crack > snare_at && e_metal < 1.15f64.max(e_crack * 2.2) {
                drum = Some(SNARE);
            } else if tom_score > body_at * 2.2 && e_metal < 0.62 && e_sub < 1.2 {
                let peak = frame_peak_freq(&s, n_frames, &freqs, m.a, m.b, 90.0, 900.0);
                drum = Some(if peak != 0.0 && peak < 190.0 {
                    TOM_LO
                } else if peak != 0.0 && peak < 340.0 {
                    TOM_MID
                } else {
                    TOM_HI
                });
            }
        }
        if e_metal > metal_at && e_metal > e_body.max(e_crack) * 0.9 {
            cymbal = Some(if ring > 0.48 || e_metal > 1.2 {
                if e_crack > 0.22 || e_body > 0.25 { CRASH } else { RIDE }
            } else if ring > 0.24 {
                OHAT
            } else {
                CHAT
            });
        }
        if drum.is_none() && cymbal.is_none() && e_metal > metal_at * 0.5 {
            cymbal = Some(CHAT);
        }
        for note in [drum, cymbal].into_iter().flatten() {
            let layer = if note == KICK {
                e_sub
            } else if matches!(note, CHAT | OHAT | CRASH | RIDE) {
                e_metal
            } else {
                e_body.max(e_crack)
            };
            let v = (0.35 * m.strength + 0.65 * 1.0f64.min(layer)).clamp(0.15, 1.0);
            hits.push((m.t, note, v));
        }
    }
    // sorted(hits): by time, note, velocity
    hits.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.total_cmp(&b.2)));
    let base = min_gap_ms as f64 / 1000.0;
    let mut last: std::collections::HashMap<u8, f64> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (t, note, v) in hits {
        if let Some(&l) = last.get(&note) {
            if t - l < base * gap_scale(note) {
                continue;
            }
        }
        last.insert(note, t);
        out.push((t, note, v));
    }
    out
}

/// write_midi(hits): PrettyMIDI() with one drum instrument "Drums".
pub fn hits_to_midi(hits: &[(f64, u8, f64)]) -> PrettyMidi {
    let mut pm = PrettyMidi::default_new();
    let mut inst = Instrument::new(0, true, "Drums");
    for &(t, note, v) in hits {
        let vel = (40.0 + 87.0 * v) as i64;
        inst.notes.push(Note { velocity: vel.clamp(0, 127) as u8, pitch: note, start: t, end: t + 0.1 });
    }
    pm.instruments.push(inst);
    pm
}

/// "  N hits in X.Xs, kick:3, snare:2, ..." counts, sorted by note number.
pub fn summary(hits: &[(f64, u8, f64)]) -> String {
    let mut by: std::collections::BTreeMap<u8, usize> = Default::default();
    for &(_, n, _) in hits {
        *by.entry(n).or_default() += 1;
    }
    by.iter().map(|(k, v)| format!("{}:{v}", note_name(*k))).collect::<Vec<_>>().join(", ")
}
