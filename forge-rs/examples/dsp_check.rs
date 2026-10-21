//! Stage-by-stage check of `dsp` against librosa / numpy / scipy dumps
//! (`stage_dump.py WAV DIR`): each Rust stage runs on the Python stage's
//! input and reports bit mismatches.
//!
//!     cargo run --release --example dsp_check -- DIR

use forge_rs::dsp;
use std::path::Path;

fn read_npy(path: &Path) -> (Vec<usize>, Vec<u8>, String) {
    let b = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let hl = u16::from_le_bytes([b[8], b[9]]) as usize;
    let header = String::from_utf8_lossy(&b[10..10 + hl]).to_string();
    let descr = header.split("'descr': '").nth(1).unwrap().split('\'').next().unwrap().to_string();
    assert!(header.contains("'fortran_order': False"), "{header}");
    let shape_s = header.split("'shape': (").nth(1).unwrap().split(')').next().unwrap();
    let shape: Vec<usize> = shape_s.split(',').filter(|s| !s.trim().is_empty()).map(|s| s.trim().parse().unwrap()).collect();
    (shape, b[10 + hl..].to_vec(), descr)
}

fn f32s(dir: &Path, name: &str) -> (Vec<usize>, Vec<f32>) {
    let (s, d, t) = read_npy(&dir.join(format!("{name}.npy")));
    assert_eq!(t, "<f4", "{name}");
    (s, d.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn f64s(dir: &Path, name: &str) -> (Vec<usize>, Vec<f64>) {
    let (s, d, t) = read_npy(&dir.join(format!("{name}.npy")));
    assert_eq!(t, "<f8", "{name}");
    (s, d.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect())
}

fn report32(name: &str, got: &[f32], want: &[f32]) -> usize {
    assert_eq!(got.len(), want.len(), "{name} length");
    let bad = got.iter().zip(want).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    let rel = got.iter().zip(want).map(|(a, b)| (*a as f64 - *b as f64).abs() / (b.abs() as f64 + 1e-30)).fold(0f64, f64::max);
    println!("{name:28} mismatches {bad:>8} / {:<8} max rel {rel:.3e}", got.len());
    bad
}

fn report64(name: &str, got: &[f64], want: &[f64]) {
    let bad = got.iter().zip(want).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    let rel = got.iter().zip(want).map(|(a, b)| (a - b).abs() / (b.abs() + 1e-300)).fold(0f64, f64::max);
    println!("{name:28} mismatches {bad:>8} / {:<8} max rel {rel:.3e}", got.len());
}

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("dump dir"));
    let (_, y) = f32s(&dir, "y");
    let (_, w) = f64s(&dir, "w");
    report64("hann window (scipy)", &dsp::hann_scipy(2048), &w);

    // FFT of frame 10 in f64
    let (_, xr) = f64s(&dir, "X10re");
    let (_, xi) = f64s(&dir, "X10im");
    let mut planner = realfft::RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(2048);
    let mut inp = fft.make_input_vec();
    let mut out = fft.make_output_vec();
    let padded: Vec<f32> = std::iter::repeat_n(0f32, 1024).chain(y.iter().copied()).chain(std::iter::repeat_n(0f32, 1024)).collect();
    for (k, v) in inp.iter_mut().enumerate() {
        *v = w[k] * padded[10 * 256 + k] as f64;
    }
    fft.process(&mut inp, &mut out).unwrap();
    let re: Vec<f64> = out.iter().map(|c| c.re).collect();
    let im: Vec<f64> = out.iter().map(|c| c.im).collect();
    report64("rfft f64 frame 10 (re)", &re, &xr);
    report64("rfft f64 frame 10 (im)", &im, &xi);

    let (sh, dre) = f32s(&dir, "Dre");
    let (_, dim) = f32s(&dir, "Dim");
    let frames = sh[1];
    let (_, a) = f32s(&dir, "A");
    let (_, s) = f32s(&dir, "S");
    let (s_rs, fr) = dsp::stft_power(&y, 256);
    assert_eq!(fr, frames);
    report32("stft power (full chain)", &s_rs, &s);
    let a_rs: Vec<f32> = dre.iter().zip(&dim).map(|(&r, &i)| dsp::cabs_f32(r, i)).collect();
    report32("abs(complex64) on py D", &a_rs, &a);
    let s2: Vec<f32> = a.iter().map(|&v| v * v).collect();
    report32("abs**2 on py A", &s2, &s);

    let (msh, mel) = f32s(&dir, "mel");
    let n_mels = msh[0];
    report32("mel filterbank", &dsp::mel_filterbank(22050.0, 2048, n_mels, 11025.0), &mel);
    let (_, p) = f32s(&dir, "P");
    report32("mel @ S (blocked fma)", &dsp::mel_project(&mel, n_mels, &s, 1025, frames), &p);
    // alternatives, to pin the BLAS order
    let mut seq = vec![0f32; n_mels * frames];
    let mut f64r = vec![0f32; n_mels * frames];
    for m in 0..n_mels {
        for t in 0..frames {
            let mut acc = 0f32;
            let mut acc64 = 0f64;
            for f in 0..1025 {
                acc = mel[m * 1025 + f].mul_add(s[f * frames + t], acc);
                acc64 += mel[m * 1025 + f] as f64 * s[f * frames + t] as f64;
            }
            seq[m * frames + t] = acc;
            f64r[m * frames + t] = acc64 as f32;
        }
    }
    report32("mel @ S (one fma chain)", &seq, &p);
    report32("mel @ S (f64 then round)", &f64r, &p);
    // search: K blocks of q (plain or level3 halving), u interleaved
    // accumulators per block summed pairwise or in order, fused or not
    let blocks_of = |q: usize, halve: bool| -> Vec<(usize, usize)> {
        let mut v = Vec::new();
        let mut ls = 0;
        while ls < 1025 {
            let mut l = 1025 - ls;
            if halve {
                if l >= 2 * q {
                    l = q;
                } else if l > q {
                    l = (l / 2).div_ceil(8) * 8;
                }
            } else {
                l = l.min(q);
            }
            v.push((ls, ls + l));
            ls += l;
        }
        v
    };
    let mut best = (usize::MAX, String::new());
    for &q in &[32usize, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 512, 576, 640, 768, 1024, 2048] {
        for halve in [false, true] {
            for u in [1usize, 2, 4, 8] {
                for fused in [true, false] {
                    let blocks = blocks_of(q, halve);
                    let mut got = vec![0f32; n_mels * frames];
                    for m in 0..n_mels {
                        let row = &mel[m * 1025..(m + 1) * 1025];
                        for t in 0..frames {
                            let mut c = 0f32;
                            for &(a0, b0) in &blocks {
                                let mut acc = [0f32; 8];
                                for f in a0..b0 {
                                    let j = (f - a0) % u;
                                    acc[j] = if fused { row[f].mul_add(s[f * frames + t], acc[j]) } else { acc[j] + row[f] * s[f * frames + t] };
                                }
                                let tot = match u {
                                    1 => acc[0],
                                    2 => acc[0] + acc[1],
                                    4 => (acc[0] + acc[1]) + (acc[2] + acc[3]),
                                    _ => ((acc[0] + acc[1]) + (acc[2] + acc[3])) + ((acc[4] + acc[5]) + (acc[6] + acc[7])),
                                };
                                c += tot;
                            }
                            got[m * frames + t] = c;
                        }
                    }
                    let bad = got.iter().zip(&p).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
                    if bad < best.0 {
                        best = (bad, format!("q={q} halve={halve} u={u} fused={fused}"));
                    }
                }
            }
        }
    }
    println!("best sgemm model: {} mismatches with {}", best.0, best.1);
    let (_, l) = f32s(&dir, "L");
    report32("power_to_db on py P", &dsp::power_to_db(&p), &l);
    let (_, env) = f32s(&dir, "env");
    report32("onset tail on py L", &dsp::onset_from_db(&l, n_mels, frames, 256), &env);
}
