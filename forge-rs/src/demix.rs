//! MSST's `demix()` (utils/model_utils.py, generic mode) and the bits of
//! inference.py around it, operation for operation:
//!
//! * `fade = chunk // 10`, `step = chunk // num_overlap`, `border = chunk - step`
//! * if `len > 2 * border`: reflect-pad the mix by `border` on both sides
//! * walk `i = 0, step, 2 * step, ..` while `i < padded_len`; each part is
//!   `mix[:, i:i+chunk]`, right-padded to `chunk` (reflect if the part is
//!   longer than `chunk // 2`, zeros otherwise)
//! * parts are grouped into batches of `batch_size`; the window for a whole
//!   batch is chosen from `i` after its last part was queued: fade-in removed
//!   when `i - step == 0`, else fade-out removed when `i >= padded_len`
//!   (MSST quirk: with batch > 1 that decision covers every part in the batch)
//! * `result += out[..seg_len] * window[..seg_len]`, `counter += window[..seg_len]`
//!   in fp32, then `result / counter`, `nan_to_num`, crop the border.
//!
//! `counter` is identical for every stem and channel, so it is kept once.

use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy)]
pub struct DemixParams {
    /// Samples per chunk (config.audio.chunk_size; 588800 for BS-Rofo-SW-Fixed).
    pub chunk_size: usize,
    /// config.inference.num_overlap.
    pub num_overlap: usize,
    /// config.inference.batch_size. Only changes the fade-window choice
    /// (see module docs); forge-rs always runs the network one chunk at a time.
    pub batch_size: usize,
}

impl DemixParams {
    pub fn bs_rofo_sw() -> Self {
        DemixParams { chunk_size: 588_800, num_overlap: 2, batch_size: 1 }
    }
    pub fn fade(&self) -> usize {
        self.chunk_size / 10
    }
    pub fn step(&self) -> usize {
        self.chunk_size / self.num_overlap
    }
    pub fn border(&self) -> usize {
        self.chunk_size - self.step()
    }
}

/// `torch.linspace(start, end, steps)` (fp32, CPU) value for value: ATen
/// computes `start + step*idx` below `steps/2` and `end - step*(steps-idx-1)`
/// from there on, in f32 with `step = (end - start) / (steps - 1)`. Verified
/// bit-exact against torch 2.11 (AVX2) for 200, 220, 441 and 58880 steps.
pub fn torch_linspace_f32(start: f32, end: f32, steps: usize) -> Vec<f32> {
    match steps {
        0 => Vec::new(),
        1 => vec![start],
        _ => {
            let step = (end - start) / (steps - 1) as f32;
            let halfway = steps / 2;
            (0..steps)
                .map(|idx| {
                    if idx < halfway {
                        start + step * idx as f32
                    } else {
                        end - step * (steps - idx - 1) as f32
                    }
                })
                .collect()
        }
    }
}

/// MSST `_getWindowingArray(window_size, fade_size)`.
pub fn windowing_array(p: &DemixParams) -> Vec<f32> {
    let fade = p.fade();
    let mut w = vec![1f32; p.chunk_size];
    let fadein = torch_linspace_f32(0.0, 1.0, fade);
    let fadeout = torch_linspace_f32(1.0, 0.0, fade);
    let n = p.chunk_size;
    w[n - fade..].copy_from_slice(&fadeout);
    w[..fade].copy_from_slice(&fadein);
    w
}

/// torch `F.pad(x, (left, right), mode="reflect")` on one channel.
pub fn reflect_pad(x: &[f32], left: usize, right: usize) -> Vec<f32> {
    let n = x.len();
    assert!(left < n && right < n, "reflect pad {left}/{right} >= len {n}");
    let mut out = Vec::with_capacity(n + left + right);
    for j in (1..=left).rev() {
        out.push(x[j]);
    }
    out.extend_from_slice(x);
    for j in 1..=right {
        out.push(x[n - 1 - j]);
    }
    out
}

/// Planar multichannel audio: `channels[c][t]`.
pub type Planar = Vec<Vec<f32>>;

/// Separated stems: `stems[n][c][t]`.
pub type Stems = Vec<Planar>;

/// Run MSST's demix over `mix` (planar, all channels the same length).
/// `model` gets one chunk (planar, `chunk_size` per channel) and returns
/// `n_stems` x channels x `chunk_size`.
pub fn demix<M>(mix: &Planar, n_stems: usize, p: &DemixParams, mut model: M) -> Result<Stems>
where
    M: FnMut(&Planar) -> Result<Stems>,
{
    let chans = mix.len();
    if chans == 0 {
        bail!("no channels");
    }
    let length_init = mix[0].len();
    if mix.iter().any(|c| c.len() != length_init) {
        bail!("channels differ in length");
    }
    let chunk = p.chunk_size;
    let fade = p.fade();
    let step = p.step();
    let border = p.border();
    if step == 0 || fade == 0 {
        bail!("chunk_size {chunk} too small");
    }
    let windowing = windowing_array(p);
    let padded_used = length_init > 2 * border && border > 0;
    let mix: Planar = if padded_used {
        mix.iter().map(|c| reflect_pad(c, border, border)).collect()
    } else {
        mix.clone()
    };
    let total = mix[0].len();

    let mut result: Stems = vec![vec![vec![0f32; total]; chans]; n_stems];
    let mut counter = vec![0f32; total];

    let mut i = 0usize;
    let mut batch: Vec<(usize, usize, Stems)> = Vec::new();
    while i < total {
        let end = (i + chunk).min(total);
        let chunk_len = end - i;
        let part: Planar = mix
            .iter()
            .map(|c| {
                let s = &c[i..end];
                if chunk_len == chunk {
                    s.to_vec()
                } else if chunk_len > chunk / 2 {
                    reflect_pad(s, 0, chunk - chunk_len)
                } else {
                    let mut v = s.to_vec();
                    v.resize(chunk, 0.0);
                    v
                }
            })
            .collect();
        let out = model(&part)?;
        if out.len() != n_stems || out.iter().any(|s| s.len() != chans || s.iter().any(|c| c.len() != chunk)) {
            bail!("model returned the wrong shape");
        }
        batch.push((i, chunk_len, out));
        i += step;

        if batch.len() >= p.batch_size.max(1) || i >= total {
            let mut window = windowing.clone();
            if i - step == 0 {
                window[..fade].fill(1.0);
            } else if i >= total {
                window[chunk - fade..].fill(1.0);
            }
            for (start, seg_len, out) in batch.drain(..) {
                let w = &window[..seg_len];
                for (res_n, out_n) in result.iter_mut().zip(&out) {
                    for (res_c, out_c) in res_n.iter_mut().zip(out_n) {
                        for ((r, &o), &wv) in res_c[start..start + seg_len].iter_mut().zip(&out_c[..seg_len]).zip(w) {
                            *r += o * wv;
                        }
                    }
                }
                for (c, &wv) in counter[start..start + seg_len].iter_mut().zip(w) {
                    *c += wv;
                }
            }
        }
    }

    let (lo, hi) = if padded_used { (border, total - border) } else { (0, total) };
    let stems = result
        .into_iter()
        .map(|res_n| {
            res_n
                .into_iter()
                .map(|res_c| {
                    res_c[lo..hi]
                        .iter()
                        .zip(&counter[lo..hi])
                        .map(|(&r, &c)| nan_to_num(r / c))
                        .collect()
                })
                .collect()
        })
        .collect();
    Ok(stems)
}

/// `np.nan_to_num(x, nan=0.0)` for f32.
#[inline]
pub fn nan_to_num(x: f32) -> f32 {
    if x.is_nan() {
        0.0
    } else if x == f32::INFINITY {
        f32::MAX
    } else if x == f32::NEG_INFINITY {
        f32::MIN
    } else {
        x
    }
}
