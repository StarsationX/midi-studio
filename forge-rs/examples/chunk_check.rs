//! One chunk through the Rust BS-Roformer forward vs a torch reference.
//!
//!   cargo run --release --example chunk_check -- MODEL.onnx IN.npy REF.npy [cpu|cuda]
//!
//! IN.npy: (2, L) chunk; REF.npy: (6, 2, L) = BSRoformer.forward(IN) in torch.

use forge_rs::dump::read_npy_f32;
use forge_rs::memlimit;
use forge_rs::roformer::{Ep, Roformer, RoformerOptions, INSTRUMENTS};
use std::path::Path;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    memlimit::apply(memlimit::DEFAULT_LIMIT_BYTES)?;
    let a: Vec<String> = std::env::args().skip(1).collect();
    let ep = match a.get(3).map(String::as_str) {
        Some("cuda") => Ep::Cuda { device_id: 0 },
        _ => Ep::Cpu,
    };
    let (shape, x) = read_npy_f32(Path::new(&a[1]))?;
    let l = shape[1];
    let part = vec![x[..l].to_vec(), x[l..].to_vec()];
    let (_, want) = read_npy_f32(Path::new(&a[2]))?;
    let mut r = Roformer::load(Path::new(&a[0]), &RoformerOptions { ep, ..Default::default() })?;
    let t0 = Instant::now();
    let out = r.forward(&part)?;
    eprintln!("forward {:.2}s on {ep:?}", t0.elapsed().as_secs_f64());
    for (n, st) in out.iter().enumerate() {
        let mut d = 0f64;
        let (mut e, mut p) = (0f64, 0f64);
        for (c, y) in st.iter().enumerate() {
            for (i, &v) in y.iter().enumerate() {
                let w = want[(n * 2 + c) * l + i] as f64;
                let diff = v as f64 - w;
                d = d.max(diff.abs());
                e += diff * diff;
                p += w * w;
            }
        }
        println!("{:8} max|diff| {d:.3e}  SDR {:.2} dB", INSTRUMENTS[n], 10.0 * (p / e).log10());
    }
    eprintln!("[memcap] {}", memlimit::peaks());
    Ok(())
}
