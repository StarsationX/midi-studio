//! Tuning correction before Transkun (audio_utils.retune_for_transkun).
//!
//! Transkun only knows a piano tuned to A440. An upright 41 cents sharp gave
//! 201 notes where the in-tune copy gave 507: notes near halfway between two
//! keys get dropped. FORGE_RETUNE=0 turns the correction off.

use crate::audio::Audio;
use crate::resample::resample_hq;
use anyhow::Result;
use realfft::RealFftPlanner;

pub const RETUNE_MIN_CENTS: f64 = 15.0;
const RATE: f64 = 22050.0;
const N: usize = 16384;
const HOP: usize = 8192;

/// Offset from A440 in cents, in [-50, 50): the magnitude-weighted circular
/// mean of every spectral peak's distance to its nearest equal-tempered pitch
/// (scipy.signal.stft framing: zero boundary, zero-padded to whole frames).
pub fn tuning_cents(y: &[f32], sr: f64) -> f64 {
    let (fmin, fmax) = (80.0, 1000.0);
    let mut x = vec![0f32; N / 2];
    x.extend_from_slice(y);
    x.extend(std::iter::repeat_n(0f32, N / 2));
    let extra = (HOP - (x.len().saturating_sub(N)) % HOP) % HOP;
    x.extend(std::iter::repeat_n(0f32, extra));
    let win: Vec<f32> = (0..N).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N as f64).cos()) as f32).collect();
    let bin = sr / N as f64;
    let lo = (fmin / bin).ceil() as usize;
    let hi = (fmax / bin).ceil() as usize;
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N);
    let (mut buf, mut spec) = (fft.make_input_vec(), fft.make_output_vec());
    let (mut re, mut im) = (0f64, 0f64);
    let mut start = 0;
    while start + N <= x.len() {
        for (b, (s, w)) in buf.iter_mut().zip(x[start..start + N].iter().zip(&win)) {
            *b = s * w;
        }
        fft.process(&mut buf, &mut spec).expect("fft sizes match");
        let col: Vec<f64> = spec[lo..hi].iter().map(|c| c.norm() as f64).collect();
        let top = col.iter().cloned().fold(0.0, f64::max);
        if top > 0.0 {
            for p in 1..col.len().saturating_sub(1) {
                if col[p] >= top * 0.1 && col[p] > col[p - 1] && col[p] > col[p + 1] {
                    let (a, b, c) = ((col[p - 1] + 1e-12).ln(), (col[p] + 1e-12).ln(), (col[p + 1] + 1e-12).ln());
                    let den = a - 2.0 * b + c;
                    let d = if den != 0.0 { 0.5 * (a - c) / den } else { 0.0 };
                    let hz = (lo + p) as f64 * bin + d * bin;
                    let ang = 2.0 * std::f64::consts::PI * 12.0 * (hz / 440.0).log2();
                    re += col[p] * ang.cos();
                    im += col[p] * ang.sin();
                }
            }
        }
        start += HOP;
    }
    if re == 0.0 && im == 0.0 {
        0.0
    } else {
        100.0 * im.atan2(re) / (2.0 * std::f64::consts::PI)
    }
}

/// The measured offset, and an in-tune copy of `a` when it sits
/// RETUNE_MIN_CENTS or more off A440 plus the factor that maps the copy's note
/// times back onto the original. The copy is resampled, not pitch-shifted, so
/// attacks stay intact. None when FORGE_RETUNE=0.
pub fn retune(a: &Audio) -> Result<Option<(f64, Option<(Audio, f64)>)>> {
    if matches!(std::env::var("FORGE_RETUNE").as_deref(), Ok("0" | "false" | "False" | "no")) {
        return Ok(None);
    }
    let ch = a.channels.max(1);
    let mono: Vec<f32> = a.samples.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect();
    let sr = a.sample_rate as f64;
    let cents = tuning_cents(&resample_hq(&mono, 1, sr, RATE)?, RATE);
    if cents.abs() < RETUNE_MIN_CENTS {
        return Ok(Some((cents, None)));
    }
    let ratio = 2f64.powf(-cents / 1200.0);
    let samples = resample_hq(&a.samples, ch, sr, sr / ratio)?;
    Ok(Some((cents, Some((Audio { sample_rate: a.sample_rate, channels: a.channels, samples, kind: a.kind }, ratio)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_detuned_sine() {
        for want in [0.0, 40.0, -30.0] {
            let f = 440.0 * 2f64.powf(want / 1200.0);
            let y: Vec<f32> = (0..(RATE as usize * 3)).map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / RATE).sin() as f32).collect();
            let got = tuning_cents(&y, RATE);
            assert!((got - want).abs() < 2.0, "{want} -> {got}");
        }
    }
}
