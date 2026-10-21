//! Classify how OpenBLAS SGEMM combined two products per output
//! (probe_gemm.py): same FMA chain ascending, descending, or two partial
//! sums added.
use std::path::Path;

fn f32s(p: &Path) -> (Vec<usize>, Vec<f32>) {
    let b = std::fs::read(p).unwrap();
    let hl = u16::from_le_bytes([b[8], b[9]]) as usize;
    let h = String::from_utf8_lossy(&b[10..10 + hl]).to_string();
    let shape: Vec<usize> = h.split("'shape': (").nth(1).unwrap().split(')').next().unwrap().split(',').filter(|s| !s.trim().is_empty()).map(|s| s.trim().parse().unwrap()).collect();
    (shape, b[10 + hl..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn main() {
    let d = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let (ash, a) = f32s(&d.join("A.npy"));
    let (bsh, b) = f32s(&d.join("B.npy"));
    let (_, c) = f32s(&d.join("C.npy"));
    let (_, pairs) = f32s(&d.join("pairs.npy"));
    let (m, k) = (ash[0], ash[1]);
    let n = bsh[1];
    assert_eq!(bsh[0], k);
    for r in 0..m {
        let (k1, k2) = (pairs[2 * r] as usize, pairs[2 * r + 1] as usize);
        let (a1, a2) = (a[r * k + k1], a[r * k + k2]);
        let mut cnt = [0usize; 4];
        let mut decisive = 0;
        for t in 0..n {
            let (b1, b2) = (b[k1 * n + t], b[k2 * n + t]);
            let want = c[r * n + t];
            let asc = a2.mul_add(b2, a1 * b1);
            let desc = a1.mul_add(b1, a2 * b2);
            let sep = a1 * b1 + a2 * b2;
            let f64r = (a1 as f64 * b1 as f64 + a2 as f64 * b2 as f64) as f32;
            if asc != desc || asc != sep {
                decisive += 1;
            }
            for (i, v) in [asc, desc, sep, f64r].iter().enumerate() {
                if v.to_bits() == want.to_bits() {
                    cnt[i] += 1;
                }
            }
        }
        println!("row={r:3} k1={k1:4} k2={k2:4} d={:4} decisive={decisive:3} asc={:3} desc={:3} sep={:3} exact={:3}", k2 - k1, cnt[0], cnt[1], cnt[2], cnt[3]);
        if cnt[0] != n && cnt[2] != n {
            let mut cls = String::new();
            for t in 0..n {
                let (b1, b2) = (b[k1 * n + t], b[k2 * n + t]);
                let want = c[r * n + t].to_bits();
                let asc = a2.mul_add(b2, a1 * b1).to_bits() == want;
                let sep = (a1 * b1 + a2 * b2).to_bits() == want;
                cls.push(match (asc, sep) { (true, true) => '.', (true, false) => 'a', (false, true) => 's', _ => 'x' });
            }
            println!("    {cls}");
        }
    }
}
