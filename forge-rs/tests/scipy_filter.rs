//! melody_to_midi's high-pass against scipy 1.17 (tools/make_scipy_fixture.py).

use forge_rs::dsp;
use forge_rs::dump::read_npy_f32;
use std::path::PathBuf;

fn fix(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// float.hex() -> f64
fn from_hex(s: &str) -> f64 {
    let (neg, s) = s.strip_prefix('-').map_or((false, s), |r| (true, r));
    let s = s.strip_prefix("0x").unwrap();
    let (mant, exp) = s.split_once('p').unwrap();
    let (int, frac) = mant.split_once('.').unwrap_or((mant, ""));
    let mut m = u64::from_str_radix(int, 16).unwrap() as f64;
    let mut scale = 1.0 / 16.0;
    for c in frac.chars() {
        m += c.to_digit(16).unwrap() as f64 * scale;
        scale /= 16.0;
    }
    let v = m * 2f64.powi(exp.parse().unwrap());
    if neg { -v } else { v }
}

#[test]
fn butter_sos_and_zi_are_bit_exact() {
    let cases: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fix("scipy_butter.json")).unwrap()).unwrap();
    let mut bad = Vec::new();
    for c in cases.as_array().unwrap() {
        let (fs, fc) = (c["fs"].as_f64().unwrap(), c["fc"].as_f64().unwrap());
        let sos = dsp::butter_highpass_sos(4, fc, fs).unwrap();
        let want: Vec<f64> = c["sos"].as_array().unwrap().iter().map(|v| from_hex(v.as_str().unwrap())).collect();
        let got: Vec<f64> = sos.iter().flatten().copied().collect();
        let zw: Vec<f64> = c["zi"].as_array().unwrap().iter().map(|v| from_hex(v.as_str().unwrap())).collect();
        let zg: Vec<f64> = dsp::sosfilt_zi(&sos).iter().flatten().copied().collect();
        if got != want || zg != zw {
            bad.push(format!("fs {fs} fc {fc}: sos {:?} vs {:?}, zi {:?} vs {:?}", got, want, zg, zw));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn sosfiltfilt_matches_scipy() {
    let (_, x) = read_npy_f32(&fix("scipy_x.npy")).unwrap();
    let (_, want) = read_npy_f32(&fix("scipy_y.npy")).unwrap();
    let sos = dsp::butter_highpass_sos(4, 55.0, 44100.0).unwrap();
    let got: Vec<f32> = dsp::sosfiltfilt(&sos, &x).unwrap().iter().map(|&v| v as f32).collect();
    let bad = got.iter().zip(&want).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    assert_eq!(bad, 0, "{bad} of {} samples differ", got.len());
}
