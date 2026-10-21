//! BS-Roformer (BS-Rofo-SW-Fixed) forward pass around the exported network
//! body: `BSRoformer.forward` with the STFT, the complex mask product, the
//! DC zeroing and the iSTFT done here and the band-split / transformers /
//! mask estimators in ONNX (tools/export_bsrofo_body.py).
//!
//! Body I/O: `spec` (1, T, 4100) -> `mask` (1, 6, T, 4100), last axis
//! `(f s c)` = ((freq * 2 + channel) * 2 + re/im), exactly
//! `rearrange(view_as_real(stft), 'b s f t c -> b t (f s c)')`.
//!
//! fp32 only: the CPU EP, or the CUDA EP with `use_tf32=0` (TF32 drifts
//! ~1e-3 on this graph).
//!
//! Parity floor: on synthetic input the whole forward matches torch to
//! ~2e-7. On real music it cannot get much below ~2e-4 (guitar/other),
//! because the network amplifies sub-ulp changes there: torch itself moves
//! those stems by 6e-4 (64-68 dB SDR) when the chunk is nudged by 1e-7
//! relative, and torch-CUDA-fp32 vs torch-CPU differs by 4e-4 (72-74 dB).
//! forge-rs vs MSST CPU measures 2.2e-4 / 76-105 dB, inside that floor; any
//! implementation that is not bit-identical to MKL+torch lands there too.

use crate::demix::{Planar, Stems};
use crate::stft::{n_frames, Stft, N_BINS};
use anyhow::{anyhow, bail, Context, Result};
use crate::model_cache::{CacheUse, ModelCache};
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;
use realfft::num_complex::Complex;
use std::path::{Path, PathBuf};

pub const ONNX_NAME: &str = "bsrofo_sw_body.onnx";
pub const N_STEMS: usize = 6;
pub const N_CHANNELS: usize = 2;
pub const FEAT: usize = N_BINS * N_CHANNELS * 2;
/// config.training.instruments, in mask-estimator order.
pub const INSTRUMENTS: [&str; N_STEMS] = ["bass", "drums", "other", "vocals", "guitar", "piano"];
pub const SAMPLE_RATE: u32 = 44100;
/// STFT frames of one demix chunk (588800 samples, hop 512): the only time
/// length the network ever sees, pinned in the session.
pub const CHUNK_FRAMES: usize = 1151;
/// The body's symbolic time axis (input `spec` is [1, T, 4100]).
const TIME_DIM: &str = "T";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ep {
    Cpu,
    Cuda { device_id: i32 },
}

#[derive(Debug, Clone)]
pub struct RoformerOptions {
    pub ep: Ep,
    pub intra_threads: Option<usize>,
    pub ort_dylib: Option<PathBuf>,
    /// Keep ORT's CPU memory arena. It holds every high-water buffer: 6.3 GiB
    /// peak commit on a 20 s clip vs 2.8 GiB without it, for ~13% less time.
    pub cpu_arena: bool,
    /// CUDA arena cap (`gpu_mem_limit`), grown `kSameAsRequested`. Under
    /// WDDM device allocations are charged to the process commit, so the
    /// default NextPowerOfTwo arena pushed commit to 6.9 GiB; 3.5 GiB of
    /// VRAM keeps it at 4.7 GiB at the same speed (2.5 GiB is too small for
    /// T=1151).
    pub cuda_mem_limit_gb: Option<f64>,
}

impl Default for RoformerOptions {
    fn default() -> Self {
        RoformerOptions { ep: Ep::Cpu, intra_threads: None, ort_dylib: None, cpu_arena: false, cuda_mem_limit_gb: Some(3.5) }
    }
}

/// `<models>/bs_rofo_sw/bsrofo_sw_body.onnx`, then `<models>/onnx/...`.
pub fn default_model_path(models_dir: Option<&Path>) -> Result<PathBuf> {
    let base = match models_dir {
        Some(d) => d.to_path_buf(),
        None => crate::assets::default_models_dir().ok_or_else(|| anyhow!("no models dir; pass --model"))?,
    };
    let cands = [base.join(ONNX_NAME), base.join("bs_rofo_sw").join(ONNX_NAME), base.join("onnx").join(ONNX_NAME)];
    cands
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| anyhow!("{ONNX_NAME} not found (tried {cands:?}); export it with tools/export_bsrofo_body.py or pass --model"))
}

pub struct Roformer {
    session: Session,
    stft: Stft,
    pub ep: Ep,
}

impl Roformer {
    pub fn load(onnx: &Path, opts: &RoformerOptions) -> Result<Self> {
        Ok(Self::load_cached(onnx, opts, None)?.0)
    }

    /// `load`, through the optimized-model cache when one is given.
    ///
    /// Session creation used to take 18-27 s, and almost none of it was
    /// optimization: with the time axis symbolic, ORT's allocation planner
    /// spends ~20 s on buffer reuse over the 14.8k-node graph. demix always
    /// feeds full chunks, so T is pinned to `CHUNK_FRAMES` and the planner's
    /// reuse is switched off (with T static it would raise peak commit from
    /// ~2 to ~7 GiB; see ortopts). The session then comes up in ~4 s, and
    /// in ~2 s from the optimized-model cache, with bit-identical masks.
    pub fn load_cached(onnx: &Path, opts: &RoformerOptions, cache: Option<&ModelCache>) -> Result<(Self, CacheUse)> {
        crate::backbone::init_ort(opts.ort_dylib.as_deref())?;
        // Pin T only where buffer reuse can be switched off (see ortopts);
        // FORGE_RS_PIN_T=0 (diagnostic) leaves T symbolic, as before the pin.
        let pin = std::env::var("FORGE_RS_PIN_T").as_deref() != Ok("0")
            && match crate::ortopts::disable_mem_reuse(&mut Session::builder(crate::backbone::environment()?)?) {
                Ok(()) => true,
                Err(why) => {
                    eprintln!("  [roformer] buffer reuse cannot be turned off on this ONNX Runtime ({why}); slow session start");
                    false
                }
            };
        let base = |level: GraphOptimizationLevel| -> Result<SessionBuilder> {
            let mut b = Session::builder(crate::backbone::environment()?)?.with_optimization_level(level).map_err(|e| anyhow!("{e}"))?;
            if let Some(n) = opts.intra_threads {
                b = b.with_intra_threads(n).map_err(|e| anyhow!("{e}"))?;
            }
            if pin {
                crate::ortopts::disable_mem_reuse(&mut b).map_err(|e| anyhow!("{e}"))?;
            }
            if opts.ep == Ep::Cpu && !opts.cpu_arena {
                let cpu = ort::ep::CPU::default().with_arena_allocator(false).build();
                b = b.with_execution_providers([cpu]).map_err(|e| anyhow!("{e}"))?;
            }
            if let Ep::Cuda { device_id } = opts.ep {
                let mut cuda = ort::ep::CUDA::default().with_device_id(device_id).with_tf32(false);
                if let Some(gb) = opts.cuda_mem_limit_gb.filter(|g| *g > 0.0) {
                    cuda = cuda
                        .with_memory_limit((gb * (1u64 << 30) as f64) as usize)
                        .with_arena_extend_strategy(ort::ep::ArenaExtendStrategy::SameAsRequested);
                }
                let cuda = cuda.build().error_on_failure();
                b = b.with_execution_providers([cuda]).map_err(|e| anyhow!("CUDA EP: {e}"))?;
            }
            Ok(b)
        };
        // FORGE_RS_ORT_OPT=0/1/2 is a diagnostic override (all levels give
        // bit-identical masks on this graph). Default ORT_ENABLE_ALL, as
        // Python ORT; Level3 (ORT_ENABLE_LAYOUT) does not exist before ORT
        // 1.23 and 1.22 is the CUDA 12 build.
        let level = match std::env::var("FORGE_RS_ORT_OPT").as_deref() {
            Ok("0") => GraphOptimizationLevel::Disable,
            Ok("1") => GraphOptimizationLevel::Level1,
            Ok("2") => GraphOptimizationLevel::Level2,
            _ => GraphOptimizationLevel::All,
        };
        // FORGE_RS_MEM_PATTERN=1 (diagnostic) keeps ORT's planned pattern.
        let mem_pattern = std::env::var("FORGE_RS_MEM_PATTERN").as_deref() == Ok("1");
        let pinned = |b: SessionBuilder| -> Result<SessionBuilder> {
            if pin {
                // Static shapes with the planner's reuse off: buffers are
                // allocated as needed and freed after their last use.
                b.with_dimension_override(TIME_DIM, CHUNK_FRAMES as i64)
                    .and_then(|b| b.with_memory_pattern(mem_pattern))
                    .map_err(|e| anyhow!("{e}"))
            } else {
                Ok(b)
            }
        };
        let ctx = || format!("loading {}", onnx.display());
        let tag = match opts.ep {
            Ep::Cpu if !pin => "cpu-dyn".to_string(),
            Ep::Cuda { device_id } if !pin => format!("cuda{device_id}-dyn"),
            Ep::Cpu => format!("cpu-t{CHUNK_FRAMES}"),
            Ep::Cuda { device_id } => format!("cuda{device_id}-t{CHUNK_FRAMES}"),
        };
        let entry = cache.filter(|_| level == GraphOptimizationLevel::All).and_then(|c| match c.entry(onnx, &tag) {
            Ok(e) => Some(e),
            Err(e) => {
                eprintln!("  [model cache] unavailable: {e:#}");
                None
            }
        });
        let (session, used) = match entry {
            None => (pinned(base(level)?)?.commit_from_file(onnx).with_context(ctx)?, CacheUse::Off),
            Some(e) => {
                let hit = if e.path.is_file() {
                    match base(GraphOptimizationLevel::Disable)?.commit_from_file(&e.path) {
                        Ok(s) => Some(s),
                        Err(err) => {
                            eprintln!("  [model cache] {} unreadable ({err}); rebuilding", e.path.display());
                            let _ = std::fs::remove_file(&e.path);
                            None
                        }
                    }
                } else {
                    None
                };
                match hit {
                    Some(s) => (s, CacheUse::Hit),
                    None => {
                        let tmp = e.temp_path();
                        let stored = pinned(base(level)?)?.with_optimized_model_path(&tmp).map_err(|e| anyhow!("{e}"))?.commit_from_file(onnx);
                        match stored {
                            Ok(s) => match e.commit(&tmp) {
                                Ok(()) => (s, CacheUse::Stored),
                                Err(err) => {
                                    eprintln!("  [model cache] could not store {}: {err:#}", e.path.display());
                                    (s, CacheUse::Unwritable)
                                }
                            },
                            Err(err) => {
                                let _ = std::fs::remove_file(&tmp);
                                eprintln!("  [model cache] could not write {} ({err}); loading without it", tmp.display());
                                (pinned(base(level)?)?.commit_from_file(onnx).with_context(ctx)?, CacheUse::Unwritable)
                            }
                        }
                    }
                }
            }
        };
        let r = Self::from_session(session, onnx, opts.ep)?;
        Ok((r, used))
    }

    fn from_session(session: Session, onnx: &Path, ep: Ep) -> Result<Self> {
        let ins: Vec<String> = session.inputs().iter().map(|o| o.name().to_string()).collect();
        let outs: Vec<String> = session.outputs().iter().map(|o| o.name().to_string()).collect();
        if ins != ["spec"] || outs != ["mask"] {
            bail!("{}: inputs {ins:?} outputs {outs:?}, expected [spec] -> [mask] (export with tools/export_bsrofo_body.py)", onnx.display());
        }
        Ok(Roformer { session, stft: Stft::new(), ep })
    }

    /// Network body on one spectrum: `spec` [T][FEAT] -> masks [N_STEMS][T][FEAT].
    pub fn run_body(&mut self, spec: Vec<f32>, t: usize) -> Result<Vec<f32>> {
        assert_eq!(spec.len(), t * FEAT);
        if t != CHUNK_FRAMES {
            bail!("body input has {t} frames; the session is pinned to {CHUNK_FRAMES} (one 588800-sample chunk)");
        }
        let input = Tensor::from_array(([1usize, t, FEAT], spec))?;
        let outputs = self.session.run(ort::inputs!["spec" => input])?;
        let (shape, data) = outputs["mask"].try_extract_tensor::<f32>()?;
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        if dims != [1, N_STEMS, t, FEAT] {
            bail!("mask shape {dims:?}, expected [1, {N_STEMS}, {t}, {FEAT}]");
        }
        Ok(data.to_vec())
    }

    /// `BSRoformer.forward(part)` for one stereo chunk: planar [2][L] ->
    /// stems [N_STEMS][2][L].
    pub fn forward(&mut self, part: &Planar) -> Result<Stems> {
        if part.len() != N_CHANNELS {
            bail!("BS-Rofo-SW is stereo; got {} channels", part.len());
        }
        let len = part[0].len();
        let t = n_frames(len);
        let (x0, x1) = rayon::join(|| self.stft.forward(&part[0]), || self.stft.forward(&part[1]));
        let specs = [x0, x1];
        // b s f t c -> b t (f s c)
        let mut feat = vec![0f32; t * FEAT];
        feat.par_chunks_mut(FEAT).enumerate().for_each(|(ti, row)| {
            for f in 0..N_BINS {
                for (s, x) in specs.iter().enumerate() {
                    let c = x[ti * N_BINS + f];
                    row[(f * 2 + s) * 2] = c.re;
                    row[(f * 2 + s) * 2 + 1] = c.im;
                }
            }
        });
        let mask = self.run_body(feat, t)?;
        let stft = &self.stft;
        let jobs: Vec<(usize, usize)> = (0..N_STEMS).flat_map(|n| (0..N_CHANNELS).map(move |s| (n, s))).collect();
        let outs: Vec<Vec<f32>> = jobs
            .par_iter()
            .map(|&(n, s)| {
                let x = &specs[s];
                let m = &mask[n * t * FEAT..(n + 1) * t * FEAT];
                stft.inverse_with(t, len, |ti, bins| {
                    let mrow = &m[ti * FEAT..(ti + 1) * FEAT];
                    let xrow = &x[ti * N_BINS..(ti + 1) * N_BINS];
                    for f in 0..N_BINS {
                        let (mr, mi) = (mrow[(f * 2 + s) * 2] as f64, mrow[(f * 2 + s) * 2 + 1] as f64);
                        let (xr, xi) = (xrow[f].re as f64, xrow[f].im as f64);
                        bins[f] = Complex::new(xr * mr - xi * mi, xr * mi + xi * mr);
                    }
                    // zero_dc: stft_repr.index_fill(1, 0, 0.)
                    bins[0] = Complex::new(0.0, 0.0);
                })
            })
            .collect();
        let mut it = outs.into_iter();
        Ok((0..N_STEMS).map(|_| (0..N_CHANNELS).map(|_| it.next().unwrap()).collect()).collect())
    }
}
