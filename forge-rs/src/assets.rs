//! Model files: transkun_v2.onnx (+ .data) and transkun_v2_aux.safetensors
//! (front-end windows / mel filterbank and the two attribute-head MLPs,
//! produced by python-engine/export_transkun_aux.py).

use crate::config::{CTX_DIM, HEAD_HIDDEN, N_FREQ, N_MELS, N_WINDOWS, WINDOW_SIZE};
use anyhow::{anyhow, bail, Context, Result};
use safetensors::{Dtype, SafeTensors};
use std::path::{Path, PathBuf};

pub const ONNX_NAME: &str = "transkun_v2.onnx";
pub const AUX_NAME: &str = "transkun_v2_aux.safetensors";

/// Linear(768 -> 512) - GELU - Linear(512 -> out).
#[derive(Debug, Clone)]
pub struct Mlp {
    /// Row-major [HEAD_HIDDEN][3 * CTX_DIM].
    pub w0: Vec<f32>,
    pub b0: Vec<f32>,
    /// Row-major [out][HEAD_HIDDEN].
    pub w3: Vec<f32>,
    pub b3: Vec<f32>,
    pub out: usize,
}

#[derive(Debug, Clone)]
pub struct Aux {
    /// [N_WINDOWS][WINDOW_SIZE]
    pub windows: Vec<f32>,
    /// [N_FREQ][N_MELS]
    pub freq2mels: Vec<f32>,
    pub velocity: Mlp,
    pub refined_of: Mlp,
}

fn tensor(st: &SafeTensors, name: &str, shape: &[usize]) -> Result<Vec<f32>> {
    let t = st.tensor(name).map_err(|e| anyhow!("aux tensor {name}: {e}"))?;
    if t.dtype() != Dtype::F32 {
        bail!("aux tensor {name}: expected F32, got {:?}", t.dtype());
    }
    if t.shape() != shape {
        bail!("aux tensor {name}: expected shape {shape:?}, got {:?}", t.shape());
    }
    Ok(t.data()
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

impl Aux {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let st = SafeTensors::deserialize(&bytes).map_err(|e| anyhow!("{}: {e}", path.display()))?;
        let mlp = |p: &str, out: usize| -> Result<Mlp> {
            Ok(Mlp {
                w0: tensor(&st, &format!("{p}.0.weight"), &[HEAD_HIDDEN, 3 * CTX_DIM])?,
                b0: tensor(&st, &format!("{p}.0.bias"), &[HEAD_HIDDEN])?,
                w3: tensor(&st, &format!("{p}.3.weight"), &[out, HEAD_HIDDEN])?,
                b3: tensor(&st, &format!("{p}.3.bias"), &[out])?,
                out,
            })
        };
        Ok(Aux {
            windows: tensor(&st, "frontend.windows", &[N_WINDOWS, WINDOW_SIZE])?,
            freq2mels: tensor(&st, "frontend.freq2mels", &[N_FREQ, N_MELS])?,
            velocity: mlp("velocity", 128)?,
            refined_of: mlp("refined_of", 4)?,
        })
    }
}

/// Where the forge-env keeps the models on this machine.
pub fn default_models_dir() -> Option<PathBuf> {
    std::env::var_os("MIDI_STUDIO_MODELS_DIR").map(PathBuf::from).or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(|l| PathBuf::from(l).join("midi-studio").join("forge-env").join("models"))
    })
}

#[derive(Debug, Clone)]
pub struct AssetPaths {
    pub onnx: PathBuf,
    pub aux: PathBuf,
}

impl AssetPaths {
    /// `dir` may be the models dir (with an `onnx/` subdir) or the onnx dir
    /// itself. `aux` overrides the aux file location.
    pub fn resolve(dir: Option<&Path>, aux: Option<&Path>) -> Result<Self> {
        let base = match dir {
            Some(d) => d.to_path_buf(),
            None => default_models_dir().ok_or_else(|| anyhow!("no models dir; pass --models"))?,
        };
        let onnx_dir = if base.join(ONNX_NAME).exists() { base.clone() } else { base.join("onnx") };
        let onnx = onnx_dir.join(ONNX_NAME);
        if !onnx.exists() {
            bail!("{} not found (looked in {} and {}/onnx)", ONNX_NAME, base.display(), base.display());
        }
        let aux = match aux {
            Some(a) => a.to_path_buf(),
            None => {
                let cands = [onnx_dir.join(AUX_NAME), base.join(AUX_NAME)];
                cands
                    .iter()
                    .find(|p| p.exists())
                    .cloned()
                    .ok_or_else(|| anyhow!("{AUX_NAME} not found next to {}; run python-engine/export_transkun_aux.py or pass --aux", onnx.display()))?
            }
        };
        if !aux.exists() {
            bail!("{} not found", aux.display());
        }
        Ok(AssetPaths { onnx, aux })
    }
}
