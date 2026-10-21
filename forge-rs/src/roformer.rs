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
use ort::session::builder::GraphOptimizationLevel;
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
        crate::backbone::init_ort(opts.ort_dylib.as_deref())?;
        let mut b = Session::builder(crate::backbone::environment()?)?
            // FORGE_RS_ORT_OPT=0/1/2 is a diagnostic override (all levels give
            // bit-identical masks on this graph).
            .with_optimization_level(match std::env::var("FORGE_RS_ORT_OPT").as_deref() {
                Ok("0") => GraphOptimizationLevel::Disable,
                Ok("1") => GraphOptimizationLevel::Level1,
                Ok("2") => GraphOptimizationLevel::Level2,
                // ORT_ENABLE_ALL, as Python ORT defaults to; Level3 (ORT_ENABLE_LAYOUT)
                // does not exist before ORT 1.23 and 1.22 is the CUDA 12 build.
                _ => GraphOptimizationLevel::All,
            })
            .map_err(|e| anyhow!("{e}"))?;
        if let Some(n) = opts.intra_threads {
            b = b.with_intra_threads(n).map_err(|e| anyhow!("{e}"))?;
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
        let session = b.commit_from_file(onnx).with_context(|| format!("loading {}", onnx.display()))?;
        let ins: Vec<String> = session.inputs().iter().map(|o| o.name().to_string()).collect();
        let outs: Vec<String> = session.outputs().iter().map(|o| o.name().to_string()).collect();
        if ins != ["spec"] || outs != ["mask"] {
            bail!("{}: inputs {ins:?} outputs {outs:?}, expected [spec] -> [mask] (export with tools/export_bsrofo_body.py)", onnx.display());
        }
        Ok(Roformer { session, stft: Stft::new(), ep: opts.ep })
    }

    /// Network body on one spectrum: `spec` [T][FEAT] -> masks [N_STEMS][T][FEAT].
    pub fn run_body(&mut self, spec: Vec<f32>, t: usize) -> Result<Vec<f32>> {
        assert_eq!(spec.len(), t * FEAT);
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
