//! MSST inference.py for BS-Rofo-SW-Fixed without Python: load the mix as
//! `librosa.load(path, sr=44100, mono=False)` does, mono -> stereo, demix
//! (chunk 588800, overlap 2, MSST's fade windows), write each stem as a
//! 32-bit float WAV at `<store_dir>/<file_name>/<instr>.wav` (MSST's
//! default `--pcm_type FLOAT` and `{file_name}/{instr}` template).
//!
//! song_to_midi.py then consumes either `*piano*.wav` (piano mode) or, in
//! general mode, `mix_pitched_stems`: every stem except drums/percussion
//! (and optionally vocals) summed, peak-limited to 0.98, written as 16-bit
//! PCM `general_mix.wav`. Both are provided here.

use crate::audio::{self, Audio};
use crate::demix::{demix, DemixParams, Planar, Stems};
use crate::resample;
use crate::roformer::{Roformer, INSTRUMENTS, N_STEMS, SAMPLE_RATE};
use anyhow::{bail, Context, Result};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// `librosa.load(path, sr=44100, mono=False)` then inference.py's
/// mono -> stereo duplication. Returns planar stereo at 44.1 kHz.
pub fn prepare_mix(a: &Audio) -> Result<Planar> {
    let ch = a.channels;
    if ch == 0 || a.frames() == 0 {
        bail!("empty audio");
    }
    let mut planar: Planar = (0..ch).map(|c| a.samples.iter().skip(c).step_by(ch).copied().collect()).collect();
    if a.sample_rate != SAMPLE_RATE {
        // librosa.resample(res_type="soxr_hq"): soxr per channel
        // (np.apply_along_axis), then fix_length to ceil(n * ratio).
        let ratio = SAMPLE_RATE as f64 / a.sample_rate as f64;
        let n_out = (a.frames() as f64 * ratio).ceil() as usize;
        planar = planar
            .iter()
            .map(|c| {
                let mut y = resample::resample_hq(c, 1, a.sample_rate as f64, SAMPLE_RATE as f64)?;
                y.resize(n_out, 0.0);
                Ok(y)
            })
            .collect::<Result<_>>()?;
    }
    match planar.len() {
        1 => {
            let m = planar.pop().unwrap();
            Ok(vec![m.clone(), m])
        }
        2 => Ok(planar),
        n => bail!("{n}-channel input: MSST's BS-Rofo-SW model only takes mono or stereo"),
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SepTimings {
    pub load_model_s: f64,
    pub decode_s: f64,
    pub demix_s: f64,
    pub chunks: usize,
    pub write_s: f64,
}

/// MSST `demix` with the network on `model`, printing progress per chunk.
pub fn separate_mix(model: &mut Roformer, mix: &Planar, p: &DemixParams, verbose: bool) -> Result<(Stems, usize)> {
    let total = {
        let len = mix[0].len();
        let lp = if len > 2 * p.border() && p.border() > 0 { len + 2 * p.border() } else { len };
        lp.div_ceil(p.step())
    };
    let mut done = 0usize;
    let t0 = Instant::now();
    let stems = demix(mix, N_STEMS, p, |part| {
        let out = model.forward(part)?;
        done += 1;
        if verbose {
            eprintln!("  chunk {done}/{total}  ({:.1}s)", t0.elapsed().as_secs_f64());
        }
        Ok(out)
    })?;
    Ok((stems, done))
}

/// Interleave planar channels.
pub fn interleave(ch: &[Vec<f32>]) -> Vec<f32> {
    let n = ch[0].len();
    let mut out = Vec::with_capacity(n * ch.len());
    for i in 0..n {
        for c in ch {
            out.push(c[i]);
        }
    }
    out
}

fn wav_header(w: &mut impl Write, channels: u16, rate: u32, bits: u16, format: u16, data_bytes: u32) -> std::io::Result<()> {
    let block = channels * bits / 8;
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + data_bytes).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&format.to_le_bytes())?;
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&rate.to_le_bytes())?;
    w.write_all(&(rate * block as u32).to_le_bytes())?;
    w.write_all(&block.to_le_bytes())?;
    w.write_all(&bits.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&data_bytes.to_le_bytes())
}

/// 32-bit IEEE float WAV (soundfile subtype FLOAT).
pub fn write_wav_f32(path: &Path, ch: &[Vec<f32>], rate: u32) -> Result<()> {
    let data = interleave(ch);
    let bytes = u32::try_from(data.len() * 4).context("wav too large")?;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?);
    wav_header(&mut f, ch.len() as u16, rate, 32, 3, bytes)?;
    for v in data {
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

/// Float -> PCM_16 as soundfile 0.13.1's bundled libsndfile 1.2.2 writes
/// it (measured, 0 mismatches over 400k boundary-dense samples and the
/// real general mix): `rint(x * 2^31)` in f32, clamped to i32, then `>> 16`.
/// (`rint(x * 32767)` misses ~50% of samples by 1-2 LSB; plain
/// `floor(x * 32768)` misses values within half an i32 step below an integer.)
#[inline]
pub fn f32_to_pcm16(x: f32) -> i16 {
    let v = (x * 2147483648.0f32).round_ties_even() as f64;
    let v = v.clamp(-2147483648.0, 2147483647.0) as i64;
    (v >> 16) as i16
}

/// 16-bit PCM WAV, as `sf.write(path, float32_array, sr)` writes it.
pub fn write_wav_pcm16(path: &Path, ch: &[Vec<f32>], rate: u32) -> Result<()> {
    let data = interleave(ch);
    let bytes = u32::try_from(data.len() * 2).context("wav too large")?;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?);
    wav_header(&mut f, ch.len() as u16, rate, 16, 1, bytes)?;
    for v in data {
        f.write_all(&f32_to_pcm16(v).to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

/// MSST file layout: `<store_dir>/<file_name>/<instr>.wav`.
pub fn write_stems(store_dir: &Path, file_name: &str, stems: &Stems) -> Result<Vec<PathBuf>> {
    let dir = store_dir.join(file_name);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let mut paths = Vec::new();
    for (name, st) in INSTRUMENTS.iter().zip(stems) {
        let p = dir.join(format!("{name}.wav"));
        write_wav_f32(&p, st, SAMPLE_RATE)?;
        paths.push(p);
    }
    Ok(paths)
}

/// song_to_midi.mix_pitched_stems on in-memory stems: stems in sorted
/// file-name order, minus any whose name contains an excluded word,
/// summed in fp32 (`mix = mix + audio`), then `mix / peak * 0.98` when the
/// peak exceeds 1.0.
pub fn mix_pitched(stems: &Stems, exclude: &[&str]) -> Planar {
    let mut order: Vec<usize> = (0..N_STEMS).collect();
    order.sort_by_key(|&i| format!("{}.wav", INSTRUMENTS[i]));
    let picked: Vec<usize> = order
        .iter()
        .copied()
        .filter(|&i| !exclude.iter().any(|x| format!("{}.wav", INSTRUMENTS[i]).contains(x)))
        .collect();
    let picked = if picked.is_empty() { order } else { picked };
    let mut mix: Planar = stems[picked[0]].clone();
    for &i in &picked[1..] {
        for (m, a) in mix.iter_mut().zip(&stems[i]) {
            for (x, &y) in m.iter_mut().zip(a) {
                *x += y;
            }
        }
    }
    let peak = mix.iter().flatten().fold(0f32, |m, &v| m.max(v.abs()));
    if peak as f64 > 1.0 {
        for x in mix.iter_mut().flatten() {
            *x = *x / peak * 0.98f32;
        }
    }
    mix
}

/// Default song_to_midi EXCLUDE_STEMS ("drum,percussion"), + "vocal" when
/// EXCLUDE_VOCALS is set.
pub fn default_excludes(exclude_vocals: bool) -> Vec<&'static str> {
    let mut v = vec!["drum", "percussion"];
    if exclude_vocals {
        v.push("vocal");
    }
    v
}

/// Decode + resample a file to the planar stereo mix MSST sees.
pub fn load_mix(path: &Path) -> Result<Planar> {
    prepare_mix(&audio::load(path)?)
}
