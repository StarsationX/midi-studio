//! `soxr.resample(x, in_rate, out_rate)` (quality "HQ"), via the vendored
//! libsoxr python-soxr 0.5.0 bundles, driven exactly like its
//! `csoxr_divide_proc<float>` (see vendor/forge_soxr.c).

use anyhow::{bail, Result};
use std::ffi::CStr;
use std::os::raw::{c_char, c_uint, c_ulong};

extern "C" {
    fn forge_soxr_out_len(in_rate: f64, out_rate: f64, ilen: usize) -> usize;
    fn forge_soxr_resample_f32(
        in_rate: f64,
        out_rate: f64,
        channels: c_uint,
        x: *const f32,
        ilen: usize,
        y: *mut f32,
        olen: usize,
        quality: c_ulong,
        out_done: *mut usize,
    ) -> *const c_char;
    fn forge_soxr_hq() -> c_ulong;
    fn forge_soxr_version() -> *const c_char;
}

pub fn libsoxr_version() -> String {
    unsafe { CStr::from_ptr(forge_soxr_version()).to_string_lossy().into_owned() }
}

/// Resample interleaved f32 audio with soxr HQ. Returns interleaved output.
pub fn resample_hq(x: &[f32], channels: usize, in_rate: f64, out_rate: f64) -> Result<Vec<f32>> {
    if channels == 0 || !x.len().is_multiple_of(channels) {
        bail!("bad channel layout");
    }
    if in_rate <= 0.0 || out_rate <= 0.0 {
        bail!("Sample rate should be over 0");
    }
    let ilen = x.len() / channels;
    unsafe {
        let olen = forge_soxr_out_len(in_rate, out_rate, ilen);
        let mut y = vec![0f32; olen * channels];
        let mut done = 0usize;
        let err = forge_soxr_resample_f32(
            in_rate,
            out_rate,
            channels as c_uint,
            x.as_ptr(),
            ilen,
            y.as_mut_ptr(),
            olen,
            forge_soxr_hq(),
            &mut done,
        );
        if !err.is_null() {
            bail!("soxr: {}", CStr::from_ptr(err).to_string_lossy());
        }
        y.truncate(done * channels);
        Ok(y)
    }
}
