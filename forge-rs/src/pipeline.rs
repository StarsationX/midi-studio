//! `forge-rs pipeline`: python-engine/song_to_midi.py (and, with
//! `--skip-separation`, transcribe.py) for the modes forge-rs covers end to
//! end: piano and general.
//!
//! Same inputs (`<audio> [<out.mid>]`), the same environment knobs, the same
//! output file, and the same stdout lines the app's runner parses: `[1/3]`
//! `[2/3]` `[3/3]` stage markers, `TSEG|done|total` after every Transkun
//! segment, `SSEG|done|total` after every separation chunk, `DONE.`. The
//! intermediate WAV files song_to_midi writes are reproduced in memory with
//! their exact sample formats (time-range clip and normalised stem as
//! soundfile PCM_16, MSST stems as float), so nothing touches disk unless
//! FORGE_KEEP_STEMS=1 or the sparse-piano check needs Python's basic-pitch.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Piano,
    General,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "piano" => Ok(Mode::Piano),
            "general" => Ok(Mode::General),
            o => bail!("mode {o} is not covered by forge-rs (piano and general are; melody, drums, fast and stems need the Python engine)"),
        }
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
        let mut v = Vec::new();
        if self.use_tta {
            v.push("USE_TTA=1 (test-time augmentation)".into());
        }
        if self.bigshifts > 1 {
            v.push(format!("BIGSHIFTS={}", self.bigshifts));
        }
        if let Some(s) = &self.segment_size {
            if s.trim().parse::<f64>().ok() != Some(16.0) {
                v.push(format!("SEGMENT_SIZE={s} (Transkun runs 16 s segments)"));
            }
        }
        if self.separation_backend == "onnx_dml" {
            v.push("SEPARATION_BACKEND=onnx_dml (MDX-Net on DirectML)".into());
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
    /// For song_to_midi's sparse-piano check (basic-pitch via stem_to_midi.py).
    pub python: Option<PathBuf>,
    pub engine_dir: Option<PathBuf>,
    pub sparse_recovery: bool,
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
        }
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

/// Transkun ONNX + aux: --models / MIDI_STUDIO_MODELS_DIR for the ONNX;
/// --aux, FORGE_RS_AUX, next to the ONNX, then the forge-rs assets folder.
pub fn transkun_assets(models: Option<&Path>, aux: Option<&Path>) -> Result<AssetPaths> {
    let explicit = aux.map(Path::to_path_buf).or_else(|| env_file("FORGE_RS_AUX"));
    match AssetPaths::resolve(models, explicit.as_deref()) {
        Ok(p) => Ok(p),
        Err(e) if explicit.is_none() => match exe_assets(AUX_NAME).into_iter().find(|p| p.is_file()) {
            Some(a) => AssetPaths::resolve(models, Some(&a)),
            None => Err(e),
        },
        Err(e) => Err(e),
    }
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
/// routing a job here.
pub fn probe(args: &Args) -> serde_json::Value {
    let plan = ortenv::plan(args.ep, args.ort_dylib.as_deref(), args.cuda_dir.as_deref());
    let tk = transkun_assets(args.models.as_deref(), args.aux.as_deref());
    let rofo = roformer_model(args.models.as_deref(), args.rofo_model.as_deref());
    let p = |r: &Result<PathBuf>| r.as_ref().map_or(serde_json::Value::Null, |p| json!(p.to_string_lossy()));
    let mut missing = Vec::new();
    if let Err(e) = &tk {
        missing.push(format!("transkun: {e:#}"));
    }
    if let Err(e) = &rofo {
        missing.push(format!("roformer: {e:#}"));
    }
    if let Err(e) = &plan {
        missing.push(format!("onnxruntime: {e:#}"));
    }
    json!({
        "ready": missing.is_empty(),
        "modes": ["piano", "general"],
        "ep": plan.as_ref().map_or("none", |p| if p.ep == Ep::Cpu { "cpu" } else { "cuda" }),
        "whyCpu": plan.as_ref().map_or(String::new(), |p| p.why_cpu.clone()),
        "ort": plan.as_ref().map_or(serde_json::Value::Null, |p| json!(p.dylib.to_string_lossy())),
        "cudaDir": plan.as_ref().ok().and_then(|p| p.cuda_dir.as_ref()).map_or(serde_json::Value::Null, |d| json!(d.to_string_lossy())),
        "transkun": p(&tk.as_ref().map(|a| a.onnx.clone()).map_err(|e| anyhow!("{e:#}"))),
        "aux": p(&tk.as_ref().map(|a| a.aux.clone()).map_err(|e| anyhow!("{e:#}"))),
        "roformer": p(&rofo),
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

/// song_to_midi.work_root: `<forge env>\work\<name>-<tag>`, or
/// `<song dir>\stems\...` outside the app. Created only when needed.
fn work_root(src: &Path) -> PathBuf {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(src.to_string_lossy().as_bytes());
    let tag = format!("{:016x}", h.finish());
    let root = match env_file("MIDI_STUDIO_FORGE_ENV_DIR") {
        Some(b) => b.join("work"),
        None => src.parent().unwrap_or(Path::new(".")).join("stems"),
    };
    root.join(format!("{}-{}", safe_name(&stem), &tag[..8]))
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

/// Run a helper with its output re-emitted line by line behind `prefix`.
/// stem_to_midi.py ends with its own "DONE. MIDI: ..." line; passed through
/// as is (song_to_midi.py does exactly that), the app's runner takes it for
/// this job's DONE, finishes the job early and moves the MIDI away before the
/// recovered one is copied in. Prefixed, it is just a log line. Returns
/// whether the helper exited 0.
fn run_prefixed(cmd: &mut std::process::Command, prefix: &str) -> bool {
    use std::io::Read;
    let child = cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn();
    let Ok(mut child) = child else { return false };
    let pump = |r: Option<Box<dyn Read + Send>>, prefix: String| {
        std::thread::spawn(move || {
            let Some(mut r) = r else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let emit = |b: &[u8]| {
                let l = String::from_utf8_lossy(b);
                let l = l.trim();
                if !l.is_empty() {
                    say!("{prefix}{l}");
                }
            };
            while let Ok(n) = r.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                while let Some(i) = buf.iter().position(|&c| c == b'\n' || c == b'\r') {
                    emit(&buf[..i]);
                    buf.drain(..=i);
                }
            }
            emit(&buf);
        })
    };
    let out = pump(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), prefix.to_string());
    let err = pump(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), prefix.to_string());
    let ok = child.wait().is_ok_and(|s| s.success());
    let _ = out.join();
    let _ = err.join();
    ok
}

/// Notes in a MIDI file, as pretty_midi counts them (note-on/off pairs).
fn count_midi_notes(path: &Path) -> Result<usize> {
    let bytes = std::fs::read(path)?;
    let smf = midly::Smf::parse(&bytes).map_err(|e| anyhow!("{e}"))?;
    let mut n = 0usize;
    for track in &smf.tracks {
        for ev in track {
            if let midly::TrackEventKind::Midi { message: midly::MidiMessage::NoteOn { vel, .. }, .. } = ev.kind {
                if vel.as_int() > 0 {
                    n += 1;
                }
            }
        }
    }
    Ok(n)
}

// ---- runtime ---------------------------------------------------------------------

struct Runtime {
    plan: OrtPlan,
    version: String,
    device: Option<(String, u64)>,
}

fn start_runtime(args: &Args) -> Result<Runtime> {
    let plan = ortenv::plan(args.ep, args.ort_dylib.as_deref(), args.cuda_dir.as_deref())?;
    if let Some(d) = &plan.cuda_dir {
        ortenv::prepend_path(d)?;
    }
    crate::backbone::init_ort(Some(&plan.dylib))?;
    let version = ortenv::loaded_version().map_or("?".into(), |(a, b)| format!("{a}.{b}"));
    let device = plan.cuda_dir.as_deref().and_then(ortenv::cuda_device_info);
    Ok(Runtime { plan, version, device })
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
    let (notes, t) = tr.transcribe_audio(a, &opts, &Dump::none())?;
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
    let unsupported = knobs.unsupported();
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
        None => src.with_extension("mid"),
    };
    if args.skip_separation {
        transcribe_only(args, &knobs, &src, &out)
    } else {
        song_to_midi(args, &knobs, &src, &out)
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

/// song_to_midi.py with the msst backend.
fn song_to_midi(args: &Args, knobs: &Knobs, src: &Path, out: &Path) -> Result<()> {
    let t_all = Instant::now();
    let mode = args.mode.unwrap_or(if knobs.general_mode { Mode::General } else { Mode::Piano });
    let rt = start_runtime(args)?;
    match (rt.plan.ep, &rt.device) {
        (Ep::Cuda { .. }, Some((name, _))) => say!("Device: cuda ({name})"),
        (Ep::Cuda { .. }, None) => say!("Device: cuda"),
        _ => say!("Device: cpu"),
    }
    say!("Input: {}", src.file_name().map(|s| s.to_string_lossy()).unwrap_or_default());
    say!("Engine: forge-rs, ONNX Runtime {} ({}), fp32{}", rt.version, rt.plan.dylib.display(), why_cpu_note(&rt.plan));
    // Resolve every model before the long part starts.
    let rofo_path = roformer_model(args.models.as_deref(), args.rofo_model.as_deref())?;
    let tk_paths = transkun_assets(args.models.as_deref(), args.aux.as_deref())?;

    let work = work_root(src);
    let a = audio::load(src)?;
    let (a, label) = apply_window(a, &knobs.start_raw, &knobs.end_raw)?;
    if let Some(l) = label {
        say!("{l}");
    }
    if mode == Mode::General {
        say!("Mode: General (mixing all pitched stems, not just piano)");
    }
    let batch = knobs.separation_batch.unwrap_or_else(|| match (rt.plan.ep, &rt.device) {
        (Ep::Cuda { .. }, Some((_, total))) if *total > 0 => ortenv::separation_batch_for_vram(*total),
        _ => 1,
    });

    // [1/3] separation
    say!();
    say!("[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem, batch {batch})");
    let t_sep = Instant::now();
    let cache = ModelCache::from_env();
    let t0 = Instant::now();
    let (mut rofo, used) = match load_roformer(&rofo_path, args, rt.plan.ep, cache.as_ref()) {
        Ok(r) => r,
        Err(e) if rt.plan.ep != Ep::Cpu && args.ep == EpChoice::Auto => {
            say!("  CUDA session failed ({e:#}); separating on the CPU");
            load_roformer(&rofo_path, args, Ep::Cpu, cache.as_ref())?
        }
        Err(e) => return Err(e),
    };
    let sep_ep = rofo.ep;
    say!("  separator ready in {:.1}s on {} (fp32, model cache {used})", t0.elapsed().as_secs_f64(), ep_name(sep_ep));
    let mix = separate::prepare_mix(&a)?;
    drop(a);
    let mut p = DemixParams::bs_rofo_sw();
    p.batch_size = batch;
    let (stems, chunks) = separate::separate_mix_with(&mut rofo, &mix, &p, |done, total| say!("SSEG|{done}|{total}"))?;
    drop(rofo);
    drop(mix);
    let sep_s = t_sep.elapsed().as_secs_f64();
    say!("  separation done in {sep_s:.1}s");
    let name = safe_name(&src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
    let stem_dir = work.join("stems").join(&name);
    if knobs.keep_stems {
        separate::write_stems(&work.join("stems"), &name, &stems)?;
    }

    let (stem, stem_path) = match mode {
        Mode::Piano => {
            let i = INSTRUMENTS.iter().position(|n| *n == "piano").expect("piano stem");
            say!("  using piano stem -> piano.wav");
            (stereo_audio(&stems[i], SourceKind::Float), stem_dir.join("piano.wav"))
        }
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
    let tk_ep = if args.transkun_gpu { sep_ep } else { Ep::Cpu };
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
    let (before, mut after) = clean_and_write(&tr.notes, out, co)?;
    say!("  {before} -> {after} notes (dropped {})", before - after);
    if mode == Mode::Piano && args.sparse_recovery {
        after = recover_sparse_piano(args, &stem, &stem_path, out, after, &work)?;
    }
    let _ = after;

    say!();
    say!("DONE.");
    say!("  Stem: {}", stem_path.display());
    say!("  MIDI:       {}", out.display());
    if knobs.keep_stems {
        say!("  (kept stems: {})", work.display());
    } else if work.exists() {
        let _ = std::fs::remove_dir_all(&work);
    }
    eprintln!(
        "[timing] wall {:.2}s: stems {sep_s:.2}s ({chunks} chunks, {}), transkun {tk_s:.2}s ({})",
        t_all.elapsed().as_secs_f64(),
        ep_name(sep_ep),
        ep_name(tr.ep)
    );
    eprintln!("[memcap] {}", crate::memlimit::peaks());
    Ok(())
}

/// song_to_midi.recover_sparse_piano: when Transkun clearly under-reads the
/// piano stem, try basic-pitch (stem_to_midi.py, Python) and keep it only if
/// it finds far more. Without the forge env's Python the Transkun result
/// stands.
fn recover_sparse_piano(args: &Args, stem: &Audio, stem_path: &Path, out: &Path, note_count: usize, work: &Path) -> Result<usize> {
    let duration = stem.frames() as f64 / stem.sample_rate as f64;
    let sparse_limit = 24usize.max((duration * 0.8) as usize);
    if note_count >= sparse_limit {
        return Ok(note_count);
    }
    say!("  Transkun result is sparse ({note_count} notes / {duration:.1}s); checking the broad recognizer...");
    let py = args.python.clone().or_else(|| ortenv::forge_env_dir().map(|f| f.join("python").join("python.exe"))).filter(|p| p.is_file());
    let script = args.engine_dir.clone().or_else(|| env_file("MIDI_STUDIO_ENGINE_DIR")).map(|d| d.join("stem_to_midi.py")).filter(|p| p.is_file());
    let (Some(py), Some(script)) = (py, script) else {
        say!("  [warn] broad-recognizer check needs the Forge Python engine; keeping Transkun output");
        return Ok(note_count);
    };
    let fallback = work.join("fallback_basic_pitch.mid");
    let result = (|| -> Result<usize> {
        write_stem_wav(stem_path, stem)?;
        let ok = run_prefixed(std::process::Command::new(&py).arg(&script).arg(stem_path).arg(&fallback), "  basic-pitch: ");
        if !ok || !fallback.is_file() {
            say!("  [warn] broad-recognizer check failed; keeping Transkun output");
            return Ok(note_count);
        }
        let candidate = count_midi_notes(&fallback)?;
        let richer = (note_count * 2).max((duration * 1.2) as usize);
        if candidate >= richer {
            std::fs::copy(&fallback, out)?;
            say!("  Recovery selected: {candidate} notes instead of {note_count}");
            return Ok(candidate);
        }
        say!("  Broad recognizer found {candidate} notes; keeping cleaner Transkun output");
        Ok(note_count)
    })();
    let _ = std::fs::remove_file(&fallback);
    match result {
        Ok(n) => Ok(n),
        Err(e) => {
            say!("  [warn] broad-recognizer check failed ({e:#}); keeping Transkun output");
            Ok(note_count)
        }
    }
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
