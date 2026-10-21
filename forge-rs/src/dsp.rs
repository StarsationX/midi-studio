//! The numpy / librosa 0.11 / scipy 1.17 operations melody_to_midi.py and
//! drums_to_midi.py use, reproduced with their own evaluation order:
//!
//! * numpy reductions: `add.reduce` along the inner loop's axis starts from
//!   the identity (0.0) and adds a pairwise sum (8 accumulators, blocks of
//!   128) of every element; along a strided outer axis it is a running sum.
//!   `mean` divides in float64 and rounds back. (Measured on the forge env's
//!   numpy 2.4: 1204 of 1204 random vectors, contiguous and strided.)
//! * `np.percentile(method="linear")` with a Python-number q (weak
//!   promotion: the result keeps the array's precision).
//! * `librosa.stft` (float64 FFT of the windowed float32 frames, stored as
//!   complex64), numpy's complex64 `abs`, `librosa.filters.mel`,
//!   `melspectrogram`, `power_to_db`, `onset.onset_strength`,
//!   `onset.onset_detect` (normalise, numba `peak_pick`, `onset_backtrack`).
//! * `scipy.signal.butter(output="sos")` and `sosfiltfilt` (odd padding,
//!   `sosfilt_zi` initial conditions, the Cython direct-form-II loop).

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

// ---- numpy reductions ---------------------------------------------------------

fn pairwise_f32(a: &[f32]) -> f32 {
    let n = a.len();
    if n < 8 {
        let mut res = 0f32;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [0f32; 8];
        r.copy_from_slice(&a[..8]);
        let mut i = 8;
        while i < n - (n % 8) {
            for j in 0..8 {
                r[j] += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pairwise_f32(&a[..n2]) + pairwise_f32(&a[n2..])
    }
}

/// `np.add.reduce` of a float32 vector (contiguous or strided).
pub fn np_sum_f32_pairwise(a: &[f32]) -> f32 {
    0.0 + pairwise_f32(a)
}

/// `np.mean` of a float32 vector (scalar result: float64 division, rounded
/// back to float32).
pub fn np_mean_f32(a: &[f32]) -> f32 {
    if a.is_empty() {
        return f32::NAN;
    }
    (np_sum_f32_pairwise(a) as f64 / a.len() as f64) as f32
}

/// `np.add.reduce` of a contiguous float64 vector.
pub fn np_sum_f64(a: &[f64]) -> f64 {
    crate::post::numpy_sum_f64(a)
}

/// `np.percentile(a, q)` for a Python-number q on a float32 array.
pub fn percentile_f32(v: &[f32], q: f64) -> f32 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let (lo, hi, gamma) = quantile_points(s.len(), q);
    let (a, b) = (s[lo], s[hi]);
    let diff = b - a;
    if gamma >= 0.5 { b - diff * (1.0 - gamma) as f32 } else { a + diff * gamma as f32 }
}

/// `np.percentile(a, q)` on float64 data.
pub fn percentile_f64(v: &[f64], q: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let (lo, hi, gamma) = quantile_points(s.len(), q);
    let (a, b) = (s[lo], s[hi]);
    let diff = b - a;
    if gamma >= 0.5 { b - diff * (1.0 - gamma) } else { a + diff * gamma }
}

/// method="linear": virtual index (n-1)*q, its floor and next, and gamma.
fn quantile_points(n: usize, q: f64) -> (usize, usize, f64) {
    let quant = q / 100.0;
    let virt = (n as f64 - 1.0) * quant;
    let prev = virt.floor();
    if virt >= n as f64 - 1.0 {
        return (n - 1, n - 1, virt - prev);
    }
    if virt < 0.0 {
        return (0, 0, virt - prev);
    }
    (prev as usize, prev as usize + 1, virt - prev)
}

// ---- librosa: stft, mel, dB ---------------------------------------------------

pub const N_FFT: usize = 2048;
pub const N_BINS: usize = N_FFT / 2 + 1;

/// scipy.signal.get_window("hann", n, fftbins=True): general_cosine over
/// linspace(-pi, pi, n + 1), truncated.
pub fn hann_scipy(n: usize) -> Vec<f64> {
    let m = n + 1;
    let pi = std::f64::consts::PI;
    let step = (pi - -pi) / (m - 1) as f64;
    (0..n)
        .map(|i| {
            let fac = if i == m - 1 { pi } else { i as f64 * step + -pi };
            let w = 0.0 + 0.5 * (0.0 * fac).cos();
            w + 0.5 * (1.0 * fac).cos()
        })
        .collect()
}

/// numpy's complex64 `absolute` (SIMD, FMA): larger * sqrt(1 + r*r) with
/// r = smaller / larger.
#[inline]
pub fn cabs_f32(re: f32, im: f32) -> f32 {
    let (re, im) = (re.abs(), im.abs());
    if re.is_infinite() || im.is_infinite() {
        return f32::INFINITY;
    }
    if re.is_nan() || im.is_nan() {
        return f32::NAN;
    }
    let larger = re.max(im);
    let smaller = re.min(im);
    if larger == 0.0 {
        return 0.0;
    }
    let ratio = smaller / larger;
    ratio.mul_add(ratio, 1.0).sqrt() * larger
}

/// `np.abs(librosa.stft(y, n_fft=2048, hop_length=hop)) ** 2`, as a
/// `[N_BINS][frames]` row-major matrix (librosa's (freq, time) layout).
pub fn stft_power(y: &[f32], hop: usize) -> (Vec<f32>, usize) {
    let win = hann_scipy(N_FFT);
    let half = N_FFT / 2;
    let padded_len = y.len() + 2 * half;
    let frames = 1 + (padded_len - N_FFT) / hop;
    let at = |i: usize| -> f32 { if i < half || i >= half + y.len() { 0.0 } else { y[i - half] } };
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut inp = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let mut out = vec![0f32; N_BINS * frames];
    for t in 0..frames {
        for (k, v) in inp.iter_mut().enumerate() {
            *v = win[k] * at(t * hop + k) as f64;
        }
        fft.process_with_scratch(&mut inp, &mut spec, &mut scratch).expect("fft");
        for (f, c) in spec.iter().enumerate() {
            let c: Complex<f64> = *c;
            let a = cabs_f32(c.re as f32, c.im as f32);
            out[f * frames + t] = a * a;
        }
    }
    (out, frames)
}

/// np.fft.rfftfreq(n, d=1.0/sr)
pub fn fft_frequencies(sr: f64, n_fft: usize) -> Vec<f64> {
    let d = 1.0 / sr;
    let val = 1.0 / (n_fft as f64 * d);
    (0..n_fft / 2 + 1).map(|k| k as f64 * val).collect()
}

fn hz_to_mel_slaney(f: f64) -> f64 {
    let f_min = 0.0;
    let f_sp = 200.0 / 3.0;
    let mut mels = (f - f_min) / f_sp;
    let min_log_hz = 1000.0;
    let min_log_mel = (min_log_hz - f_min) / f_sp;
    let logstep = 6.4f64.ln() / 27.0;
    if f >= min_log_hz {
        mels = min_log_mel + (f / min_log_hz).ln() / logstep;
    }
    mels
}

fn mel_to_hz_slaney(m: f64) -> f64 {
    let f_min = 0.0;
    let f_sp = 200.0 / 3.0;
    let mut freq = f_min + f_sp * m;
    let min_log_hz = 1000.0;
    let min_log_mel = (min_log_hz - f_min) / f_sp;
    let logstep = 6.4f64.ln() / 27.0;
    if m >= min_log_mel {
        freq = min_log_hz * (logstep * (m - min_log_mel)).exp();
    }
    freq
}

/// librosa.filters.mel(sr, n_fft, n_mels, fmin=0, fmax, htk=False,
/// norm="slaney", dtype=float32), `[n_mels][1 + n_fft/2]`.
pub fn mel_filterbank(sr: f64, n_fft: usize, n_mels: usize, fmax: f64) -> Vec<f32> {
    let nb = n_fft / 2 + 1;
    let fftfreqs = fft_frequencies(sr, n_fft);
    let mels = crate::basicpitch::linspace(hz_to_mel_slaney(0.0), hz_to_mel_slaney(fmax), n_mels + 2);
    let mel_f: Vec<f64> = mels.iter().map(|&m| mel_to_hz_slaney(m)).collect();
    let fdiff: Vec<f64> = mel_f.windows(2).map(|w| w[1] - w[0]).collect();
    let mut weights = vec![0f32; n_mels * nb];
    for i in 0..n_mels {
        let enorm = 2.0 / (mel_f[i + 2] - mel_f[i]);
        for j in 0..nb {
            let lower = -(mel_f[i] - fftfreqs[j]) / fdiff[i];
            let upper = (mel_f[i + 2] - fftfreqs[j]) / fdiff[i + 1];
            // np.minimum(a, b) = a <= b || isnan(a) ? a : b; np.maximum(0, x)
            let mn = if lower <= upper || lower.is_nan() { lower } else { upper };
            let w = if 0.0 >= mn { 0.0 } else { mn };
            weights[i * nb + j] = ((w as f32) as f64 * enorm) as f32;
        }
    }
    weights
}

/// OpenBLAS SGEMM's K blocking as the forge env's numpy runs `np.dot(mel,
/// S)` on a Zen CPU: GEMM_Q 320 with level3.c's halving rule (blocks
/// 0-320-640-832-1025 for K = 1025, measured with two-term probes).
pub fn sgemm_blocks(k: usize) -> Vec<(usize, usize)> {
    const GEMM_Q: usize = 320;
    const UNROLL_M: usize = 8;
    let mut v = Vec::new();
    let mut ls = 0;
    while ls < k {
        let mut min_l = k - ls;
        if min_l >= GEMM_Q * 2 {
            min_l = GEMM_Q;
        } else if min_l > GEMM_Q {
            min_l = (min_l / 2).div_ceil(UNROLL_M) * UNROLL_M;
        }
        v.push((ls, ls + min_l));
        ls += min_l;
    }
    v
}

/// `np.einsum("ft,mf->mt", S, mel, optimize=True)` (== np.dot(mel, S), an
/// OpenBLAS SGEMM). Per K block, sgemm_kernel_8x4_haswell_2's main loop
/// alternates two FMA accumulator sets over 8-step groups, the tail goes
/// into the first set, the sets are added and the sum added to C.
///
/// Not bit-exact everywhere: which k lands in which set also depends on
/// OpenBLAS's per-thread tiling (it varies across output columns in runs
/// that follow the thread partition), so numpy's own result changes with
/// the CPU and thread count. Measured residual: ~1 ulp in about a fifth of
/// the mel bins; no effect on the onsets of the parity clips.
pub fn mel_project(mel: &[f32], n_mels: usize, s: &[f32], nb: usize, frames: usize) -> Vec<f32> {
    let blocks = sgemm_blocks(nb);
    let mut out = vec![0f32; n_mels * frames];
    for m in 0..n_mels {
        let row = &mel[m * nb..(m + 1) * nb];
        for t in 0..frames {
            let mut c = 0f32;
            for &(a, b) in &blocks {
                let main = (b - a) - (b - a) % 8;
                let mut acc = [0f32; 2];
                for f in a..b {
                    let i = f - a;
                    let j = if i < main { i % 2 } else { 0 };
                    acc[j] = row[f].mul_add(s[f * frames + t], acc[j]);
                }
                c += acc[0] + acc[1];
            }
            out[m * frames + t] = c;
        }
    }
    out
}

/// librosa.power_to_db(S, ref=1.0, amin=1e-10, top_db=80.0), float32.
pub fn power_to_db(s: &[f32]) -> Vec<f32> {
    let amin = 1e-10f32;
    let mut out: Vec<f32> = s
        .iter()
        .map(|&x| {
            let m = if x.is_nan() { f32::NAN } else { x.max(amin) };
            10f32 * m.log10()
        })
        .collect();
    let mx = out.iter().fold(f32::NEG_INFINITY, |m, &v| if v.is_nan() || m.is_nan() { f32::NAN } else { m.max(v) });
    let floor = mx - 80f32;
    for v in out.iter_mut() {
        if !v.is_nan() && !floor.is_nan() {
            *v = v.max(floor);
        } else {
            *v = f32::NAN;
        }
    }
    out
}

/// librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop) given the
/// power spectrogram `s` (`[N_BINS][frames]`) it computes internally.
pub fn onset_strength(s: &[f32], frames: usize, sr: f64, hop: usize) -> Vec<f32> {
    let n_mels = 128;
    let mel = mel_filterbank(sr, N_FFT, n_mels, 0.5 * sr);
    let ms = mel_project(&mel, n_mels, s, N_BINS, frames);
    let db = power_to_db(&ms);
    onset_from_db(&db, n_mels, frames, hop)
}

/// onset_strength_multi's tail on the `[n_mels][frames]` dB spectrogram.
pub fn onset_from_db(db: &[f32], n_mels: usize, frames: usize, hop: usize) -> Vec<f32> {
    let lag = 1;
    let n = frames.saturating_sub(lag);
    // np.maximum(0.0, S[:, 1:] - S[:, :-1]); mean over the mel axis of a
    // C-ordered (mel, time) array: a running sum down the rows.
    let mut acc = vec![0f32; n];
    for m in 0..n_mels {
        for t in 0..n {
            let d = db[m * frames + t + lag] - db[m * frames + t];
            let d = if d.is_nan() { f32::NAN } else { d.max(0.0) };
            if m == 0 {
                acc[t] = d;
            } else {
                acc[t] += d;
            }
        }
    }
    let pad = lag + N_FFT / (2 * hop);
    let mut env = vec![0f32; frames];
    for t in pad..frames {
        let j = t - pad;
        if j < n {
            env[t] = (acc[j] as f64 / n_mels as f64) as f32;
        }
    }
    env
}

/// librosa.util.peak_pick (the numba kernel), sparse.
pub fn peak_pick(x: &[f32], pre_max: usize, post_max: usize, pre_avg: usize, post_avg: usize, delta: f32, wait: usize) -> Vec<usize> {
    let len = x.len();
    if len == 0 {
        return Vec::new();
    }
    let max_of = |a: usize, b: usize| -> f32 { x[a..b].iter().copied().fold(f32::NEG_INFINITY, |m, v| if v > m || v.is_nan() { v } else { m }) };
    let mean_of = |a: usize, b: usize| -> f64 {
        let mut c = 0f32;
        for &v in &x[a..b] {
            c += v;
        }
        c as f64 / (b - a) as f64
    };
    let mut peaks = vec![false; len];
    peaks[0] = x[0] >= max_of(0, post_max.min(len));
    peaks[0] &= (x[0] as f64) >= mean_of(0, post_avg.min(len)) + delta as f64;
    let mut n = if peaks[0] { wait + 1 } else { 1 };
    while n < len {
        let maxn = max_of(n.saturating_sub(pre_max), (n + post_max).min(len));
        peaks[n] = x[n] == maxn;
        if !peaks[n] {
            n += 1;
            continue;
        }
        let avgn = mean_of(n.saturating_sub(pre_avg), (n + post_avg).min(len));
        peaks[n] &= (x[n] as f64) >= avgn + delta as f64;
        if !peaks[n] {
            n += 1;
            continue;
        }
        n += wait + 1;
    }
    peaks.iter().enumerate().filter(|(_, &p)| p).map(|(i, _)| i).collect()
}

/// librosa.onset.onset_backtrack(events, energy)
pub fn onset_backtrack(events: &[usize], energy: &[f32]) -> Vec<usize> {
    let n = energy.len();
    let mut minima = vec![0usize];
    for i in 1..n.saturating_sub(1) {
        if energy[i] <= energy[i - 1] && energy[i] < energy[i + 1] {
            minima.push(i);
        }
    }
    minima.sort_unstable();
    minima.dedup();
    events
        .iter()
        .map(|&e| {
            let k = minima.partition_point(|&m| m <= e);
            minima[k.saturating_sub(1)]
        })
        .collect()
}

/// librosa.onset.onset_detect(onset_envelope=env, ..., backtrack=True,
/// units="frames").
pub fn onset_detect(env: &[f32], pre_max: usize, post_max: usize, pre_avg: usize, post_avg: usize, delta: f32, wait: usize) -> Vec<usize> {
    if env.is_empty() {
        return Vec::new();
    }
    let mn = env.iter().copied().fold(f32::INFINITY, f32::min);
    let mut e: Vec<f32> = env.iter().map(|&v| v - mn).collect();
    let mx = e.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let denom = mx + f32::MIN_POSITIVE;
    for v in e.iter_mut() {
        *v /= denom;
    }
    if !e.iter().any(|&v| v != 0.0) || !e.iter().all(|v| v.is_finite()) {
        return Vec::new();
    }
    let onsets = peak_pick(&e, pre_max, post_max, pre_avg, post_avg, delta, wait);
    if onsets.is_empty() {
        return onsets;
    }
    onset_backtrack(&onsets, &e)
}

// ---- scipy.signal: butter + sosfiltfilt ----------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct C {
    re: f64,
    im: f64,
}

impl C {
    fn new(re: f64, im: f64) -> C {
        C { re, im }
    }
    /// numpy 2.4's complex128 multiply as its AVX2/FMA3 loop computes it
    /// (measured: 70 of 70 products in butter's gain chain).
    fn mul(self, b: C) -> C {
        C::new(self.re.mul_add(b.re, -(self.im * b.im)), self.im.mul_add(b.re, self.re * b.im))
    }
    /// numpy's complex division (Smith's method).
    fn div(self, b: C) -> C {
        let (in1r, in1i, in2r, in2i) = (self.re, self.im, b.re, b.im);
        if in2r.abs() >= in2i.abs() {
            let rat = in2i / in2r;
            let scl = 1.0 / (in2r + in2i * rat);
            C::new((in1r + in1i * rat) * scl, (in1i - in1r * rat) * scl)
        } else {
            let rat = in2r / in2i;
            let scl = 1.0 / (in2i + in2r * rat);
            C::new((in1r * rat + in1i) * scl, (in1i * rat - in1r) * scl)
        }
    }
    fn conj(self) -> C {
        C::new(self.re, -self.im)
    }
    fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }
}

/// np.prod of a complex vector: a running product from the first element.
fn cprod(v: &[C]) -> C {
    let mut r = v[0];
    for &x in &v[1..] {
        r = r.mul(x);
    }
    r
}

/// `scipy.signal.butter(order, cutoff, btype="highpass", fs=fs, output="sos")`.
pub fn butter_highpass_sos(order: usize, cutoff: f64, fs: f64) -> Result<Vec<[f64; 6]>, String> {
    if order == 0 || order % 2 == 1 {
        return Err(format!("butter order {order} is not supported (even orders only)"));
    }
    let wn = cutoff / (fs / 2.0);
    if !(wn > 0.0 && wn < 1.0) {
        return Err(format!("Digital filter critical frequencies must be 0 < Wn < fs/2 (fs={fs} -> fs/2={})", fs / 2.0));
    }
    let pi = std::f64::consts::PI;
    let n = order as f64;
    // buttap: p = -exp(1j * pi * m / (2N)), m = -N+1, -N+3, ..., N-1
    let p: Vec<C> = (0..order)
        .map(|i| {
            let m = -n + 1.0 + 2.0 * i as f64;
            // (0 + 1j*pi*m) / (2N): numpy's complex division by a real
            // multiplies by 1 / (2N).
            let th = (pi * m) * (1.0 / (2.0 * n));
            C::new(-th.cos(), -th.sin())
        })
        .collect();
    let fsd = 2.0;
    let warped = 2.0 * fsd * (pi * wn / fsd).tan();
    // lp2hp_zpk
    let wo = C::new(warped, 0.0);
    let p_hp: Vec<C> = p.iter().map(|&x| wo.div(x)).collect();
    let negp: Vec<C> = p.iter().map(|x| C::new(-x.re, -x.im)).collect();
    let k_hp = 1.0 * C::new(1.0, 0.0).div(cprod(&negp)).re;
    // bilinear_zpk, fs=2
    let fs2 = 2.0 * fsd;
    let p_z: Vec<C> = p_hp.iter().map(|&x| C::new(fs2 + x.re, x.im).div(C::new(fs2 - x.re, 0.0 - x.im))).collect();
    let fs2m: Vec<C> = p_hp.iter().map(|x| C::new(fs2 - x.re, 0.0 - x.im)).collect();
    let mut zprod = fs2 - 0.0;
    for _ in 1..order {
        zprod *= fs2 - 0.0;
    }
    let k_z = k_hp * C::new(zprod, 0.0).div(cprod(&fs2m)).re;
    // zpk2sos(pairing="nearest"): one positive-imaginary pole per pair,
    // sorted by real part; "worst" (closest to the unit circle) last.
    let mut pc: Vec<C> = p_z.iter().copied().filter(|x| x.im > 0.0).collect();
    pc.sort_by(|a, b| a.re.total_cmp(&b.re).then(a.im.abs().total_cmp(&b.im.abs())));
    let n_sections = order / 2;
    let mut sos = vec![[0f64; 6]; n_sections];
    for si in (0..n_sections).rev() {
        let worst = pc
            .iter()
            .enumerate()
            .map(|(i, x)| (i, (1.0 - x.abs()).abs()))
            .fold(None, |acc: Option<(usize, f64)>, (i, d)| match acc {
                Some((_, bd)) if bd <= d => acc,
                _ => Some((i, d)),
            })
            .expect("pole")
            .0;
        let p1 = pc.remove(worst);
        let c = p1.conj();
        let a1 = -p1.re - c.re;
        let a2 = (-p1.re) * (-c.re) - (-p1.im) * (-c.im);
        sos[si] = [1.0, -2.0, 1.0, 1.0, a1, a2];
    }
    for v in sos[0][..3].iter_mut() {
        *v *= k_z;
    }
    Ok(sos)
}

/// scipy.signal.sosfilt_zi
pub fn sosfilt_zi(sos: &[[f64; 6]]) -> Vec<[f64; 2]> {
    let mut scale = 1.0f64;
    let mut out = Vec::with_capacity(sos.len());
    for s in sos {
        let (b, a) = (&s[0..3], &s[3..6]);
        let zi = lfilter_zi2(b, a);
        out.push([scale * zi[0], scale * zi[1]]);
        let sb = b[0] + (b[1] + b[2]);
        let sa = a[0] + (a[1] + a[2]);
        scale *= sb / sa;
    }
    out
}

/// lfilter_zi for a biquad with a[0] == 1: solve (I - A) zi = B with
/// OpenBLAS dgesv (getf2 partial pivoting, then two triangular solves).
fn lfilter_zi2(b: &[f64], a: &[f64]) -> [f64; 2] {
    let (b, a) = if a[0] != 1.0 {
        let a0 = a[0];
        ([b[0] / a0, b[1] / a0, b[2] / a0], [a[0] / a0, a[1] / a0, a[2] / a0])
    } else {
        ([b[0], b[1], b[2]], [a[0], a[1], a[2]])
    };
    // IminusA = [[1 + a1, -1], [a2, 1]] (eye - companion(a).T)
    let m = [[1.0 - (-a[1] / 1.0), 0.0 - 1.0], [0.0 - (-a[2] / 1.0), 1.0 - 0.0]];
    let rhs = [b[1] - a[1] * b[0], b[2] - a[2] * b[0]];
    solve2(m, rhs)
}

/// OpenBLAS dgetf2 + dgetrs for a 2x2 system.
fn solve2(m: [[f64; 2]; 2], rhs: [f64; 2]) -> [f64; 2] {
    // column 0: pivot = first max |.|
    let (mut a, mut r) = (m, rhs);
    let piv = if a[1][0].abs() > a[0][0].abs() { 1 } else { 0 };
    if piv == 1 {
        a.swap(0, 1);
        r.swap(0, 1);
    }
    let inv = 1.0 / a[0][0];
    let l = a[1][0] * inv;
    // column 1: u22 = a22 - l * u12
    let u22 = a[1][1] - l * a[0][1];
    // L y = r (unit lower), then U x = y
    let y1 = r[1] - r[0] * l;
    let x1 = y1 / u22;
    let y0 = r[0] - x1 * a[0][1];
    let x0 = y0 / a[0][0];
    [x0, x1]
}

/// scipy's `_sosfilt` direct-form-II-transposed loop over one signal.
fn sosfilt_inplace(sos: &[[f64; 6]], x: &mut [f64], zi: &mut [[f64; 2]]) {
    for v in x.iter_mut() {
        let mut x_cur = 1.0 * *v;
        for (s, z) in sos.iter().zip(zi.iter_mut()) {
            let x_new = s[0] * x_cur + z[0];
            z[0] = s[1] * x_cur - s[4] * x_new + z[1];
            z[1] = s[2] * x_cur - s[5] * x_new;
            x_cur = x_new;
        }
        *v = x_cur;
    }
}

/// `scipy.signal.sosfiltfilt(sos, x, axis=0)` for one float32 channel,
/// default odd padding; the float64 result.
pub fn sosfiltfilt(sos: &[[f64; 6]], x: &[f32]) -> Result<Vec<f64>, String> {
    let n_sections = sos.len();
    let mut ntaps = 2 * n_sections + 1;
    let zb = sos.iter().filter(|s| s[2] == 0.0).count();
    let za = sos.iter().filter(|s| s[5] == 0.0).count();
    ntaps -= zb.min(za);
    let edge = ntaps * 3;
    let n = x.len();
    if n <= edge {
        return Err(format!("The length of the input vector x must be greater than padlen, which is {edge}."));
    }
    // odd_ext, in float32
    let mut ext: Vec<f32> = Vec::with_capacity(n + 2 * edge);
    for k in (1..=edge).rev() {
        ext.push(2f32 * x[0] - x[k]);
    }
    ext.extend_from_slice(x);
    for k in 1..=edge {
        ext.push(2f32 * x[n - 1] - x[n - 1 - k]);
    }
    let zi = sosfilt_zi(sos);
    let mut y: Vec<f64> = ext.iter().map(|&v| v as f64).collect();
    let x0 = ext[0] as f64;
    let mut z: Vec<[f64; 2]> = zi.iter().map(|z| [z[0] * x0, z[1] * x0]).collect();
    sosfilt_inplace(sos, &mut y, &mut z);
    let y0 = *y.last().expect("samples");
    y.reverse();
    let mut z: Vec<[f64; 2]> = zi.iter().map(|z| [z[0] * y0, z[1] * y0]).collect();
    sosfilt_inplace(sos, &mut y, &mut z);
    y.reverse();
    Ok(y[edge..y.len() - edge].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairwise_sum_shapes() {
        let v: Vec<f32> = (0..1000).map(|i| (i % 7) as f32 * 0.25).collect();
        let naive: f32 = v.iter().sum();
        assert_eq!(np_sum_f32_pairwise(&v), naive, "exactly representable partial sums");
        assert_eq!(np_mean_f32(&[1.0, 2.0]), 1.5);
    }

    #[test]
    fn percentile_linear() {
        assert_eq!(percentile_f64(&[1.0, 2.0, 3.0, 4.0], 50.0), 2.5);
        assert_eq!(percentile_f64(&[5.0], 95.0), 5.0);
        assert_eq!(percentile_f32(&[0.0, 10.0], 95.0), 9.5);
    }

    #[test]
    fn sgemm_blocking() {
        assert_eq!(sgemm_blocks(1025), vec![(0, 320), (320, 640), (640, 832), (832, 1025)]);
        assert_eq!(sgemm_blocks(300), vec![(0, 300)]);
    }

    #[test]
    fn backtrack_goes_left() {
        let e = [0.0, 0.5, 0.2, 0.9, 0.1, 0.3, 1.0];
        assert_eq!(onset_backtrack(&[3, 6], &e), vec![2, 4]);
    }

    #[test]
    fn butter_is_a_highpass() {
        let sos = butter_highpass_sos(4, 55.0, 44100.0).unwrap();
        assert_eq!(sos.len(), 2);
        // DC is removed: a step settles to zero
        let x: Vec<f32> = vec![1.0; 20000];
        let y = sosfiltfilt(&sos, &x).unwrap();
        assert!(y[10000].abs() < 1e-6, "{}", y[10000]);
    }
}
