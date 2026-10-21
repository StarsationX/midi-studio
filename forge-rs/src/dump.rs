//! Optional intermediate-tensor dumps (.npy / .json), named like
//! tools/py_reference.py --dump so the two runs can be diffed.

use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct Dump {
    dir: Option<PathBuf>,
}

impl Dump {
    pub fn none() -> Self {
        Dump { dir: None }
    }
    pub fn to(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Dump { dir: Some(dir.to_path_buf()) })
    }
    pub fn enabled(&self) -> bool {
        self.dir.is_some()
    }
    pub fn npy_f32(&self, name: &str, shape: &[usize], data: &[f32]) {
        if let Some(d) = &self.dir {
            if let Err(e) = write_npy_f32(&d.join(format!("{name}.npy")), shape, data) {
                eprintln!("dump {name}: {e}");
            }
        }
    }
    pub fn json(&self, name: &str, v: &serde_json::Value) {
        if let Some(d) = &self.dir {
            if let Err(e) = std::fs::write(d.join(format!("{name}.json")), v.to_string()) {
                eprintln!("dump {name}: {e}");
            }
        }
    }
}

pub fn write_npy_f32(path: &Path, shape: &[usize], data: &[f32]) -> std::io::Result<()> {
    assert_eq!(shape.iter().product::<usize>(), data.len());
    let dims = shape.iter().map(|d| d.to_string()).collect::<Vec<_>>();
    let shape_s = if dims.len() == 1 { format!("({},)", dims[0]) } else { format!("({})", dims.join(", ")) };
    let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': {shape_s}, }}");
    let total = 10 + header.len() + 1;
    header.push_str(&" ".repeat((64 - total % 64) % 64));
    header.push('\n');
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"\x93NUMPY\x01\x00")?;
    f.write_all(&(header.len() as u16).to_le_bytes())?;
    f.write_all(header.as_bytes())?;
    for v in data {
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()
}

/// Minimal little-endian f32 .npy reader (C order), for tests.
pub fn read_npy_f32(path: &Path) -> std::io::Result<(Vec<usize>, Vec<f32>)> {
    let bytes = std::fs::read(path)?;
    let bad = |m: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, m.to_string());
    if &bytes[..6] != b"\x93NUMPY" {
        return Err(bad("not npy"));
    }
    let (hlen, off) = if bytes[6] == 1 {
        (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10)
    } else {
        (u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize, 12)
    };
    let header = std::str::from_utf8(&bytes[off..off + hlen]).map_err(|_| bad("header"))?;
    if !header.contains("'<f4'") || header.contains("'fortran_order': True") {
        return Err(bad("expected C-order <f4"));
    }
    let s = header.split("'shape': (").nth(1).and_then(|r| r.split(')').next()).ok_or_else(|| bad("shape"))?;
    let shape: Vec<usize> = s.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    let data = bytes[off + hlen..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok((shape, data))
}
