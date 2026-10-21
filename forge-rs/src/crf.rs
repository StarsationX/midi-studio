//! Semi-CRF Viterbi decode: a port of transkun.CRF.viterbiBackward (the
//! `forward=False` path transcribeFrames uses). All arithmetic is fp32 in
//! the same order as the TorchScript, and max() keeps the first maximum
//! (torch: `if !(v <= best)`), so given identical score/noise the paths are
//! identical.

pub type Interval = (usize, usize);

/// `score`: [T(end)][T(begin)][B], `noise`: [T-1][B].
/// `forced_start`: per-track start frame (None -> 0 for every track).
// `!(v <= best)` is deliberate: it is ATen's max-reduction test (a NaN wins).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn viterbi_backward(
    score: &[f32],
    noise: &[f32],
    t: usize,
    b: usize,
    forced_start: Option<&[usize]>,
) -> Vec<Vec<Interval>> {
    assert_eq!(score.len(), t * t * b);
    assert_eq!(noise.len(), (t - 1) * b);
    let s = |e: usize, bg: usize, k: usize| score[(e * t + bg) * b + k];

    let mut q = vec![0f32; t * b];
    for k in 0..b {
        let d = s(t - 1, t - 1, k);
        q[(t - 1) * b + k] = d * if d > 0.0 { 1.0 } else { 0.0 };
    }
    // ptr[r][k] for begin row r = T-i-1: -1 = skip, else end = r + 1 + sel.
    let mut ptr = vec![-1i32; t.saturating_sub(1) * b];
    let mut best = vec![0f32; b];
    let mut sel = vec![-1i32; b];
    for i in 1..t {
        let r = t - i - 1;
        for k in 0..b {
            best[k] = q[(r + 1) * b + k] + noise[r * b + k];
            sel[k] = -1;
        }
        for kk in 0..i {
            let e = r + 1 + kk;
            let qrow = &q[e * b..(e + 1) * b];
            let srow = &score[(e * t + r) * b..(e * t + r + 1) * b];
            for k in 0..b {
                let v = qrow[k] + srow[k];
                if !(v <= best[k]) {
                    best[k] = v;
                    sel[k] = kk as i32;
                }
            }
        }
        for k in 0..b {
            let d = s(r, r, k);
            q[r * b + k] = best[k] + d * if d > 0.0 { 1.0 } else { 0.0 };
            ptr[r * b + k] = sel[k];
        }
    }

    let mut result = Vec::with_capacity(b);
    for k in 0..b {
        let mut j = forced_start.map(|f| f[k]).unwrap_or(0);
        let mut cur = Vec::new();
        while j + 1 < t {
            let selj = ptr[j * b + k];
            if s(j, j, k) > 0.0 {
                cur.push((j, j));
            }
            if selj < 0 {
                j += 1;
            } else {
                let e = selj as usize + j + 1;
                cur.push((j, e));
                j = e;
            }
        }
        if s(t - 1, t - 1, k) > 0.0 {
            cur.push((t - 1, t - 1));
        }
        result.push(cur);
    }
    result
}
