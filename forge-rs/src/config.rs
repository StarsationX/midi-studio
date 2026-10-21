//! Transkun v2 hyper-parameters (pretrained/2.0.conf + ModelTransformer).

pub const FS: u32 = 44100;
pub const HOP_SIZE: usize = 1024;
pub const WINDOW_SIZE: usize = 4096;
pub const N_FREQ: usize = WINDOW_SIZE / 2 + 1;
pub const N_MELS: usize = 229;
/// Hann + nExtraWins (5) learned Gaussian windows.
pub const N_WINDOWS: usize = 6;
pub const MEL_EPS: f64 = 1e-5;
pub const SEGMENT_SIZE_SEC: f64 = 16.0;
pub const SEGMENT_HOP_SEC: f64 = 8.0;
/// baseSize * scoringExpansionFactor.
pub const CTX_DIM: usize = 256;
pub const HEAD_HIDDEN: usize = 512;

/// [-64, -67] (sustain / una corda pedals) + MIDI 21..=108.
pub fn target_midi_pitch() -> Vec<i32> {
    let mut v = vec![-64, -67];
    v.extend(21..=108);
    v
}

pub const N_SYMBOLS: usize = 90;

/// Samples in one model segment: ceil(16 s * fs).
pub fn segment_samples() -> usize {
    (SEGMENT_SIZE_SEC * FS as f64).ceil() as usize
}

/// Frames per segment as makeFrame produces them: ceil(len / hop) + 1.
pub fn frames_per_segment() -> usize {
    segment_samples().div_ceil(HOP_SIZE) + 1
}
