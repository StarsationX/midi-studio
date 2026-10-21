//! `torch.stft` / `torch.istft` as BSRoformer.forward calls them:
//! n_fft = win_length = 2048, hop 512, `torch.hann_window(2048)` (periodic),
//! center=True with reflect padding, normalized=False, onesided.
//!
//! Precision: the window and the emitted spectrum are fp32 like torch; the
//! FFTs, the complex mask product, the overlap-add and the envelope division
//! run in f64 and are rounded once at the end, so what is left versus torch
//! is torch's own fp32 FFT rounding (~1e-7 relative).

use rayon::prelude::*;
use realfft::num_complex::Complex;
use realfft::RealFftPlanner;
use std::sync::Arc;

pub const N_FFT: usize = 2048;
pub const HOP: usize = 512;
pub const N_BINS: usize = N_FFT / 2 + 1;

/// Frames `torch.stft(center=True)` produces for `len` samples.
pub fn n_frames(len: usize) -> usize {
    1 + len / HOP
}

/// `torch.hann_window(n)` (periodic=True) in fp32, built the way ATen does:
/// `arange(n) * (2*pi/n)` -> cos -> `* -0.5` -> `+ 0.5`, every step in f32.
/// The cos itself is evaluated in f64 and rounded (torch uses SLEEF's 1-ulp
/// cosf), so a few entries may sit 1 ulp apart from torch's.
pub fn hann_periodic(n: usize) -> Vec<f32> {
    let k = (std::f64::consts::PI * 2.0 / n as f64) as f32;
    (0..n)
        .map(|i| {
            let a = i as f32 * k;
            let c = (a as f64).cos() as f32;
            c * -0.5f32 + 0.5f32
        })
        .collect()
}

#[inline]
fn reflect(i: isize, len: usize) -> usize {
    let n = len as isize;
    let mut j = i;
    if j < 0 {
        j = -j;
    }
    if j >= n {
        j = 2 * (n - 1) - j;
    }
    j as usize
}

/// Shared FFT plans + window.
pub struct Stft {
    window: Vec<f32>,
    fwd: Arc<dyn realfft::RealToComplex<f64>>,
    inv: Arc<dyn realfft::ComplexToReal<f64>>,
}

impl Default for Stft {
    fn default() -> Self {
        Self::new()
    }
}

impl Stft {
    pub fn new() -> Self {
        let mut p = RealFftPlanner::<f64>::new();
        Stft { window: hann_periodic(N_FFT), fwd: p.plan_fft_forward(N_FFT), inv: p.plan_fft_inverse(N_FFT) }
    }

    pub fn window(&self) -> &[f32] {
        &self.window
    }

    /// One channel -> spectrum laid out `[t][f]` (complex f32, fp32-rounded).
    pub fn forward(&self, x: &[f32]) -> Vec<Complex<f32>> {
        let len = x.len();
        assert!(len > N_FFT / 2, "reflect pad needs more than {} samples", N_FFT / 2);
        let t_frames = n_frames(len);
        let mut out = vec![Complex::new(0f32, 0f32); t_frames * N_BINS];
        let half = (N_FFT / 2) as isize;
        out.par_chunks_mut(N_BINS).enumerate().for_each_init(
            || (self.fwd.make_input_vec(), self.fwd.make_output_vec(), self.fwd.make_scratch_vec()),
            |(inp, spec, scratch), (t, dst)| {
                let base = (t * HOP) as isize - half;
                for (i, v) in inp.iter_mut().enumerate() {
                    let s = x[reflect(base + i as isize, len)];
                    *v = (s * self.window[i]) as f64;
                }
                self.fwd.process_with_scratch(inp, spec, scratch).expect("rfft");
                for (d, c) in dst.iter_mut().zip(spec.iter()) {
                    *d = Complex::new(c.re as f32, c.im as f32);
                }
            },
        );
        out
    }

    /// `sum_t window^2` overlap-added, as torch.istft's envelope (f64).
    fn envelope(&self, t_frames: usize) -> Vec<f64> {
        let mut env = vec![0f64; N_FFT + HOP * (t_frames - 1)];
        for t in 0..t_frames {
            for (i, &w) in self.window.iter().enumerate() {
                env[t * HOP + i] += (w as f64) * (w as f64);
            }
        }
        env
    }

    /// Inverse of a spectrum given frame-by-frame by `frame(t, &mut bins)`
    /// (f64 complex, `N_BINS` long), `torch.istft(center=True, length)`.
    pub fn inverse_with<F>(&self, t_frames: usize, length: usize, mut frame: F) -> Vec<f32>
    where
        F: FnMut(usize, &mut [Complex<f64>]),
    {
        let total = N_FFT + HOP * (t_frames - 1);
        let start = N_FFT / 2;
        assert!(start + length <= total, "istft length {length} exceeds {t_frames} frames");
        let env = self.envelope(t_frames);
        let mut acc = vec![0f64; total];
        let mut bins = self.inv.make_input_vec();
        let mut buf = self.inv.make_output_vec();
        let mut scratch = self.inv.make_scratch_vec();
        let norm = 1.0 / N_FFT as f64;
        for t in 0..t_frames {
            frame(t, &mut bins);
            // c2r ignores the imaginary part of DC and Nyquist (pocketfft too)
            bins[0].im = 0.0;
            bins[N_BINS - 1].im = 0.0;
            self.inv.process_with_scratch(&mut bins, &mut buf, &mut scratch).expect("irfft");
            let o = t * HOP;
            for (i, &v) in buf.iter().enumerate() {
                acc[o + i] += v * norm * self.window[i] as f64;
            }
        }
        (0..length)
            .map(|j| {
                let e = env[start + j];
                debug_assert!(e > 1e-11);
                (acc[start + j] / e) as f32
            })
            .collect()
    }

    /// istft of a `[t][f]` complex f32 spectrum (as `forward` returns it).
    pub fn inverse(&self, spec: &[Complex<f32>], length: usize) -> Vec<f32> {
        let t_frames = spec.len() / N_BINS;
        self.inverse_with(t_frames, length, |t, bins| {
            for (b, c) in bins.iter_mut().zip(&spec[t * N_BINS..(t + 1) * N_BINS]) {
                *b = Complex::new(c.re as f64, c.im as f64);
            }
        })
    }
}
