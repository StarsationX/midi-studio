//! Golden tests for the BS-Roformer separation port, against fixtures from
//! the real torch / MSST code (tools/make_rofo_fixtures.py). Every test
//! first puts the process in a 7.5 GiB job object.

use forge_rs::demix::{self, DemixParams, Planar, Stems};
use forge_rs::dump::read_npy_f32;
use forge_rs::memlimit;
use forge_rs::roformer::{self, Ep, Roformer, RoformerOptions};
use forge_rs::stft::{self, Stft, N_BINS};
use realfft::num_complex::Complex;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Once;

static CAP: Once = Once::new();

fn cap() {
    CAP.call_once(|| {
        memlimit::apply(memlimit::DEFAULT_LIMIT_BYTES).expect("job object");
        assert!(!memlimit::can_allocate(9 << 30), "memory cap not active");
    });
}

fn fix(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// tools/make_rofo_fixtures.py `lcg`.
fn lcg(n: usize, seed: u64) -> Vec<f32> {
    let mut s = seed;
    (0..n)
        .map(|_| {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 48) as u16 as i16) as f32 / 32768.0
        })
        .collect()
}

/// tools/make_rofo_fixtures.py `synth`, op for op in f32.
fn synth(n: usize, ch: usize) -> Vec<f32> {
    let noise = lcg(n, 30 + ch as u64);
    (0..n)
        .map(|t| {
            let saw1 = ((t * 3 + ch * 17) % 401) as f32 / 401.0 - 0.5;
            let saw2 = ((t * 5) % 293) as f32 / 293.0 - 0.5;
            let sq = if (t / 150) % 2 == 0 { 0.5f32 } else { -0.5 };
            let env = 3000usize.saturating_sub(t % 11025) as f32 / 3000.0;
            let mut x = saw1 * 0.3;
            x += saw2 * if ch == 0 { 0.2 } else { 0.1 };
            x += sq * 0.1;
            x += (noise[t] * env) * 0.4;
            x
        })
        .collect()
}

fn fnv(a: &[f32]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for v in a {
        h ^= v.to_bits() as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn max_abs(a: impl IntoIterator<Item = f32>) -> f32 {
    a.into_iter().fold(0f32, |m, v| m.max(v.abs()))
}

#[test]
fn hann_window_matches_torch() {
    cap();
    let (_, want) = read_npy_f32(&fix("rofo_hann.npy")).unwrap();
    let got = stft::hann_periodic(2048);
    // torch takes cos in fp32 (SLEEF, <= 1 ulp) then 0.5 - 0.5c: entries can
    // differ by one ulp of c (~6e-8 absolute), which near w=0 is many ulps of w.
    let d = max_abs(got.iter().zip(&want).map(|(a, b)| a - b));
    let exact = got.iter().zip(&want).filter(|(a, b)| a.to_bits() == b.to_bits()).count();
    eprintln!("hann: {exact}/2048 bit-exact, max abs diff {d:.2e}");
    assert!(d <= 6e-8, "hann window off by {d}");
}

#[test]
fn stft_matches_torch() {
    cap();
    let x = lcg(8192, 1);
    let (shape, want) = read_npy_f32(&fix("rofo_stft.npy")).unwrap();
    assert_eq!(shape, [stft::n_frames(8192), N_BINS, 2]);
    let st = Stft::new();
    let got = st.forward(&x);
    let peak = max_abs(want.iter().copied());
    let d = max_abs(got.iter().zip(want.chunks_exact(2)).flat_map(|(c, w)| [c.re - w[0], c.im - w[1]]));
    eprintln!("stft vs torch: max abs diff {d:.3e} (peak {peak:.1}, rel {:.2e})", d / peak);
    assert!(d / peak < 2e-6, "stft drift {d}");
}

#[test]
fn istft_matches_torch_and_round_trips() {
    cap();
    let x = lcg(8192, 1);
    let st = Stft::new();
    let (_, s_torch) = read_npy_f32(&fix("rofo_stft.npy")).unwrap();
    let t = stft::n_frames(8192);
    // mask[f][t] = lcg(seed 2) + i lcg(seed 3), stored [t][f] in the lcg stream
    let mr = lcg(N_BINS * t, 2);
    let mi = lcg(N_BINS * t, 3);
    let y = st.inverse_with(t, 8192, |ti, bins| {
        for f in 0..N_BINS {
            let k = (ti * N_BINS + f) * 2;
            let (xr, xi) = (s_torch[k] as f64, s_torch[k + 1] as f64);
            let (a, b) = (mr[ti * N_BINS + f] as f64, mi[ti * N_BINS + f] as f64);
            bins[f] = Complex::new(xr * a - xi * b, xr * b + xi * a);
        }
        bins[0] = Complex::new(0.0, 0.0);
    });
    let (_, want) = read_npy_f32(&fix("rofo_istft.npy")).unwrap();
    let peak = max_abs(want.iter().copied());
    let d = max_abs(y.iter().zip(&want).map(|(a, b)| a - b));
    eprintln!("istft vs torch: max abs diff {d:.3e} (peak {peak:.3})");
    assert!(d < 1e-6 * peak.max(1.0), "istft drift {d}");

    let rt = st.inverse(&st.forward(&x), 8192);
    let d = max_abs(rt.iter().zip(&x).map(|(a, b)| a - b));
    eprintln!("stft->istft round trip: max abs diff {d:.3e}");
    assert!(d < 1e-6, "round trip {d}");
}

#[derive(Deserialize)]
struct DemixCase {
    chunk: usize,
    overlap: usize,
    length: usize,
    batch: usize,
    seed: u64,
    file: String,
}

#[derive(Deserialize)]
struct DemixFix {
    cases: Vec<DemixCase>,
}

/// The fake model of make_rofo_fixtures.py:
/// out[n][c][t] = x[c][(t + 7n) % L] * (n + 1) - x[1 - c][t] * 0.5
fn fake_model(part: &Planar, n_stems: usize) -> Stems {
    let l = part[0].len();
    (0..n_stems)
        .map(|k| {
            (0..2)
                .map(|c| (0..l).map(|t| part[c][(t + 7 * k) % l] * (k + 1) as f32 - part[1 - c][t] * 0.5).collect())
                .collect()
        })
        .collect()
}

#[test]
fn demix_chunking_is_bit_exact_with_msst() {
    cap();
    let f: DemixFix = serde_json::from_str(&std::fs::read_to_string(fix("rofo_demix.json")).unwrap()).unwrap();
    for c in &f.cases {
        let mix: Planar = vec![lcg(c.length, c.seed), lcg(c.length, c.seed + 100)];
        let p = DemixParams { chunk_size: c.chunk, num_overlap: c.overlap, batch_size: c.batch };
        let out = demix::demix(&mix, 2, &p, |part| Ok(fake_model(part, 2))).unwrap();
        let (shape, want) = read_npy_f32(&fix(&c.file)).unwrap();
        assert_eq!(shape, [2, 2, c.length]);
        let got: Vec<f32> = out.into_iter().flatten().flatten().collect();
        let bad = got.iter().zip(&want).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
        let d = max_abs(got.iter().zip(&want).map(|(a, b)| a - b));
        eprintln!(
            "demix chunk {} overlap {} len {} batch {}: {bad} non-identical samples, max diff {d:.3e}",
            c.chunk, c.overlap, c.length, c.batch
        );
        assert_eq!(bad, 0, "{}: not bit-exact", c.file);
    }
}

#[test]
fn msst_fade_window_is_bit_exact() {
    cap();
    #[derive(Deserialize)]
    struct L {
        fadein: String,
        fadeout: String,
        window_588800: String,
        fadein_200: Vec<f32>,
    }
    let l: L = serde_json::from_str(&std::fs::read_to_string(fix("rofo_linspace.json")).unwrap()).unwrap();
    assert_eq!(demix::torch_linspace_f32(0.0, 1.0, 200), l.fadein_200);
    assert_eq!(fnv(&demix::torch_linspace_f32(0.0, 1.0, 58880)), l.fadein);
    assert_eq!(fnv(&demix::torch_linspace_f32(1.0, 0.0, 58880)), l.fadeout);
    let p = DemixParams::bs_rofo_sw();
    assert_eq!(fnv(&demix::windowing_array(&p)), l.window_588800);
}

#[test]
fn pcm16_write_matches_soundfile() {
    cap();
    let (shape, v) = read_npy_f32(&fix("rofo_pcm16.npy")).unwrap();
    let n = shape[1];
    let bad: Vec<usize> = (0..n).filter(|&i| forge_rs::separate::f32_to_pcm16(v[i]) as f32 != v[n + i]).collect();
    assert!(bad.is_empty(), "{} of {n} differ, first x={} want {}", bad.len(), v[bad[0]], v[n + bad[0]]);
}

#[test]
fn general_mix_order_and_limit() {
    cap();
    // stems [n][c][t]: stem n holds value n+1 in a 2-sample stereo buffer
    let stems: Stems = (0..6).map(|n| vec![vec![(n + 1) as f32 * 0.1; 2]; 2]).collect();
    // bass(1) + guitar(5) + other(3) + piano(6) + vocals(4), drums(2) excluded
    let m = forge_rs::separate::mix_pitched(&stems, &forge_rs::separate::default_excludes(false));
    let want = 0.1f32 + 0.5 + 0.3 + 0.6 + 0.4;
    assert_eq!(m[0][0], want / want * 0.98, "peak-limited to 0.98");
    let m = forge_rs::separate::mix_pitched(&stems, &forge_rs::separate::default_excludes(true));
    assert_eq!(m[1][1], (0.1f32 + 0.5 + 0.3 + 0.6) / (0.1f32 + 0.5 + 0.3 + 0.6) * 0.98);
}

/// One 588800-sample chunk through Rust STFT -> ONNX body -> masks -> iSTFT
/// vs MSST's BSRoformer.forward in torch (CPU fp32). Needs the exported
/// body: FORGE_RS_ROFO_MODEL, or <models>/bs_rofo_sw/bsrofo_sw_body.onnx.
/// FORGE_RS_REQUIRE_MODELS=1 turns the skip into a failure.
#[test]
fn golden_one_chunk_end_to_end() {
    cap();
    let model = std::env::var_os("FORGE_RS_ROFO_MODEL").map(PathBuf::from).map(Ok).unwrap_or_else(|| roformer::default_model_path(None));
    let (model, fixture) = match (model, fix("rofo_chunk.json").exists()) {
        (Ok(m), true) if m.exists() => (m, fix("rofo_chunk.json")),
        (m, f) => {
            let why = format!("model {m:?}, fixture present {f}");
            if std::env::var_os("FORGE_RS_REQUIRE_MODELS").is_some() {
                panic!("models required: {why}");
            }
            eprintln!("SKIP golden_one_chunk_end_to_end: {why}");
            return;
        }
    };
    #[derive(Deserialize)]
    struct C {
        length: usize,
        decimate: usize,
    }
    let c: C = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    let part: Planar = (0..2).map(|ch| synth(c.length, ch)).collect();
    let mut r = Roformer::load(&model, &RoformerOptions { ep: Ep::Cpu, ..Default::default() }).expect("load body");
    let out = r.forward(&part).unwrap();
    let (shape, want) = read_npy_f32(&fix("rofo_chunk_dec.npy")).unwrap();
    let nd = c.length.div_ceil(c.decimate);
    assert_eq!(shape, [6, 2, nd]);
    let mut worst = 0f32;
    for (n, stem) in out.iter().enumerate() {
        let mut d = 0f32;
        let mut peak = 0f32;
        for (ch, y) in stem.iter().enumerate() {
            for (j, v) in y.iter().step_by(c.decimate).enumerate() {
                let w = want[(n * 2 + ch) * nd + j];
                d = d.max((v - w).abs());
                peak = peak.max(w.abs());
            }
        }
        eprintln!("chunk e2e {}: max abs diff {d:.3e} (peak {peak:.3})", roformer::INSTRUMENTS[n]);
        worst = worst.max(d);
    }
    eprintln!("[memcap] {}", memlimit::peaks());
    // ~1.8e-7 measured on this synthetic chunk. Real music sits higher (~2e-4
    // max on guitar/other) because the network itself amplifies sub-ulp
    // input changes there; see the port notes in src/roformer.rs.
    assert!(worst < 2e-6, "one-chunk drift {worst}");
}
