//! velocityPredictor / refinedOFPredictor (Linear-GELU-Linear) and the
//! read-outs transcribeFrames applies to them:
//!   velocity  = argmax(softmax(logits))                 ("hamming")
//!   ofValue   = clamp((ContinuousBernoulli(logits).mean - 0.5) / 0.99, ±0.5)
//!   ofPresence = presence_logits > 0
//! Dot products accumulate in f64 and GELU is the exact erf form (as
//! nn.GELU()), rounded to fp32 at the layer outputs like torch.

use crate::assets::Mlp;
use crate::config::{CTX_DIM, HEAD_HIDDEN};
use rayon::prelude::*;

#[derive(Debug, Clone, Copy)]
pub struct Attributes {
    pub velocity: u8,
    /// Refined onset / offset, in frames, already as torch's fp32 values.
    pub of_value: [f32; 2],
    pub of_presence: [bool; 2],
}

/// Raw head outputs (for dumps / comparison).
#[derive(Debug, Clone)]
pub struct HeadRaw {
    pub vel_logits: Vec<f32>,
    pub of_out: [f32; 4],
}

fn mlp_forward(m: &Mlp, x: &[f32], out: &mut [f32]) {
    let d_in = 3 * CTX_DIM;
    let mut h = [0f64; HEAD_HIDDEN];
    for (j, hj) in h.iter_mut().enumerate() {
        let row = &m.w0[j * d_in..(j + 1) * d_in];
        let mut acc = 0f64;
        for (w, v) in row.iter().zip(x) {
            acc += *w as f64 * *v as f64;
        }
        let pre = (acc + m.b0[j] as f64) as f32 as f64;
        // GELU(x) = 0.5 x (1 + erf(x / sqrt 2)), rounded to fp32 like torch
        *hj = (0.5 * pre * (1.0 + libm::erf(pre * std::f64::consts::FRAC_1_SQRT_2))) as f32 as f64;
    }
    for (o, dst) in out.iter_mut().enumerate().take(m.out) {
        let row = &m.w3[o * HEAD_HIDDEN..(o + 1) * HEAD_HIDDEN];
        let mut acc = 0f64;
        for (w, v) in row.iter().zip(h.iter()) {
            acc += *w as f64 * v;
        }
        *dst = (acc + m.b3[o] as f64) as f32;
    }
}

/// torch.distributions.ContinuousBernoulli(logits=l).mean, fp32 semantics
/// for the region tests and clamping, f64 arithmetic in between.
fn cb_mean(logit: f32) -> f32 {
    // probs = clamp_probs(sigmoid(logits)), eps = finfo(float32).eps
    let p = 1.0 / (1.0 + (-(logit as f64)).exp());
    let p32 = (p as f32).clamp(f32::EPSILON, 1.0 - f32::EPSILON);
    let outside = p32 <= 0.499f32 || p32 > 0.501f32;
    let p = p32 as f64;
    let m = if outside {
        p / (2.0 * p - 1.0) + 1.0 / ((-p).ln_1p() - p.ln())
    } else {
        let x = p - 0.5;
        0.5 + (1.0 / 3.0 + 16.0 / 45.0 * x * x) * x
    };
    m as f32
}

pub fn attributes_from_raw(raw: &HeadRaw) -> Attributes {
    // argmax over softmax == argmax over logits (softmax is monotone);
    // ties resolve to the first index like torch.argmax.
    let mut best = 0usize;
    for (i, &v) in raw.vel_logits.iter().enumerate() {
        if v > raw.vel_logits[best] {
            best = i;
        }
    }
    let of_value = [0, 1].map(|i| {
        let m = cb_mean(raw.of_out[i]);
        ((m - 0.5f32) / 0.99f32).clamp(-0.5, 0.5)
    });
    Attributes {
        velocity: best as u8,
        of_value,
        of_presence: [raw.of_out[2] > 0.0, raw.of_out[3] > 0.0],
    }
}

/// Run both heads for every interval. `ctx_a` / `ctx_b` are the context
/// vectors at the interval's onset and offset frames.
pub fn predict(
    velocity: &Mlp,
    refined_of: &Mlp,
    pairs: &[(&[f32], &[f32])],
) -> Vec<(HeadRaw, Attributes)> {
    pairs
        .par_iter()
        .map(|(a, b)| {
            let mut x = vec![0f32; 3 * CTX_DIM];
            x[..CTX_DIM].copy_from_slice(a);
            x[CTX_DIM..2 * CTX_DIM].copy_from_slice(b);
            for i in 0..CTX_DIM {
                x[2 * CTX_DIM + i] = a[i] * b[i];
            }
            let mut vel = vec![0f32; 128];
            mlp_forward(velocity, &x, &mut vel);
            let mut of = [0f32; 4];
            mlp_forward(refined_of, &x, &mut of);
            let raw = HeadRaw { vel_logits: vel, of_out: of };
            let attr = attributes_from_raw(&raw);
            (raw, attr)
        })
        .collect()
}
