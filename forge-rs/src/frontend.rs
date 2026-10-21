//! Segmentation, framing and the spectrogram front-end
//! (TransKun.transcribe slicing + makeFrame + processFramesBatch's gain
//! normalisation + MelSpectrum with 6 windows, log, toMono).
//!
//! Precision: inputs, windows, filterbank and the emitted features are fp32
//! like torch; the FFT, power, mel projection and log run in f64 and are
//! rounded once to fp32 at the end, so the only error left is that final
//! rounding (torch's own fp32 pipeline carries more, which is the residual
//! Python-vs-Rust drift).

use crate::assets::Aux;
use crate::config::{
    frames_per_segment, segment_samples, FS, HOP_SIZE, MEL_EPS, N_FREQ, N_MELS, N_WINDOWS,
    WINDOW_SIZE,
};
use rayon::prelude::*;
use realfft::RealFftPlanner;

/// One model segment cut out of the padded signal.
#[derive(Debug, Clone)]
pub struct Segment {
    /// Sample offset `i` into the padded signal.
    pub start: usize,
    /// `i / fs - padTimeBegin`, seconds (f64, as Python computes it).
    pub begin_time: f64,
    /// Exactly `segment_samples()` samples (zero-padded at the tail).
    pub samples: Vec<f32>,
}

/// Mirrors the loop in TransKun.transcribe(): pad both ends by
/// ceil(padTimeBegin * fs), then step by ceil(hop * fs / hopSize) * hopSize.
pub struct Segmenter {
    padded: Vec<f32>,
    pub pad_time_begin: f64,
    pub step_size: usize,
    pub segment_size: usize,
}

impl Segmenter {
    pub fn new(mono: &[f32], step_in_second: f64) -> Self {
        let seg_sec = crate::config::SEGMENT_SIZE_SEC;
        let pad_time_begin = seg_sec - step_in_second;
        let fs = FS as f64;
        let pad = (pad_time_begin * fs).ceil() as usize;
        let mut padded = vec![0f32; mono.len() + 2 * pad];
        padded[pad..pad + mono.len()].copy_from_slice(mono);
        let step_size = (step_in_second * fs / HOP_SIZE as f64).ceil() as usize * HOP_SIZE;
        let segment_size = (seg_sec * fs).ceil() as usize;
        debug_assert_eq!(segment_size, segment_samples());
        Segmenter { padded, pad_time_begin, step_size, segment_size }
    }

    pub fn n_sample(&self) -> usize {
        self.padded.len()
    }

    pub fn starts(&self) -> impl Iterator<Item = usize> {
        (0..self.padded.len()).step_by(self.step_size)
    }

    pub fn count(&self) -> usize {
        self.padded.len().div_ceil(self.step_size)
    }

    pub fn segment(&self, start: usize) -> Segment {
        let end = (start + self.segment_size).min(self.padded.len());
        let mut samples = vec![0f32; self.segment_size];
        samples[..end - start].copy_from_slice(&self.padded[start..end]);
        Segment {
            start,
            begin_time: start as f64 / FS as f64 - self.pad_time_begin,
            samples,
        }
    }

    /// `int(stepSize / hopSize)`: frame shift between consecutive segments.
    pub fn step_frames(&self) -> usize {
        self.step_size / HOP_SIZE
    }
}

/// Precomputed front-end constants.
pub struct FrontEnd {
    windows: Vec<f32>,
    /// Sparse mel filterbank: per mel band, (freq bin, weight as f64).
    mel_rows: Vec<Vec<(usize, f64)>>,
}

impl FrontEnd {
    pub fn new(aux: &Aux) -> Self {
        let mut mel_rows = vec![Vec::new(); N_MELS];
        for k in 0..N_FREQ {
            for (m, row) in mel_rows.iter_mut().enumerate() {
                let w = aux.freq2mels[k * N_MELS + m];
                if w != 0.0 {
                    row.push((k, w as f64));
                }
            }
        }
        FrontEnd { windows: aux.windows.clone(), mel_rows }
    }

    /// Features for one segment, laid out [T][N_MELS][N_WINDOWS] (the ONNX
    /// input `features` [1, T, 229, 6]).
    pub fn features(&self, samples: &[f32]) -> Vec<f32> {
        assert_eq!(samples.len(), segment_samples());
        let t_frames = frames_per_segment();
        // makeFrame(leftPaddingHalfFrame=True): lPad = W/2, rPad so that
        // (nFrame-1)*hop + W samples exist; frame t = padded[t*hop .. +W].
        let lpad = WINDOW_SIZE / 2;
        let rpad = (t_frames - 1) * HOP_SIZE + WINDOW_SIZE / 2 - samples.len();
        let mut x = vec![0f32; lpad + samples.len() + rpad];
        x[lpad..lpad + samples.len()].copy_from_slice(samples);
        let frame = |t: usize| &x[t * HOP_SIZE..t * HOP_SIZE + WINDOW_SIZE];

        // Gain normalisation over all (overlapping) frame elements:
        //   mean = torch.mean(frames) (fp32), std = torch.std(frames)
        // torch's std on CPU accumulates in double around the fp32 mean.
        let n = (t_frames * WINDOW_SIZE) as f64;
        let sum: f64 = (0..t_frames)
            .into_par_iter()
            .map(|t| frame(t).iter().map(|&v| v as f64).sum::<f64>())
            .sum();
        let mean32 = (sum / n) as f32;
        let m64 = mean32 as f64;
        let ss: f64 = (0..t_frames)
            .into_par_iter()
            .map(|t| frame(t).iter().map(|&v| (v as f64 - m64) * (v as f64 - m64)).sum::<f64>())
            .sum();
        let std32 = (ss / (n - 1.0)).sqrt() as f32;
        let denom = std32 + 1e-8f32;

        let mut out = vec![0f32; t_frames * N_MELS * N_WINDOWS];
        let planner = std::sync::Mutex::new(RealFftPlanner::<f64>::new());
        let fft = planner.lock().unwrap().plan_fft_forward(WINDOW_SIZE);
        let scale = 1.0 / WINDOW_SIZE as f64; // |ortho|^2 = 1/N
        out.par_chunks_mut(N_MELS * N_WINDOWS).enumerate().for_each_init(
            || (fft.make_input_vec(), fft.make_output_vec(), fft.make_scratch_vec(), vec![0f64; N_FREQ]),
            |(inp, spec, scratch, power), (t, dst)| {
                let fr = frame(t);
                for w in 0..N_WINDOWS {
                    let win = &self.windows[w * WINDOW_SIZE..(w + 1) * WINDOW_SIZE];
                    for i in 0..WINDOW_SIZE {
                        // fp32 ops exactly as torch: (x - mean) / (std + 1e-8), * window
                        let xn = (fr[i] - mean32) / denom;
                        inp[i] = (xn * win[i]) as f64;
                    }
                    fft.process_with_scratch(inp, spec, scratch).expect("fft");
                    for (p, c) in power.iter_mut().zip(spec.iter()) {
                        *p = (c.re * c.re + c.im * c.im) * scale;
                    }
                    let log_eps = MEL_EPS.ln();
                    for (m, row) in self.mel_rows.iter().enumerate() {
                        let mut acc = 0f64;
                        for &(k, wk) in row {
                            acc += power[k] * wk;
                        }
                        let v = ((acc + MEL_EPS).ln() - log_eps) / (-log_eps);
                        dst[m * N_WINDOWS + w] = v as f32;
                    }
                }
            },
        );
        out
    }
}
