//! `forge-rs pipeline`: every Midi Forge mode without Python.
//!
//! * piano / general: song_to_midi.py (with `--skip-separation`,
//!   transcribe.py), including the sparse-piano basic-pitch check.
//! * melody: melody_to_midi.py (Clean / Balanced / Detailed candidates).
//! * drums: drums_to_midi.py.
//! * fast: stem_to_midi.py (basic-pitch straight on the audio).
//!
//! Same inputs (`<audio> [<out.mid>]`), the same environment knobs, the same
//! output files, and the same stdout lines the app's runner parses: the
//! scripts' `[n/N]` stage markers and prose, `TSEG|done|total` after every
//! Transkun segment, `SSEG|done|total` after every separation chunk,
//! `RESULT|{json}` (melody) and `DONE`. The intermediate WAV and MIDI files
//! the scripts write are reproduced in memory with their exact formats
//! (clips and normalised audio as soundfile PCM_16, MSST stems as float,
//! basic-pitch's MIDI written and read back through pretty_midi), so nothing
//! touches disk unless FORGE_KEEP_STEMS=1.
//!
//! fp32 everywhere: CPU, or CUDA with TF32 off. The Python app runs MSST in
//! fp16 autocast with NVIDIA_TF32_OVERRIDE=1 and Transkun in TF32; none of
//! that is copied.

use crate::assets::{AssetPaths, AUX_NAME};
use crate::audio::{self, Audio, SourceKind};
use crate::demix::DemixParams;
use crate::dump::Dump;
use crate::midi;
use crate::model_cache::{CacheUse, ModelCache};
use crate::ortenv::{self, EpChoice, OrtPlan};
use crate::post::{self, CleanOpts, NormalizeOpts};
use crate::roformer::{self, Ep, Roformer, RoformerOptions, INSTRUMENTS, SAMPLE_RATE};
use crate::separate;
use crate::transcribe::{Options, Transcriber};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::json;
use std::hash::Hasher;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[path = "expressive_dynamics.rs"]
mod expressive_dynamics;
#[path = "expressive_stems.rs"]
pub mod expressive_stems;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Piano,
    Expressive,
    General,
    Melody,
    Drums,
    Fast,
}

#[path = "expressive.rs"]
mod expressive;

pub const MODES: [&str; 6] = ["piano", "expressive", "general", "melody", "drums", "fast"];

impl Mode {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "piano" => Ok(Mode::Piano),
            "expressive" => Ok(Mode::Expressive),
            "general" => Ok(Mode::General),
            "melody" => Ok(Mode::Melody),
            "drums" => Ok(Mode::Drums),
            "fast" => Ok(Mode::Fast),
            o => bail!("unknown mode {o} (expected one of {})", MODES.join(", ")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Piano => "piano",
            Mode::Expressive => "expressive",
            Mode::General => "general",
            Mode::Melody => "melody",
            Mode::Drums => "drums",
            Mode::Fast => "fast",
        }
    }

    /// Whether a run in this mode separates (its scripts' rules: fast never
    /// does; melody and drums also skip on SKIP_SEPARATION=1).
    pub fn separates(self, skip_flag: bool) -> bool {
        match self {
            Mode::Fast => false,
            Mode::Expressive => true,
            Mode::Melody | Mode::Drums => !(skip_flag || env_flag("SKIP_SEPARATION", false)),
            Mode::Piano | Mode::General => !skip_flag,
        }
    }

    fn uses_transkun(self) -> bool {
        matches!(self, Mode::Piano | Mode::General | Mode::Expressive)
    }

    fn uses_basic_pitch(self) -> bool {
        matches!(self, Mode::Melody | Mode::Fast | Mode::Expressive)
    }
}

/// Print one line the runner reads, on stdout, flushed. Everything the
/// runner parses goes here so stage, TSEG and SSEG lines can never be
/// reordered against each other across two pipes.
macro_rules! say {
    () => {{ println!(); }};
    ($($t:tt)*) => {{
        println!($($t)*);
        let _ = std::io::stdout().flush();
    }};
}

fn env_str(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

fn env_f64(k: &str, d: f64) -> Result<f64> {
    match env_str(k) {
        Some(v) => v.trim().parse().map_err(|_| anyhow!("{k}={v:?} is not a number")),
        None => Ok(d),
    }
}

fn env_i64(k: &str, d: i64) -> Result<i64> {
    match env_str(k) {
        Some(v) => v.trim().parse().map_err(|_| anyhow!("{k}={v:?} is not an integer")),
        None => Ok(d),
    }
}

fn env_flag(k: &str, d: bool) -> bool {
    match env_str(k) {
        Some(v) => matches!(v.as_str(), "1" | "true" | "True" | "yes"),
        None => d,
    }
}

/// The environment knobs song_to_midi.py / transcribe.py read, with their
/// defaults and their parsing (a value Python's float() / int() rejects is
/// an error here too).
#[derive(Debug, Clone)]
pub struct Knobs {
    pub general_mode: bool,
    pub clean: CleanOpts,
    pub normalize: NormalizeOpts,
    pub loudness_norm: bool,
    pub segment_hop: Option<f64>,
    pub segment_size: Option<String>,
    pub exclude_stems: Vec<String>,
    pub exclude_vocals: bool,
    pub start_raw: String,
    pub end_raw: String,
    pub keep_stems: bool,
    pub use_tta: bool,
    pub bigshifts: i64,
    pub separation_batch: Option<usize>,
    pub separation_backend: String,
}

impl Knobs {
    pub fn from_env() -> Result<Knobs> {
        let clamp7 = |v: i64| v.clamp(0, 127) as u8;
        let clean = CleanOpts {
            min_note_sec: env_f64("MIN_NOTE_SEC", 0.03)?,
            min_velocity: clamp7(env_i64("MIN_VELOCITY", 20)?),
            min_pitch: clamp7(env_i64("PIANO_MIN_PITCH", 21)?),
            max_pitch: clamp7(env_i64("PIANO_MAX_PITCH", 108)?),
            velocity_gamma: env_f64("VELOCITY_GAMMA", 0.85)?,
            max_polyphony: env_i64("MAX_POLYPHONY", 0)?.max(0) as usize,
        };
        let segment_hop = match env_str("SEGMENT_HOP").filter(|s| !s.is_empty()) {
            Some(v) => Some(v.trim().parse::<f64>().map_err(|_| anyhow!("SEGMENT_HOP={v:?} is not a number"))?),
            None => None,
        };
        let batch = match env_str("SEPARATION_BATCH").filter(|s| !s.is_empty()) {
            Some(v) => Some(v.trim().parse::<i64>().map_err(|_| anyhow!("SEPARATION_BATCH={v:?} is not an integer"))?.max(1) as usize),
            None => None,
        };
        Ok(Knobs {
            general_mode: env_flag("GENERAL_MODE", false),
            clean,
            normalize: NormalizeOpts { target_rms_db: env_f64("TARGET_RMS_DB", -20.0)?, peak_ceiling_db: env_f64("PEAK_CEILING_DB", -1.0)? },
            loudness_norm: env_flag("LOUDNESS_NORM", true),
            segment_hop,
            segment_size: env_str("SEGMENT_SIZE").filter(|s| !s.is_empty()),
            exclude_stems: env_str("EXCLUDE_STEMS")
                .unwrap_or_else(|| "drum,percussion".into())
                .split(',')
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect(),
            exclude_vocals: env_flag("EXCLUDE_VOCALS", false),
            start_raw: env_str("FORGE_START_SEC").unwrap_or_default().trim().to_string(),
            end_raw: env_str("FORGE_END_SEC").unwrap_or_default().trim().to_string(),
            keep_stems: env_str("FORGE_KEEP_STEMS").as_deref() == Some("1"),
            use_tta: env_flag("USE_TTA", false),
            bigshifts: env_i64("BIGSHIFTS", 1)?,
            separation_batch: batch,
            separation_backend: env_str("SEPARATION_BACKEND").unwrap_or_else(|| "auto".into()).to_lowercase(),
        })
    }

    /// Settings this port does not implement; the app routes such a job to
    /// Python instead, and the CLI refuses it rather than ignoring it.
    pub fn unsupported(&self) -> Vec<String> {
        self.unsupported_for(Mode::Piano, false)
    }

    /// Only the settings the job would actually use: separation knobs when
    /// it separates, the Transkun segment size when it runs Transkun.
    pub fn unsupported_for(&self, mode: Mode, skip_flag: bool) -> Vec<String> {
        let mut v = Vec::new();
        if mode.separates(skip_flag) {
            if self.use_tta {
                v.push("USE_TTA=1 (test-time augmentation)".into());
            }
            if self.bigshifts > 1 {
                v.push(format!("BIGSHIFTS={}", self.bigshifts));
            }
            if self.separation_backend == "onnx_dml" {
                v.push("SEPARATION_BACKEND=onnx_dml (MDX-Net on DirectML)".into());
            }
        }
        if mode.uses_transkun() {
            if let Some(s) = &self.segment_size {
                if s.trim().parse::<f64>().ok() != Some(16.0) {
                    v.push(format!("SEGMENT_SIZE={s} (Transkun runs 16 s segments)"));
                }
            }
        }
        v
    }
}

#[derive(Debug, Clone)]
pub struct Args {
    pub input: PathBuf,
    pub output: Option<PathBuf>,
    /// None: GENERAL_MODE decides, as in song_to_midi.py.
    pub mode: Option<Mode>,
    /// transcribe.py instead of song_to_midi.py (the app's "skip separation").
    pub skip_separation: bool,
    pub ep: EpChoice,
    /// Run the Transkun backbone on the GPU too when separation got CUDA.
    pub transkun_gpu: bool,
    pub ort_dylib: Option<PathBuf>,
    pub cuda_dir: Option<PathBuf>,
    pub models: Option<PathBuf>,
    pub aux: Option<PathBuf>,
    pub rofo_model: Option<PathBuf>,
    pub threads: Option<usize>,
    pub cpu_arena: bool,
    pub cuda_mem_gb: f64,
    /// Accepted for older callers; nothing runs Python any more.
    pub python: Option<PathBuf>,
    pub engine_dir: Option<PathBuf>,
    pub sparse_recovery: bool,
    /// basic-pitch's nmp.onnx (default: basicpitch::default_model_path).
    pub bp_model: Option<PathBuf>,
}

impl Args {
    pub fn new(input: PathBuf) -> Args {
        Args {
            input,
            output: None,
            mode: None,
            skip_separation: false,
            ep: EpChoice::Auto,
            transkun_gpu: true,
            ort_dylib: None,
            cuda_dir: None,
            models: None,
            aux: None,
            rofo_model: None,
            threads: None,
            cpu_arena: false,
            cuda_mem_gb: 3.5,
            python: None,
            engine_dir: None,
            sparse_recovery: true,
            bp_model: None,
        }
    }
}

fn bp_model_path(args: &Args) -> Result<PathBuf> {
    match &args.bp_model {
        Some(p) if p.is_file() => Ok(p.clone()),
        Some(p) => Err(anyhow!("{} not found", p.display())),
        None => crate::basicpitch::default_model_path(),
    }
}

// ---- assets ----------------------------------------------------------------------

/// `<exe dir>/assets/<rel>` (a bundled build) and `<exe dir>/../../assets/<rel>`
/// (cargo's target/<profile>/ inside the crate).
fn exe_assets(rel: &str) -> Vec<PathBuf> {
    let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) else { return Vec::new() };
    let mut v = vec![d.join("assets").join(rel)];
    if let Some(up) = d.parent().and_then(Path::parent) {
        v.push(up.join("assets").join(rel));
    }
    v
}

fn env_file(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn expressive_model(models: Option<&Path>) -> Result<PathBuf> {
    const DIR: &str = "game/GAME-1.0.3-medium-onnx";
    const GRAPHS: [(&str, u64); 5] = [
        ("encoder.onnx", 40809108), ("segmenter.onnx", 80703699),
        ("estimator.onnx", 74457404), ("bd2dur.onnx", 4569), ("dur2bd.onnx", 2632),
    ];
    let native = env_file("FORGE_RS_NATIVE_ASSETS").filter(|_| models.is_none());
    let base = models.map(Path::to_path_buf).or_else(crate::assets::default_models_dir);
    let candidates = native.into_iter().chain(base).map(|p| p.join(DIR)).chain(exe_assets(DIR));
    candidates.into_iter().find(|p| GRAPHS.iter().all(|(name, size)| {
        std::fs::metadata(p.join(name)).is_ok_and(|m| m.is_file() && m.len() == *size)
    })).context("Medley needs the five GAME 1.0.3 medium ONNX files in assets/game/GAME-1.0.3-medium-onnx or the Forge models folder")
}

/// Transkun ONNX + aux: --models / MIDI_STUDIO_MODELS_DIR for the ONNX;
/// --aux, FORGE_RS_AUX, next to the ONNX, then the forge-rs assets folder.
pub fn transkun_assets(models: Option<&Path>, aux: Option<&Path>) -> Result<AssetPaths> {
    let explicit = aux.map(Path::to_path_buf).or_else(|| env_file("FORGE_RS_AUX"));
    if models.is_none() {
        if let Some(native) = env_file("FORGE_RS_NATIVE_ASSETS") {
            if let Ok(paths) = AssetPaths::resolve(Some(&native), explicit.as_deref()) { return Ok(paths); }
        }
    }
    let configured = match AssetPaths::resolve(models, explicit.as_deref()) {
        Ok(p) => Ok(p),
        Err(e) if explicit.is_none() => match exe_assets(AUX_NAME).into_iter().find(|p| p.is_file()) {
            Some(a) => AssetPaths::resolve(models, Some(&a)),
            None => Err(e),
        },
        Err(e) => Err(e),
    };
    configured.or_else(|error| {
        if models.is_none() && explicit.is_none() {
            for dir in exe_assets("onnx") {
                if let Ok(paths) = AssetPaths::resolve(Some(&dir), None) {
                    return Ok(paths);
                }
            }
        }
        Err(error)
    })
}

/// bsrofo_sw_body.onnx: --model, FORGE_RS_ROFO_MODEL, the models dir, then
/// the forge-rs assets folder.
pub fn roformer_model(models: Option<&Path>, explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit.map(Path::to_path_buf).or_else(|| env_file("FORGE_RS_ROFO_MODEL")) {
        return if p.is_file() { Ok(p) } else { Err(anyhow!("{} not found", p.display())) };
    }
    match roformer::default_model_path(models) {
        Ok(p) => Ok(p),
        Err(e) => exe_assets(&format!("bs_rofo_sw/{}", roformer::ONNX_NAME)).into_iter().find(|p| p.is_file()).ok_or(e),
    }
}

/// What a run would use, without loading anything: the app asks this before
/// routing a job here. With `args.mode` set, `ready` / `missing` cover only
/// what that mode (and `--skip-separation`) needs; without it, every model.
pub fn probe(args: &Args) -> serde_json::Value {
    // Fast and already-isolated Melody use the CPU EP even on a CUDA PC.
    let cpu_only = args.mode.is_some_and(|m| m == Mode::Fast || (m == Mode::Melody && !m.separates(args.skip_separation)));
    let plan = ortenv::plan(if cpu_only { EpChoice::Cpu } else { args.ep }, args.ort_dylib.as_deref(), args.cuda_dir.as_deref());
    let tk = transkun_assets(args.models.as_deref(), args.aux.as_deref());
    let rofo = roformer_model(args.models.as_deref(), args.rofo_model.as_deref());
    let bp = bp_model_path(args);
    let game = expressive_model(args.models.as_deref());
    let p = |r: &Result<PathBuf>| r.as_ref().map_or(serde_json::Value::Null, |p| json!(p.to_string_lossy()));
    let needs = |m: Mode| -> Vec<&'static str> {
        let mut v = Vec::new();
        if m.uses_transkun() {
            v.push("transkun");
        }
        if m.separates(args.skip_separation) {
            v.push("roformer");
        }
        if m.uses_basic_pitch() || (m == Mode::Piano && m.separates(args.skip_separation) && args.sparse_recovery) {
            v.push("basic-pitch");
        }
        if m == Mode::Expressive {
            v.push("vocal model");
        }
        if !v.is_empty() {
            v.push("onnxruntime");
        }
        v
    };
    let err_of = |what: &str| -> Option<String> {
        match what {
            "transkun" => tk.as_ref().err().map(|e| format!("transkun: {e:#}")),
            "roformer" => rofo.as_ref().err().map(|e| format!("roformer: {e:#}")),
            "basic-pitch" => bp.as_ref().err().map(|e| format!("basic-pitch: {e:#}")),
            "vocal model" => game.as_ref().err().map(|e| e.to_string()),
            _ => plan.as_ref().err().map(|e| format!("onnxruntime: {e:#}")),
        }
    };
    let wanted: Vec<&str> = match args.mode {
        Some(m) => needs(m),
        None => vec!["transkun", "roformer", "basic-pitch", "onnxruntime"],
    };
    let missing: Vec<String> = wanted.iter().filter_map(|w| err_of(w)).collect();
    let modes_ready: serde_json::Map<String, serde_json::Value> =
        MODES.iter().map(|m| (m.to_string(), json!(needs(Mode::parse(m).expect("mode")).iter().all(|w| err_of(w).is_none())))).collect();
    json!({
        "ready": missing.is_empty(),
        "modes": MODES,
        "modesReady": modes_ready,
        "basicPitch": p(&bp),
        "ep": plan.as_ref().map_or("none", |p| if p.ep == Ep::Cpu { "cpu" } else { "cuda" }),
        "whyCpu": plan.as_ref().map_or(String::new(), |p| p.why_cpu.clone()),
        "ort": plan.as_ref().map_or(serde_json::Value::Null, |p| json!(p.dylib.to_string_lossy())),
        "cudaDir": plan.as_ref().ok().and_then(|p| p.cuda_dir.as_ref()).map_or(serde_json::Value::Null, |d| json!(d.to_string_lossy())),
        "transkun": p(&tk.as_ref().map(|a| a.onnx.clone()).map_err(|e| anyhow!("{e:#}"))),
        "aux": p(&tk.as_ref().map(|a| a.aux.clone()).map_err(|e| anyhow!("{e:#}"))),
        "roformer": p(&rofo),
        "vocalModel": p(&game),
        "missing": missing,
    })
}

// ---- song_to_midi helpers ---------------------------------------------------------

/// song_to_midi.safe_name
pub fn safe_name(name: &str) -> String {
    let bad = |c: char| "[]()*?{}<>:\"|!&#%$".contains(c);
    let replaced: String = name.chars().map(|c| if bad(c) { '_' } else { c }).collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = collapsed.trim_matches(|c: char| c == ' ' || c == '.' || c == '_');
    if t.is_empty() { "audio".into() } else { t.into() }
}

/// Python's repr() of a float, for the lines that echo a setting.
fn py_float(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e16 { format!("{v:.1}") } else { format!("{v}") }
}

/// song_to_midi.work_root(src, suffix): `<forge env>\work\<name><suffix>-<tag>`,
/// or `<song dir>\stems\...` outside the app. Created only when needed.
fn work_root(src: &Path, suffix: &str) -> PathBuf {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(src.to_string_lossy().as_bytes());
    let tag = format!("{:016x}", h.finish());
    let root = match env_file("MIDI_STUDIO_FORGE_ENV_DIR") {
        Some(b) => b.join("work"),
        None => src.parent().unwrap_or(Path::new(".")).join("stems"),
    };
    root.join(format!("{}{suffix}-{}", safe_name(&stem), &tag[..8]))
}

/// song_to_midi.cleanup_work
fn cleanup_work(work: &Path, keep: bool) {
    if keep {
        say!("  (kept stems: {})", work.display());
    } else if work.exists() {
        let _ = std::fs::remove_dir_all(work);
    }
}

/// audio_utils.audio_window_from_env: FORGE_START_SEC / FORGE_END_SEC, as
/// librosa.load(sr=None, offset, duration) then sf.write (PCM_16).
pub fn apply_window(a: Audio, start_raw: &str, end_raw: &str) -> Result<(Audio, Option<String>)> {
    if start_raw.is_empty() && end_raw.is_empty() {
        return Ok((a, None));
    }
    let num = |s: &str, k: &str| -> Result<f64> {
        if s.is_empty() {
            Ok(0.0)
        } else {
            s.parse().map_err(|_| anyhow!("{k}={s:?} is not a number"))
        }
    };
    let start = num(start_raw, "FORGE_START_SEC")?.max(0.0);
    let end = num(end_raw, "FORGE_END_SEC")?;
    let duration = (end > start).then_some(end - start);
    if start <= 0.0 && duration.is_none() {
        return Ok((a, None));
    }
    let sr = a.sample_rate as f64;
    let n = a.frames();
    let s0 = ((start * sr) as usize).min(n);
    let s1 = match duration {
        Some(d) => (s0 + (d * sr) as usize).min(n),
        None => n,
    };
    if s1 <= s0 {
        bail!("Selected time range contains no audio.");
    }
    let c = a.channels;
    let clip = Audio { sample_rate: a.sample_rate, channels: c, samples: a.samples[s0 * c..s1 * c].to_vec(), kind: a.kind };
    let clip = post::as_pcm16(&clip, &clip.samples);
    let label = format!("Time range: {start:.3}s -> {}", if end > start { format!("{end:.3}s") } else { "end".into() });
    Ok((clip, Some(label)))
}

fn stereo_audio(st: &[Vec<f32>], kind: SourceKind) -> Audio {
    Audio { sample_rate: SAMPLE_RATE, channels: st.len(), samples: separate::interleave(st), kind }
}

/// Write `a` the way song_to_midi leaves it on disk: PCM_16 once normalised
/// (or for the general mix), float otherwise (an MSST stem).
fn write_stem_wav(path: &Path, a: &Audio) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
    }
    let planar: Vec<Vec<f32>> = (0..a.channels).map(|c| a.samples.iter().skip(c).step_by(a.channels).copied().collect()).collect();
    match a.kind {
        SourceKind::Int(16) => separate::write_wav_pcm16(path, &planar, a.sample_rate),
        _ => separate::write_wav_f32(path, &planar, a.sample_rate),
    }
}

// ---- runtime ---------------------------------------------------------------------

struct Runtime {
    plan: OrtPlan,
    version: String,
    device: Option<(String, u64)>,
}

/// Load ONNX Runtime for this process. basic-pitch only ever runs on the
/// CPU EP (as the forge env's basic_pitch does), so a run that needs nothing
/// else asks for the CPU build: the same onnxruntime the Python uses.
fn start_runtime_with(args: &Args, choice: EpChoice) -> Result<Runtime> {
    let plan = ortenv::plan(choice, args.ort_dylib.as_deref(), args.cuda_dir.as_deref())?;
    if let Some(d) = &plan.cuda_dir {
        ortenv::prepend_path(d)?;
        // Provider dependencies can live beside ORT in Forge storage, not
        // beside forge-rs.exe or in the CUDA toolkit.
        if let Some(dir) = plan.dylib.parent().filter(|dir| *dir != d.as_path()) { ortenv::prepend_path(dir)?; }
    }
    crate::backbone::init_ort(Some(&plan.dylib))?;
    let version = ortenv::loaded_version().map_or("?".into(), |(a, b)| format!("{a}.{b}"));
    let device = plan.cuda_dir.as_deref().and_then(ortenv::cuda_device_info);
    Ok(Runtime { plan, version, device })
}

fn start_runtime(args: &Args) -> Result<Runtime> {
    start_runtime_with(args, args.ep)
}

fn ep_name(ep: Ep) -> &'static str {
    match ep {
        Ep::Cpu => "cpu",
        Ep::Cuda { .. } => "cuda",
    }
}

fn load_roformer(model: &Path, args: &Args, ep: Ep, cache: Option<&ModelCache>) -> Result<(Roformer, CacheUse)> {
    let o = RoformerOptions { ep, intra_threads: args.threads, ort_dylib: None, cpu_arena: args.cpu_arena, cuda_mem_limit_gb: Some(args.cuda_mem_gb) };
    Roformer::load_cached(model, &o, cache)
}

struct Transcribed {
    notes: Vec<crate::Note>,
    ep: Ep,
}

fn transcribe(paths: &AssetPaths, a: &Audio, args: &Args, knobs: &Knobs, ep: Ep) -> Result<Transcribed> {
    let mut opts = Options { intra_threads: args.threads, ep, ..Options::default() };
    if let Some(h) = knobs.segment_hop {
        opts.segment_hop = h;
    }
    let mut tr = match Transcriber::new(paths, &opts) {
        Ok(t) => t,
        Err(e) if ep != Ep::Cpu => {
            say!("  Transkun on CUDA unavailable ({e:#}); using the CPU");
            opts.ep = Ep::Cpu;
            Transcriber::new(paths, &opts)?
        }
        Err(e) => return Err(e),
    };
    tr.progress = Some(Box::new(|done, total| say!("TSEG|{done}|{total}")));
    let tuned = match crate::tuning::retune(a)? {
        None => None,
        Some((cents, None)) => {
            say!("  tuning {:+.0} cents from A440, close enough", cents);
            None
        }
        Some((cents, Some(t))) => {
            say!("  tuning {:+.0} cents from A440, retuned for transcription", cents);
            Some(t)
        }
    };
    let (mut notes, t) = tr.transcribe_audio(tuned.as_ref().map_or(a, |(x, _)| x), &opts, &Dump::none())?;
    if let Some((_, ratio)) = tuned {
        for n in &mut notes {
            n.start *= ratio;
            n.end *= ratio;
        }
    }
    eprintln!(
        "[timing] transkun {:.2}s = load {:.2} + resample {:.2} + frontend {:.2} + backbone {:.2} + decode/heads {:.2} ({} segments, {})",
        t.total_s + tr.load_s,
        tr.load_s,
        t.resample_s,
        t.frontend_s,
        t.backbone_s,
        t.decode_s,
        t.segments,
        ep_name(opts.ep)
    );
    Ok(Transcribed { notes, ep: opts.ep })
}

/// Clean and write; returns (before, after).
fn clean_and_write(notes: &[crate::Note], out: &Path, o: &CleanOpts) -> Result<(usize, usize)> {
    let piano = midi::piano_from_notes(notes)?;
    let (before, after, cleaned) = post::clean_midi(&piano, o);
    if let Some(d) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
    }
    std::fs::write(out, midi::piano_to_bytes(cleaned.as_ref())?).with_context(|| format!("write {}", out.display()))?;
    Ok((before, after))
}

// ---- the pipelines ---------------------------------------------------------------

pub fn run(args: &Args) -> Result<()> {
    let knobs = Knobs::from_env()?;
    let mode = args.mode.unwrap_or(if knobs.general_mode { Mode::General } else { Mode::Piano });
    let unsupported = knobs.unsupported_for(mode, args.skip_separation);
    if !unsupported.is_empty() {
        bail!("not supported by the Rust engine: {} (use the Python engine for this job)", unsupported.join(", "));
    }
    let src = std::path::absolute(&args.input).unwrap_or(args.input.clone());
    if !src.is_file() {
        say!("File not found: {}", src.display());
        bail!("input not found");
    }
    let out = match &args.output {
        Some(o) => std::path::absolute(o).unwrap_or(o.clone()),
        None if mode == Mode::Melody => {
            let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            src.with_file_name(format!("{stem}_melody.mid"))
        }
        None if mode == Mode::Expressive => src.with_file_name(format!("{} - Medley.mid", file_stem(&src))),
        None => src.with_extension("mid"),
    };
    match mode {
        Mode::Expressive => expressive::run(args, &knobs, &src, &out),
        Mode::Fast => fast(args, &knobs, &src, &out),
        Mode::Melody => melody(args, &knobs, &src, &out),
        Mode::Drums => drums(args, &knobs, &src, &out),
        _ if args.skip_separation => transcribe_only(args, &knobs, &src, &out),
        _ => song_to_midi(args, &knobs, &src, &out, mode),
    }
}

/// transcribe.py: time range, loudness normalisation, Transkun, clean_midi.
fn transcribe_only(args: &Args, knobs: &Knobs, src: &Path, out: &Path) -> Result<()> {
    let t_all = Instant::now();
    let rt = start_runtime(args)?;
    let tk_ep = if args.transkun_gpu { rt.plan.ep } else { Ep::Cpu };
    match (tk_ep, &rt.device) {
        (Ep::Cuda { .. }, Some((name, _))) => say!("Backend: cuda ({name})"),
        (Ep::Cuda { .. }, None) => say!("Backend: cuda"),
        _ => say!("Backend: cpu"),
    }
    say!("Engine: forge-rs, ONNX Runtime {} ({}), fp32{}", rt.version, rt.plan.dylib.display(), why_cpu_note(&rt.plan));
    let paths = transkun_assets(args.models.as_deref(), args.aux.as_deref())?;
    let a = audio::load(src)?;
    let (a, label) = apply_window(a, &knobs.start_raw, &knobs.end_raw)?;
    if let Some(l) = label {
        say!("{l}");
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let a = if knobs.loudness_norm {
        say!("Normalizing to {} dB RMS -> {stem}_norm.wav", py_float(knobs.normalize.target_rms_db));
        post::loudness_normalize(&a, &knobs.normalize)
    } else {
        a
    };
    say!("Transcribing with Transkun V2: {}", src.file_name().map(|s| s.to_string_lossy()).unwrap_or_default());
    let t0 = Instant::now();
    let tr = transcribe(&paths, &a, args, knobs, tk_ep)?;
    say!("  done in {:.1}s", t0.elapsed().as_secs_f64());
    // transcribe.clean_midi has no polyphony cap.
    let co = CleanOpts { max_polyphony: 0, ..knobs.clean.clone() };
    let (before, after) = clean_and_write(&tr.notes, out, &co)?;
    say!("MIDI cleanup: {before} -> {after} notes (dropped {}); velocity gamma {}", before - after, py_float(co.velocity_gamma));
    say!();
    say!("DONE. MIDI: {}", out.display());
    eprintln!("[timing] wall {:.2}s, transkun on {}", t_all.elapsed().as_secs_f64(), ep_name(tr.ep));
    eprintln!("[memcap] {}", crate::memlimit::peaks());
    Ok(())
}

fn why_cpu_note(plan: &OrtPlan) -> String {
    match plan.ep {
        Ep::Cuda { .. } => ", CUDA (TF32 off)".into(),
        Ep::Cpu if plan.why_cpu.is_empty() => ", CPU".into(),
        Ep::Cpu => format!(", CPU ({})", plan.why_cpu),
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn file_stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn say_device(rt: &Runtime) {
    match (rt.plan.ep, &rt.device) {
        (Ep::Cuda { .. }, Some((name, _))) => say!("Device: cuda ({name})"),
        (Ep::Cuda { .. }, None) => say!("Device: cuda"),
        _ => say!("Device: cpu"),
    }
}

fn say_engine(rt: &Runtime) {
    say!("Engine: forge-rs, ONNX Runtime {} ({}), fp32{}", rt.version, rt.plan.dylib.display(), why_cpu_note(&rt.plan));
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let p = dir.join(name);
    if p.is_file() {
        return Some(p);
    }
    std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| find_file(&e.path(), name))
}

struct Separated {
    stems: crate::demix::Stems,
    ep: Ep,
    secs: f64,
    chunks: usize,
}

/// song_to_midi.run_separation (MSST BS-Rofo-SW-Fixed), with its lines:
/// "[1/3] Separating ...", "separation done in". Writes the six stems under
/// `work` only with FORGE_KEEP_STEMS=1.
fn run_separation(args: &Args, knobs: &Knobs, rt: &Runtime, rofo_path: &Path, a: &Audio, work: &Path, name: &str) -> Result<Separated> {
    let batch = knobs.separation_batch.unwrap_or_else(|| match (rt.plan.ep, &rt.device) {
        (Ep::Cuda { .. }, Some((_, total))) if *total > 0 => ortenv::separation_batch_for_vram(*total),
        _ => 1,
    });
    say!();
    if args.mode == Some(Mode::Expressive) {
        say!("[2/6] Separate vocals and backing with BS-Rofo-SW-Fixed (6 stems, batch {batch})");
    } else {
        say!("[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem, batch {batch})");
    }
    let t_sep = Instant::now();
    // FORGE_RS_STEMS_DIR=<dir holding <instr>.wav>: parity diagnostics only,
    // take MSST's own stems instead of separating.
    if let Some(dir) = env_file("FORGE_RS_STEMS_DIR") {
        let mut stems = Vec::new();
        for name in INSTRUMENTS {
            let a = audio::load(&find_file(&dir, &format!("{name}.wav")).ok_or_else(|| anyhow!("{name}.wav not in {}", dir.display()))?)?;
            stems.push(planar(&a));
        }
        say!("  separation done in 0.0s (stems from {})", dir.display());
        return Ok(Separated { stems, ep: rt.plan.ep, secs: 0.0, chunks: 0 });
    }
    let cache = ModelCache::from_env();
    let t0 = Instant::now();
    let (mut rofo, used) = match load_roformer(rofo_path, args, rt.plan.ep, cache.as_ref()) {
        Ok(r) => r,
        Err(e) if rt.plan.ep != Ep::Cpu && args.ep == EpChoice::Auto => {
            say!("  CUDA session failed ({e:#}); separating on the CPU");
            load_roformer(rofo_path, args, Ep::Cpu, cache.as_ref())?
        }
        Err(e) => return Err(e),
    };
    let ep = rofo.ep;
    say!("  separator ready in {:.1}s on {} (fp32, model cache {used})", t0.elapsed().as_secs_f64(), ep_name(ep));
    let mix = separate::prepare_mix(a)?;
    let mut p = DemixParams::bs_rofo_sw();
    p.batch_size = batch;
    let (stems, chunks) = separate::separate_mix_with(&mut rofo, &mix, &p, |done, total| say!("SSEG|{done}|{total}"))?;
    drop(rofo);
    drop(mix);
    let secs = t_sep.elapsed().as_secs_f64();
    say!("  separation done in {secs:.1}s");
    if knobs.keep_stems {
        separate::write_stems(&work.join("stems"), name, &stems)?;
    }
    Ok(Separated { stems, ep, secs, chunks })
}

/// song_to_midi.py with the msst backend.
fn song_to_midi(args: &Args, knobs: &Knobs, src: &Path, out: &Path, mode: Mode) -> Result<()> {
    let t_all = Instant::now();
    let rt = start_runtime(args)?;
    say_device(&rt);
    say!("Input: {}", file_name(src));
    say_engine(&rt);
    // Resolve every model before the long part starts.
    let rofo_path = roformer_model(args.models.as_deref(), args.rofo_model.as_deref())?;
    let tk_paths = transkun_assets(args.models.as_deref(), args.aux.as_deref())?;

    let work = work_root(src, "");
    let a = audio::load(src)?;
    let (a, label) = apply_window(a, &knobs.start_raw, &knobs.end_raw)?;
    if let Some(l) = label {
        say!("{l}");
    }
    if mode == Mode::General {
        say!("Mode: General (mixing all pitched stems, not just piano)");
    }
    let name = safe_name(&file_stem(src));
    let sep = run_separation(args, knobs, &rt, &rofo_path, &a, &work, &name)?;
    drop(a);
    let stem_dir = work.join("stems").join(&name);
    let stems = sep.stems;

    let (stem, stem_path) = match mode {
        Mode::General => {
            let mut excl: Vec<&str> = knobs.exclude_stems.iter().map(String::as_str).collect();
            if knobs.exclude_vocals {
                excl.push("vocal");
            }
            let picked = separate::pitched_stems(&excl);
            let names: Vec<&str> = picked.iter().map(|&i| INSTRUMENTS[i]).collect();
            say!("  mixing {} pitched stem(s): {}", picked.len(), names.join(", "));
            let m = separate::mix_pitched(&stems, &excl);
            // sf.write(general_mix.wav, mix, sr): PCM_16.
            let f = stereo_audio(&m, SourceKind::Float);
            (post::as_pcm16(&f, &f.samples), work.join("general_mix.wav"))
        }
        _ => {
            let i = INSTRUMENTS.iter().position(|n| *n == "piano").expect("piano stem");
            say!("  using piano stem -> piano.wav");
            (stereo_audio(&stems[i], SourceKind::Float), stem_dir.join("piano.wav"))
        }
    };
    drop(stems);
    let stem = if knobs.loudness_norm {
        say!(
            "    Normalizing stem to {} dB RMS (peak ceiling {} dB)",
            py_float(knobs.normalize.target_rms_db),
            py_float(knobs.normalize.peak_ceiling_db)
        );
        post::normalize_in_place(&stem, &knobs.normalize)
    } else {
        stem
    };
    if knobs.keep_stems {
        write_stem_wav(&stem_path, &stem)?;
    }

    // [2/3] transcription
    let tk_ep = if args.transkun_gpu { sep.ep } else { Ep::Cpu };
    say!();
    say!("[2/3] Transcribing with Transkun V2 (SOTA piano MIDI), {}", ep_name(tk_ep));
    let t0 = Instant::now();
    let tr = transcribe(&tk_paths, &stem, args, knobs, tk_ep)?;
    let tk_s = t0.elapsed().as_secs_f64();
    say!("  done in {tk_s:.1}s");

    // [3/3] cleanup
    let co = &knobs.clean;
    say!();
    say!(
        "[3/3] Cleaning MIDI (drop notes < {}s or velocity < {}{}); velocity gamma {}",
        co.min_note_sec,
        co.min_velocity,
        if co.max_polyphony > 0 { format!(", cap {} simultaneous", co.max_polyphony) } else { String::new() },
        py_float(co.velocity_gamma)
    );
    let (before, after) = clean_and_write(&tr.notes, out, co)?;
    say!("  {before} -> {after} notes (dropped {})", before - after);
    if mode == Mode::Piano && args.sparse_recovery {
        recover_sparse_piano(args, &stem, &stem_path, out, after);
    }

    say!();
    say!("DONE.");
    say!("  Stem: {}", stem_path.display());
    say!("  MIDI:       {}", out.display());
    cleanup_work(&work, knobs.keep_stems);
    eprintln!(
        "[timing] wall {:.2}s: stems {:.2}s ({} chunks, {}), transkun {tk_s:.2}s ({})",
        t_all.elapsed().as_secs_f64(),
        sep.secs,
        sep.chunks,
        ep_name(sep.ep),
        ep_name(tr.ep)
    );
    eprintln!("[memcap] {}", crate::memlimit::peaks());
    Ok(())
}

/// song_to_midi.recover_sparse_piano: when Transkun clearly under-reads the
/// piano stem, run stem_to_midi.py's basic-pitch pass on it (in process) and
/// keep that only if it finds far more. Its lines are printed behind
/// "  basic-pitch: ", so its own "DONE. MIDI:" line is not this job's DONE.
fn recover_sparse_piano(args: &Args, stem: &Audio, stem_path: &Path, out: &Path, note_count: usize) -> usize {
    let duration = stem.frames() as f64 / stem.sample_rate as f64;
    let sparse_limit = 24usize.max((duration * 0.8) as usize);
    if note_count >= sparse_limit {
        return note_count;
    }
    say!("  Transkun result is sparse ({note_count} notes / {duration:.1}s); checking the broad recognizer...");
    let fallback = stem_path.with_file_name("fallback_basic_pitch.mid");
    let result = (|| -> Result<usize> {
        let o = crate::stemmidi::StemOpts::from_env()?;
        let mut model = crate::basicpitch::Model::load(&bp_model_path(args)?, args.threads)?;
        let mut tell = |l: String| say!("  basic-pitch: {l}");
        for l in crate::stemmidi::banner(&o, &file_name(stem_path), &file_name(&fallback)) {
            tell(l);
        }
        let r = crate::stemmidi::run(&mut model, stem, &o, stem_path, stem_path, &mut tell)?;
        tell(format!("DONE. MIDI: {}", fallback.display()));
        let candidate = crate::pmidi::PrettyMidi::from_bytes(&r.bytes)?.note_count();
        let richer = (note_count * 2).max((duration * 1.2) as usize);
        if candidate >= richer {
            std::fs::write(out, &r.bytes).with_context(|| format!("write {}", out.display()))?;
            say!("  Recovery selected: {candidate} notes instead of {note_count}");
            return Ok(candidate);
        }
        say!("  Broad recognizer found {candidate} notes; keeping cleaner Transkun output");
        Ok(note_count)
    })();
    match result {
        Ok(n) => n,
        Err(e) => {
            say!("  [warn] broad-recognizer check failed ({e:#}); keeping Transkun output");
            note_count
        }
    }
}

fn basic_pitch_model(args: &Args) -> Result<crate::basicpitch::Model> {
    let p = bp_model_path(args)?;
    crate::basicpitch::Model::load(&p, args.threads)
}

/// stem_to_midi.py: the app's Fast mode. basic-pitch runs on the CPU EP
/// only, so this loads the CPU build of ONNX Runtime.
fn fast(args: &Args, knobs: &Knobs, src: &Path, out: &Path) -> Result<()> {
    let t_all = Instant::now();
    let o = crate::stemmidi::StemOpts::from_env()?;
    let rt = start_runtime_with(args, EpChoice::Cpu)?;
    let mut model = basic_pitch_model(args)?;
    let a = audio::load(src)?;
    let (a, label) = apply_window(a, &knobs.start_raw, &knobs.end_raw)?;
    let process_src = match &label {
        Some(_) => {
            let tag = window_tag(&knobs.start_raw, &knobs.end_raw);
            src.parent().unwrap_or(Path::new(".")).join("stems").join(file_stem(src)).join(format!("{}{tag}.wav", file_stem(src)))
        }
        None => src.to_path_buf(),
    };
    if let Some(l) = label {
        say!("{l}");
    }
    for l in crate::stemmidi::banner(&o, &file_name(src), &file_name(out)) {
        say!("{l}");
    }
    say_engine(&rt);
    let r = crate::stemmidi::run(&mut model, &a, &o, src, &process_src, &mut |l| say!("{l}"))?;
    if let Some(d) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(out, &r.bytes).with_context(|| format!("write {}", out.display()))?;
    say!();
    say!("DONE. MIDI: {}", out.display());
    eprintln!("[timing] wall {:.2}s, basic-pitch {:.2}s", t_all.elapsed().as_secs_f64(), r.predict_s);
    eprintln!("[memcap] {}", crate::memlimit::peaks());
    Ok(())
}

/// audio_window_from_env's clip name tag: `_range_<start>_<stop>` with the
/// dots as "p".
fn window_tag(start_raw: &str, end_raw: &str) -> String {
    let start = start_raw.parse::<f64>().unwrap_or(0.0).max(0.0);
    let end = end_raw.parse::<f64>().unwrap_or(0.0);
    let stop = if end > start { format!("{end:.3}") } else { "end".into() };
    format!("_range_{start:.3}_{stop}").replace('.', "p")
}

fn planar(a: &Audio) -> Vec<Vec<f32>> {
    (0..a.channels).map(|c| a.samples.iter().skip(c).step_by(a.channels).copied().collect()).collect()
}

/// melody_to_midi.py
fn melody(args: &Args, knobs: &Knobs, src: &Path, out: &Path) -> Result<()> {
    let t_all = Instant::now();
    let env_i = |k: &str, d: i64| env_i64(k, d);
    let mo = crate::melody::MelodyOpts {
        min_pitch: env_i("MELODY_MIN_PITCH", 45)?,
        max_pitch: env_i("MELODY_MAX_PITCH", 100)?,
        fold: env_flag("MELODY_FOLD", true),
        density: env_f64("MELODY_DENSITY", 13.0)?,
        onset: env_f64("MELODY_ONSET_THRESHOLD", 0.42)?,
        frame: env_f64("MELODY_FRAME_THRESHOLD", 0.28)?,
        min_note_ms: env_i("MELODY_MIN_NOTE_MS", 30)?,
        strict_fifths: env_flag("MELODY_STRICT_FIFTHS", true),
    };
    let separates = Mode::Melody.separates(args.skip_separation);
    let rt = start_runtime_with(args, if separates { args.ep } else { EpChoice::Cpu })?;
    let rofo_path = if separates { Some(roformer_model(args.models.as_deref(), args.rofo_model.as_deref())?) } else { None };
    let mut model = basic_pitch_model(args)?;
    let work = work_root(src, "_melody");
    let a = audio::load(src)?;
    let (a, label) = apply_window(a, &knobs.start_raw, &knobs.end_raw)?;
    if let Some(l) = label {
        say!("{l}");
    }
    say!("Input: {}", file_name(src));
    say_engine(&rt);
    say!();
    say!("[1/4] Isolating pitched lead material");
    let (lead, sr): (Vec<Vec<f32>>, u32) = match &rofo_path {
        None => {
            say!("  using isolated input directly");
            (planar(&a), a.sample_rate)
        }
        Some(rp) => {
            let name = safe_name(&file_stem(src));
            let sep = run_separation(args, knobs, &rt, rp, &a, &work, &name)?;
            // sorted(*.wav) minus drums / bass / vocals, summed in that order
            let mut order: Vec<usize> = (0..INSTRUMENTS.len()).collect();
            order.sort_by_key(|&i| INSTRUMENTS[i]);
            let excluded = |l: &str| matches!(l, "drums" | "drum" | "percussion" | "bass" | "vocals" | "vocal");
            let mut picked: Vec<usize> = order.iter().copied().filter(|&i| !excluded(&crate::melody::stem_label(INSTRUMENTS[i]))).collect();
            if picked.is_empty() {
                picked = order.iter().copied().filter(|&i| !matches!(crate::melody::stem_label(INSTRUMENTS[i]).as_str(), "drums" | "drum" | "percussion" | "bass")).collect();
            }
            if picked.is_empty() {
                bail!("Separation produced no pitched lead stems.");
            }
            let labels: Vec<String> = picked.iter().map(|&i| crate::melody::stem_label(INSTRUMENTS[i])).collect();
            say!("  lead stems: {}", labels.join(", "));
            let mut mix = sep.stems[picked[0]].clone();
            for &i in &picked[1..] {
                for (m, p) in mix.iter_mut().zip(&sep.stems[i]) {
                    for (x, &y) in m.iter_mut().zip(p) {
                        *x += y;
                    }
                }
            }
            (mix, SAMPLE_RATE)
        }
    };
    drop(a);
    let filtered = crate::melody::highpass_and_limit(&lead, sr, mo.min_pitch).map_err(|e| anyhow!(e))?;
    drop(lead);
    // melody_mix.wav (PCM_16), then load_normalize_save(-18 dB) -> melody_norm.wav
    let mix = Audio { sample_rate: sr, channels: filtered.len(), samples: separate::interleave(&filtered), kind: SourceKind::Float };
    let mix = post::as_pcm16(&mix, &mix.samples);
    if knobs.keep_stems {
        write_stem_wav(&work.join("melody_mix.wav"), &mix)?;
    }
    let norm = post::loudness_normalize(&mix, &NormalizeOpts { target_rms_db: -18.0, peak_ceiling_db: -1.0 });
    if knobs.keep_stems {
        write_stem_wav(&work.join("melody_norm.wav"), &norm)?;
    }
    say!();
    say!("[2/4] Detecting instrument-agnostic pitches");
    let started = Instant::now();
    say!("Predicting MIDI for {}...", work.join("melody_norm.wav").display());
    let (norm, ratio) = match crate::tuning::retune(&norm)? {
        Some((cents, Some(t))) => {
            say!("  tuning {:+.0} cents from A440, retuned for transcription", cents);
            t
        }
        Some((cents, None)) => {
            say!("  tuning {:+.0} cents from A440, close enough", cents);
            (norm, 1.0)
        }
        None => (norm, 1.0),
    };
    let y = crate::basicpitch::load_mono(&norm, crate::basicpitch::SAMPLE_RATE)?;
    drop(norm);
    let params = crate::basicpitch::Params {
        onset_threshold: mo.onset,
        frame_threshold: mo.frame,
        minimum_note_length: mo.min_note_ms as f64,
        minimum_frequency: Some(crate::basicpitch::midi_to_hz(mo.min_pitch as f64)),
        maximum_frequency: Some(crate::basicpitch::midi_to_hz(mo.max_pitch as f64)),
        melodia_trick: true,
        midi_tempo: 120.0,
    };
    let mut raw = crate::basicpitch::predict(&mut model, &y, &params)?;
    if ratio != 1.0 {
        crate::tuning::scale_times(&mut raw, ratio);
    }
    let raw_bytes = raw.to_bytes()?;
    if knobs.keep_stems {
        std::fs::create_dir_all(&work)?;
        std::fs::write(work.join("melody_raw.mid"), &raw_bytes)?;
    }
    let bp_s = started.elapsed().as_secs_f64();
    say!("  detected in {bp_s:.1}s");
    say!();
    say!("[3/4] Building Clean, Balanced, and Detailed candidates");
    let raw = crate::pmidi::PrettyMidi::from_bytes(&raw_bytes)?;
    let (_, cands) = crate::melody::build_candidates(&raw, &mo, &mut |l| say!("{l}")).map_err(|e| anyhow!(e))?;
    let stem = file_stem(out);
    let mut paths = std::collections::BTreeMap::new();
    let mut counts = std::collections::BTreeMap::new();
    for c in &cands {
        let p = if c.name == "clean" { out.to_path_buf() } else { out.with_file_name(format!("{stem}_{}.mid", c.name)) };
        c.midi.write(&p)?;
        paths.insert(c.name, p.to_string_lossy().into_owned());
        counts.insert(c.name, c.count);
    }
    say!();
    say!("[4/4] Preparing review project");
    say!("RESULT|{}", crate::melody::result_json(&out.to_string_lossy(), &paths, &counts, &src.to_string_lossy()));
    say!("DONE.");
    cleanup_work(&work, knobs.keep_stems);
    eprintln!("[timing] wall {:.2}s, basic-pitch {bp_s:.2}s", t_all.elapsed().as_secs_f64());
    eprintln!("[memcap] {}", crate::memlimit::peaks());
    Ok(())
}

/// drums_to_midi.py
fn drums(args: &Args, knobs: &Knobs, src: &Path, out: &Path) -> Result<()> {
    let t_all = Instant::now();
    let onset_delta = env_f64("ONSET_DELTA", 0.07)?;
    let min_gap_ms = env_i64("DRUM_MIN_GAP_MS", 50)?;
    let separates = Mode::Drums.separates(args.skip_separation);
    let rt = if separates { Some(start_runtime(args)?) } else { None };
    let rofo_path = if separates { Some(roformer_model(args.models.as_deref(), args.rofo_model.as_deref())?) } else { None };
    say!("Input: {}", file_name(src));
    if let Some(rt) = &rt {
        say_engine(rt);
    }
    let a = audio::load(src)?;
    let (a, label) = apply_window(a, &knobs.start_raw, &knobs.end_raw)?;
    if let Some(l) = label {
        say!("{l}");
    }
    let work = work_root(src, "_drums");
    let (drum, drum_path) = match (&rt, &rofo_path) {
        (Some(rt), Some(rp)) => {
            let name = safe_name(&file_stem(src));
            let sep = run_separation(args, knobs, rt, rp, &a, &work, &name)?;
            let i = INSTRUMENTS.iter().position(|n| *n == "drums").expect("drums stem");
            say!("  using drum stem -> drums.wav");
            (stereo_audio(&sep.stems[i], SourceKind::Float), src.parent().unwrap_or(Path::new(".")).join("stems").join(&name).join("stems").join(&name).join("drums.wav"))
        }
        _ => {
            say!();
            say!("[1/3] Separation skipped (input is already a drum stem)");
            (a.clone(), src.to_path_buf())
        }
    };
    drop(a);
    say!();
    say!("[2/3] Transcribing drums (onset + band classification, delta={})", py_float(onset_delta));
    let t0 = Instant::now();
    let y = crate::basicpitch::load_mono(&drum, 22050)?;
    drop(drum);
    let hits = crate::drums::classify_hits(&y, onset_delta, min_gap_ms);
    let dt = t0.elapsed().as_secs_f64();
    say!("  {} hits in {dt:.1}s, {}", hits.len(), crate::drums::summary(&hits));
    say!();
    say!("[3/3] Cleaning MIDI (writing drum track)");
    crate::drums::hits_to_midi(&hits).write(out)?;
    say!();
    say!("DONE.");
    say!("  Stem: {}", drum_path.display());
    say!("  MIDI:       {}", out.display());
    cleanup_work(&work, knobs.keep_stems);
    eprintln!("[timing] wall {:.2}s, drums {dt:.2}s", t_all.elapsed().as_secs_f64());
    eprintln!("[memcap] {}", crate::memlimit::peaks());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names_match_python() {
        assert_eq!(safe_name("Song [Official] (Live)"), "Song _Official_ _Live");
        assert_eq!(safe_name("  a   b. "), "a b");
        assert_eq!(safe_name("***"), "audio");
        assert_eq!(py_float(-20.0), "-20.0");
        assert_eq!(py_float(0.85), "0.85");
    }

    #[test]
    fn window_trims_like_librosa_and_quantises() {
        let a = Audio { sample_rate: 10, channels: 2, samples: (0..40).map(|i| i as f32 / 64.0 + 1e-6).collect(), kind: SourceKind::Float };
        let (w, l) = apply_window(a.clone(), "0.5", "1.2").unwrap();
        assert_eq!(w.frames(), 7);
        assert_eq!(w.kind, SourceKind::Int(16));
        assert_eq!(w.samples[0], 10.0 / 64.0, "frame 5, channel 0, quantised to 16 bits");
        assert_eq!(l.as_deref(), Some("Time range: 0.500s -> 1.200s"));
        let (w, l) = apply_window(a.clone(), "", "").unwrap();
        assert_eq!((w.frames(), l), (20, None));
        let (w, _) = apply_window(a.clone(), "0", "0").unwrap();
        assert_eq!(w.kind, SourceKind::Float, "start 0 and no end: the file is used as is");
        let (w, l) = apply_window(a.clone(), "1.5", "1").unwrap();
        assert_eq!((w.frames(), l.as_deref()), (5, Some("Time range: 1.500s -> end")));
        assert!(apply_window(a, "9", "").is_err());
    }

    #[test]
    fn unsupported_knobs_are_named() {
        let mut k = Knobs::from_env().unwrap();
        k.use_tta = true;
        k.bigshifts = 3;
        k.segment_size = Some("16".into());
        k.separation_backend = "onnx_dml".into();
        let u = k.unsupported();
        assert_eq!(u.len(), 3, "{u:?}");
        k.segment_size = Some("12".into());
        assert_eq!(k.unsupported().len(), 4);
    }
}
