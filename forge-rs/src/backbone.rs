//! transkun_v2.onnx (backbone + interval scorer) on ONNX Runtime, CPU EP,
//! fp32. ORT is loaded dynamically (`load-dynamic`), so the exact same
//! onnxruntime.dll the Python path uses can be pointed at for validation, and
//! the app can ship whichever build it bundles.

use crate::config::{frames_per_segment, CTX_DIM, N_MELS, N_SYMBOLS, N_WINDOWS};
use anyhow::{anyhow, bail, Context, Result};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Raw outputs for one segment.
pub struct BackboneOut {
    /// [T(end)][T(begin)][N_SYMBOLS]
    pub score: Vec<f32>,
    /// [T-1][N_SYMBOLS]
    pub noise: Vec<f32>,
    /// [N_SYMBOLS][T][CTX_DIM]
    pub ctx: Vec<f32>,
}

static ORT_INIT: OnceLock<std::result::Result<(PathBuf, ort::environment::Environment), String>> = OnceLock::new();

/// Candidate onnxruntime.dll locations, in priority order.
pub fn ort_dylib_candidates(explicit: Option<&Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = explicit {
        v.push(p.to_path_buf());
    }
    if let Some(p) = std::env::var_os("ORT_DYLIB_PATH") {
        v.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.join("onnxruntime.dll"));
        }
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        v.push(
            PathBuf::from(l)
                .join("midi-studio/forge-env/python/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"),
        );
    }
    v
}

/// Load ONNX Runtime once per process.
pub fn init_ort(explicit: Option<&Path>) -> Result<PathBuf> {
    let r = ORT_INIT.get_or_init(|| {
        let cands = ort_dylib_candidates(explicit);
        let Some(path) = cands.iter().find(|p| p.exists()).cloned() else {
            return Err(format!("onnxruntime.dll not found; tried {cands:?} (pass --ort-dylib or set ORT_DYLIB_PATH)"));
        };
        // ORT resolves onnxruntime_providers_shared.dll etc. next to itself.
        match ort::init_from(&path) {
            Ok(b) => match b.with_name("forge-rs").build() {
                Ok(env) => Ok((path, env)),
                Err(e) => Err(format!("ORT environment: {e}")),
            },
            Err(e) => Err(format!("loading {}: {e}", path.display())),
        }
    });
    match r {
        Ok((p, _)) => Ok(p.clone()),
        Err(e) => Err(anyhow!(e.clone())),
    }
}

pub fn environment() -> Result<&'static ort::environment::Environment> {
    match ORT_INIT.get() {
        Some(Ok((_, env))) => Ok(env),
        _ => bail!("ONNX Runtime not initialised (call init_ort first)"),
    }
}

pub struct Backbone {
    session: Session,
}

impl Backbone {
    pub fn load(onnx: &Path, intra_threads: Option<usize>) -> Result<Self> {
        let mut b = Session::builder(environment()?)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| anyhow!("{e}"))?;
        if let Some(n) = intra_threads {
            b = b.with_intra_threads(n).map_err(|e| anyhow!("{e}"))?;
        }
        let session = b
            .commit_from_file(onnx)
            .with_context(|| format!("loading {}", onnx.display()))?;
        let outs: Vec<String> = session.outputs().iter().map(|o| o.name().to_string()).collect();
        for need in ["score", "noise", "ctx"] {
            if !outs.iter().any(|o| o == need) {
                bail!("ONNX model has outputs {outs:?} but '{need}' is required (re-export with export_transkun_onnx.py)");
            }
        }
        Ok(Backbone { session })
    }

    pub fn run(&mut self, features: Vec<f32>) -> Result<BackboneOut> {
        let t = frames_per_segment();
        assert_eq!(features.len(), t * N_MELS * N_WINDOWS);
        let input = Tensor::from_array(([1usize, t, N_MELS, N_WINDOWS], features))?;
        let outputs = self.session.run(ort::inputs!["features" => input])?;
        let grab = |name: &str, want: &[usize]| -> Result<Vec<f32>> {
            let (shape, data) = outputs[name].try_extract_tensor::<f32>()?;
            let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
            if dims != want {
                bail!("output {name}: shape {dims:?}, expected {want:?}");
            }
            Ok(data.to_vec())
        };
        Ok(BackboneOut {
            score: grab("score", &[t, t, N_SYMBOLS])?,
            noise: grab("noise", &[t - 1, N_SYMBOLS])?,
            ctx: grab("ctx", &[1, N_SYMBOLS, t, CTX_DIM])?,
        })
    }
}
