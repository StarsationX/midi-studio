// runner.rs: electron/forge-runner.js. The Midi Forge pipeline scripts as
// cancellable child jobs under the FORGE-ENV interpreter, streaming coarse,
// honest progress as forge:status payloads identical to Electron's.
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Map, Value};

use super::fpaths::{self, EnvMap, ForgePaths};
use super::winjob::{self, Job};
use crate::paths::engine_dir;

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// What a job needs to know about the app when it starts: settings.forgePaths()
/// plus main.js performanceSettings().
#[derive(Clone, Debug, Default)]
pub struct Ctx {
    pub paths: ForgePaths,
    pub perf: Value,
    /// settings.forge.engine: "rust" sends the modes forge-rs covers to it.
    pub forge_engine: String,
}
pub type GetCtx = Arc<dyn Fn() -> Ctx + Send + Sync>;

pub type Stage = (&'static str, &'static str, i64);
pub const STAGES_3: &[Stage] = &[("[1/3]", "Separate", 15), ("[2/3]", "Transcribe", 55), ("[3/3]", "Clean", 90)];
pub const STAGES_4: &[Stage] =
    &[("[1/4]", "Isolate lead", 12), ("[2/4]", "Detect melody", 48), ("[3/4]", "Build candidates", 78), ("[4/4]", "Prepare review", 94)];
pub const STAGES_EXPRESSIVE: &[Stage] = &[
    ("[1/6]", "Prepare model", 5), ("[2/6]", "Separate", 15), ("[3/6]", "Transcribe accompaniment", 48),
    ("[4/6]", "Detect melody", 72), ("[5/6]", "Arrange", 87), ("[6/6]", "Prepare review", 96),
];
pub const STAGES_2: &[Stage] = &[("[1/2]", "Transcribe", 40), ("[2/2]", "Clean", 90)];

/// How long a capability verdict may be reused: long enough that two frames
/// asking at launch share one `import torch`, far too short for setup to
/// change the answer.
const CHECK_TTL: Duration = Duration::from_secs(10);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("static regex"))
}

// transcribe.py / stem_to_midi.py print prose, not [N/M] markers; these are
// the phrases they actually print.
fn keyword_stage(line: &str) -> Option<(&'static str, i64)> {
    static K: [OnceLock<Regex>; 4] = [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    const TABLE: [(&str, &str, i64); 4] =
        [("(?i)separat", "Separating", 18), ("(?i)normaliz", "Transcribing", 50), ("(?i)transcrib", "Transcribing", 60), ("(?i)clean", "Cleaning", 90)];
    TABLE.iter().zip(K.iter()).find(|((p, _, _), cell)| re(cell, p).is_match(line)).map(|((_, s, pct), _)| (*s, *pct))
}

fn is_cause(line: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)error|traceback|exception|no such file|not found|out of memory|CUDA|permission").is_match(line)
}

fn is_error(line: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)error|traceback").is_match(line)
}

fn is_input_echo(line: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^input:").is_match(line)
}

fn yt_percent(line: &str) -> Option<i64> {
    static R: OnceLock<Regex> = OnceLock::new();
    let m = re(&R, r"(\d{1,3}(?:\.\d+)?)%").captures(line)?;
    let v: f64 = m[1].parse().ok()?;
    Some(js_round(v).clamp(5, 99))
}

pub fn select_script(pipeline: &str, skip_separation: bool) -> (&'static str, &'static [Stage]) {
    match pipeline {
        "expressive" => ("forge-rs", STAGES_EXPRESSIVE),
        "melody" => ("melody_to_midi.py", STAGES_4),
        "drums" => ("drums_to_midi.py", STAGES_3),
        // 'fast' before skipSeparation: both mean "no separation", and
        // testing skip first silently routed Fast to Transkun.
        "fast" => ("stem_to_midi.py", STAGES_2),
        _ if skip_separation => ("transcribe.py", STAGES_2),
        _ => ("song_to_midi.py", STAGES_3),
    }
}

/// The pipelines forge-rs runs end to end (with or without separation).
pub const RUST_MODES: [&str; 6] = ["piano", "expressive", "general", "melody", "drums", "fast"];

fn env_flag(env: &EnvMap, k: &str) -> bool {
    matches!(env.get(k), Some("1" | "true" | "True" | "yes"))
}

/// Whether this job separates: Fast never does, Melody and Drums skip on
/// SKIP_SEPARATION (job_env sets it from the Stems card), Piano and Full
/// Song skip when the card says the input is already a stem.
fn job_separates(pipeline: &str, env: &EnvMap, skip: bool) -> bool {
    match pipeline {
        "fast" => false,
        "expressive" => true,
        "melody" | "drums" => !(skip || env_flag(env, "SKIP_SEPARATION")),
        _ => !skip,
    }
}

/// Why this job has to run on the Python engine even with Rust chosen, or
/// None when forge-rs covers it. Read from the job's final environment, so
/// it sees exactly what forge-rs would (Advanced overrides included). Only
/// the settings the job actually uses count: separation knobs when it
/// separates, the Transkun segment size for Piano and Full Song.
pub fn rust_blocker(pipeline: &str, env: &EnvMap, skip: bool) -> Option<String> {
    if !RUST_MODES.contains(&pipeline) {
        return Some(format!("{pipeline} mode only runs on Python"));
    }
    if job_separates(pipeline, env, skip) {
        if env_flag(env, "USE_TTA") {
            return Some("test-time augmentation only runs on Python".into());
        }
        if env.get("BIGSHIFTS").and_then(|v| v.trim().parse::<i64>().ok()).is_some_and(|n| n > 1) {
            return Some("big shifts only run on Python".into());
        }
        if env.get("SEPARATION_BACKEND").is_some_and(|v| v.eq_ignore_ascii_case("onnx_dml")) {
            return Some("the DirectML separator only runs on Python".into());
        }
    }
    if matches!(pipeline, "piano" | "general" | "expressive")
        && env.get("SEGMENT_SIZE").filter(|v| !v.is_empty()).is_some_and(|v| v.trim().parse::<f64>().ok() != Some(16.0))
    {
        return Some("a segment size other than 16 s only runs on Python".into());
    }
    None
}

/// A ready probe that would still put the job on the CPU of a machine with an
/// NVIDIA card (no onnxruntime-gpu next to forge-rs): Python's CUDA beats Rust
/// on the CPU by minutes a song. With no NVIDIA driver both are CPU-bound.
pub fn cpu_blocker(probe: &Value) -> Option<String> {
    probe["whyCpu"]
        .as_str()
        .filter(|w| !w.is_empty() && *w != "no NVIDIA driver")
        .map(|w| format!("the Rust engine would run on the CPU here ({w})"))
}

/// `forge-rs probe`: loads nothing, answers in well under a second. Err is a
/// reason a person can read. With a mode, `ready` covers only the models
/// that job needs.
pub fn probe_rust(exe: &Path, env: &EnvMap) -> Result<Value, String> {
    probe_rust_for(exe, env, None)
}

fn expressive_engine(env: &EnvMap) -> Result<PathBuf, String> {
    let exe = fpaths::forge_rs_exe().ok_or("The Rust Forge engine is missing from this build.")?;
    if let Some(reason) = rust_blocker("expressive", env, false) {
        return Err(format!("Medley uses the native Rust settings. Check Advanced options: {reason}."));
    }
    probe_rust_for(&exe, env, Some(("expressive", false)))?;
    Ok(exe)
}

pub fn probe_rust_for(exe: &Path, env: &EnvMap, job: Option<(&str, bool)>) -> Result<Value, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("probe").arg("--mem-limit-gb").arg("0");
    if let Some((mode, skip)) = job {
        cmd.arg("--mode").arg(mode);
        if skip {
            cmd.arg("--skip-separation");
        }
    }
    if let Some(dir) = exe.parent() { cmd.current_dir(dir); }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    env.apply(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start forge-rs ({e})"))?;
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let t = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t.elapsed() > Duration::from_secs(10) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("forge-rs did not answer".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let text = reader.join().unwrap_or_default();
    let v: Value = text.lines().rev().find_map(|l| serde_json::from_str(l.trim()).ok()).ok_or("forge-rs gave no answer")?;
    if v["ready"] == json!(true) {
        Ok(v)
    } else {
        let why = v["missing"].as_array().map(|m| m.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")).unwrap_or_default();
        Err(if why.is_empty() { "the Rust engine is not ready".into() } else { why })
    }
}

fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// JavaScript's String(n) for the numbers that reach an env var or a name.
pub fn js_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn num_val(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 { json!(n as i64) } else { json!(n) }
}

/// JavaScript truthiness, for `!!opts.x` and `x || default`.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// String(v || '').
pub fn js_str(v: Option<&Value>) -> String {
    if !truthy(v) {
        return String::new();
    }
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_num(n.as_f64().unwrap_or(0.0)),
        Some(Value::Bool(_)) => "true".into(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// forge-runner.js parseTimeSeconds: '' and null are "not set", anything
/// Number() reads as a non-negative finite number is a time.
pub fn parse_time_seconds(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Null => return None,
        Value::String(s) if s.is_empty() => return None,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().ok()? }
        }
        Value::Number(n) => n.as_f64()?,
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => return None,
    };
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// Where a run writes its MIDI: next to the input (main.js moves it to the
/// output folder afterwards), named after the song or the custom name, with a
/// range suffix so two ranges of one song land side by side.
pub fn output_midi_path(input: &str, start: Option<f64>, end: Option<f64>, output_name: &str) -> String {
    static BAD: OnceLock<Regex> = OnceLock::new();
    static MIDEXT: OnceLock<Regex> = OnceLock::new();
    static EXT: OnceLock<Regex> = OnceLock::new();
    let named: String = re(&BAD, r#"[<>:"/\\|?*\x00-\x1f]"#).replace_all(output_name.trim(), "").chars().take(120).collect();
    let extless = if named.is_empty() {
        re(&EXT, r"\.[^./\\]+$").replace(input, "").into_owned()
    } else {
        let dir = Path::new(input).parent().unwrap_or(Path::new(""));
        dir.join(re(&MIDEXT, r"(?i)\.midi?$").replace(&named, "").as_ref()).to_string_lossy().into_owned()
    };
    if start.is_none() && end.is_none() {
        return format!("{extless}.mid");
    }
    let fmt = |n: f64| js_num((n * 1000.0 + 0.5).floor() / 1000.0).replace('.', "p");
    format!("{extless}_range_{}_{}.mid", fmt(start.unwrap_or(0.0)), end.map_or("end".to_string(), fmt))
}

/// The job's environment on top of forgeChildEnv: batch and thread counts from
/// the user's allowance (halved while a game or playback is up front), the
/// OpenMP pool told to sleep instead of spin, the Advanced panel's overrides,
/// and the time range.
#[allow(clippy::too_many_arguments)]
pub fn job_env(mut env: EnvMap, perf: &Value, background: bool, advanced: &Value, start: Option<f64>, end: Option<f64>, pipeline: &str, skip: bool) -> EnvMap {
    let pick = |k: &str, d: f64| perf.get(k).and_then(Value::as_f64).filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(d);
    let half = |n: f64| js_round(n / 2.0).max(1) as f64;
    let (b, t) = (pick("batch", 2.0), pick("threads", 4.0));
    let (batch, threads) = if background { (half(b), half(t)) } else { (b, t) };
    env.set_default("SEPARATION_BATCH", &js_num(if pipeline == "expressive" { 1.0 } else { batch }));
    env.set_default("TRANSCRIBE_BATCH", &js_num(batch));
    env.set_default("OMP_NUM_THREADS", &js_num(threads));
    env.set_default("MKL_NUM_THREADS", &js_num(threads));
    // Torch's OpenMP workers SPIN between parallel regions by default and a
    // spinning thread never yields, below-normal priority or not: that is
    // what froze the UI in ~0.2 s bursts while a song transcribed.
    env.set_default("OMP_WAIT_POLICY", "PASSIVE");
    env.set_default("KMP_BLOCKTIME", "0");
    if let Some(adv) = advanced.as_object() {
        for (k, v) in adv {
            let s = match v {
                Value::Null => continue,
                Value::String(s) if s.is_empty() => continue,
                Value::Bool(true) => "1".to_string(),
                Value::Bool(false) => "0".to_string(),
                Value::String(s) => s.clone(),
                Value::Number(n) => js_num(n.as_f64().unwrap_or(0.0)),
                other => other.to_string(),
            };
            env.set(k, &s);
        }
    }
    if let Some(s) = start {
        env.set("FORGE_START_SEC", &js_num(s));
    }
    if let Some(e) = end {
        env.set("FORGE_END_SEC", &js_num(e));
    }
    if pipeline == "general" {
        env.set("GENERAL_MODE", "1");
    }
    if (pipeline == "drums" || pipeline == "melody") && skip {
        env.set("SKIP_SEPARATION", "1");
    }
    env
}

// ---- the line pump ------------------------------------------------------------

/// forge-runner.js makePump: \r ends a line too, because MSST's tqdm bar, pip
/// and yt-dlp rewrite one line with \r for minutes and never send \n. Bytes in,
/// so a UTF-8 character split across two reads is never mangled.
#[derive(Default)]
pub struct Pump {
    buf: Vec<u8>,
}

impl Pump {
    pub fn feed(&mut self, chunk: &[u8], mut on_line: impl FnMut(&str)) {
        self.buf.extend_from_slice(chunk);
        let mut start = 0;
        while let Some(off) = self.buf[start..].iter().position(|b| *b == b'\r' || *b == b'\n') {
            let i = start + off;
            let line = String::from_utf8_lossy(&self.buf[start..i]);
            let line = line.trim();
            if !line.is_empty() {
                on_line(line);
            }
            start = i + if self.buf[i] == b'\r' && self.buf.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
        }
        self.buf.drain(..start);
        if self.buf.len() > 8192 {
            self.buf.drain(..self.buf.len() - 1024);
        }
    }

    /// The tail a process left without a newline, at EOF.
    pub fn finish(&mut self, mut on_line: impl FnMut(&str)) {
        let line = String::from_utf8_lossy(&self.buf).trim().to_string();
        self.buf.clear();
        if !line.is_empty() {
            on_line(&line);
        }
    }
}

// ---- what a job's output means --------------------------------------------------

pub trait Lines: Send {
    fn line(&mut self, line: &str) -> Vec<Value>;
    fn exit(&mut self, code: Option<i32>, cancelled: bool) -> Vec<Value>;
}

fn active_line(parser: &mut dyn Lines, line: &str, cancelled: &AtomicBool) -> Vec<Value> {
    // Buffered stdout can arrive after cancellation, including a success marker.
    if cancelled.load(Ordering::SeqCst) { vec![] } else { parser.line(line) }
}

/// One pipeline run's output, line by line, into forge:status payloads.
pub struct JobParser {
    job_id: String,
    table: &'static [Stage],
    audio_out: String,
    meta: Value,
    recent: VecDeque<String>,
    causes: Vec<String>,
    peak: i64,
    result: Option<Value>,
    finalized: bool,
    t_idx: Option<usize>,
    t_from: i64,
    t_to: i64,
    /// The same for Separate and forge-rs's SSEG chunk counts.
    s_span: Option<(i64, i64)>,
}

impl JobParser {
    pub fn new(job_id: &str, table: &'static [Stage], audio_out: &str, meta: Value) -> JobParser {
        // Where Transcribe sits in this table and where the next stage starts,
        // so TSEG segment counts can walk the bar between them.
        let t_idx = table.iter().position(|(_, s, _)| *s == "Transcribe");
        let t_from = t_idx.map_or(0, |i| table[i].2);
        let t_to = t_idx.and_then(|i| table.get(i + 1)).map_or(t_from, |n| n.2 - 2);
        // Melody separates inside its "Isolate lead" stage.
        let s_span = table
            .iter()
            .position(|(_, s, _)| *s == "Separate" || *s == "Isolate lead")
            .map(|i| (table[i].2, table.get(i + 1).map_or(table[i].2, |n| n.2 - 2)));
        JobParser {
            job_id: job_id.into(),
            table,
            audio_out: audio_out.into(),
            meta,
            recent: VecDeque::new(),
            causes: Vec::new(),
            peak: -1,
            result: None,
            finalized: false,
            t_idx,
            t_from,
            t_to,
            s_span,
        }
    }

    fn progress(&mut self, stage: &str, pct: i64, message: &str) -> Value {
        self.peak = self.peak.max(pct); // a bar that walks backwards reads as a bug
        json!({"event": "forge.progress", "jobId": self.job_id, "stage": stage, "percent": self.peak, "message": message})
    }

    fn remember(&mut self, line: &str) {
        self.recent.push_back(line.to_string());
        if self.recent.len() > 15 {
            self.recent.pop_front();
        }
        if is_cause(line) && self.causes.len() < 6 {
            self.causes.push(line.to_string());
        }
    }
}

impl Lines for JobParser {
    fn line(&mut self, line: &str) -> Vec<Value> {
        self.remember(line);
        // TSEG|k|N from transcribe_fast.py (GPU and DirectML paths only).
        if let Some(rest) = line.strip_prefix("TSEG|") {
            let mut it = rest.split('|');
            let done: f64 = it.next().map(str::trim).and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
            let total: f64 = it.next().map(str::trim).and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
            if self.t_idx.is_some() && total > 0.0 && done.is_finite() {
                let pct = js_round(self.t_from as f64 + (self.t_to - self.t_from) as f64 * (done / total));
                return vec![self.progress("Transcribe", pct, &format!("Transcribing segment {}/{}", js_num(done), js_num(total)))];
            }
            return vec![];
        }
        // SSEG|k|N from forge-rs: separation chunk k of N.
        if let Some(rest) = line.strip_prefix("SSEG|") {
            let mut it = rest.split('|');
            let done: f64 = it.next().map(str::trim).and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
            let total: f64 = it.next().map(str::trim).and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
            if let Some((from, to)) = self.s_span.filter(|_| total > 0.0 && done.is_finite()) {
                let pct = js_round(from as f64 + (to - from) as f64 * (done / total));
                let stage = self.table.iter().find(|(_, s, _)| *s == "Separate" || *s == "Isolate lead").map_or("Separate", |t| t.1);
                return vec![self.progress(stage, pct, &format!("Separating part {}/{}", js_num(done), js_num(total)))];
            }
            return vec![];
        }
        if let Some(rest) = line.strip_prefix("RESULT|") {
            return match serde_json::from_str::<Value>(rest) {
                Ok(v) => {
                    self.result = Some(v);
                    vec![]
                }
                Err(_) => vec![json!({"event": "forge.log", "jobId": self.job_id, "line": "Could not read pipeline result metadata.", "level": "error"})],
            };
        }
        if line.starts_with("DONE") {
            // The scripts write the path they were given; that is the answer,
            // not the noisy DONE text.
            self.finalized = true;
            let mut result = Map::new();
            result.insert("midiPath".into(), json!(self.audio_out));
            for src in [self.result.as_ref(), Some(&self.meta)].into_iter().flatten() {
                if let Some(o) = src.as_object() {
                    for (k, v) in o {
                        result.insert(k.clone(), v.clone());
                    }
                }
            }
            return vec![
                json!({"event": "forge.progress", "jobId": self.job_id, "stage": "Done", "percent": 100, "message": "Extraction complete"}),
                json!({"event": "forge.done", "jobId": self.job_id, "ok": true, "result": result}),
            ];
        }
        for (marker, stage, pct) in self.table {
            if line.contains(marker) {
                return vec![self.progress(stage, *pct, line)];
            }
        }
        // Only the scripts' prose may drive the keyword fallback: the "Input:
        // <song>" echo once jumped the bar to 90% on a song called "Clean".
        if !std::ptr::eq(self.table, STAGES_EXPRESSIVE) && !is_input_echo(line) {
            if let Some((stage, pct)) = keyword_stage(line) {
                return vec![self.progress(stage, pct, line)];
            }
        }
        vec![json!({"event": "forge.log", "jobId": self.job_id, "line": line, "level": if is_error(line) { "error" } else { "info" }})]
    }

    fn exit(&mut self, code: Option<i32>, cancelled: bool) -> Vec<Value> {
        if self.finalized {
            return vec![];
        }
        let code_s = code.map_or("null".to_string(), |c| c.to_string());
        let error = if cancelled {
            "cancelled".to_string()
        } else if code != Some(0) {
            // "exit code 1" tells a user nothing: the lines that look like a
            // cause, else the last few lines.
            let lines: Vec<&String> = if self.causes.is_empty() {
                self.recent.iter().skip(self.recent.len().saturating_sub(4)).collect()
            } else {
                self.causes.iter().collect()
            };
            let why: String = lines.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n").chars().take(900).collect();
            if why.is_empty() { format!("exit code {code_s}") } else { format!("{why}\n(exit code {code_s})") }
        } else {
            "finished without producing output".to_string()
        };
        vec![json!({"event": "forge.done", "jobId": self.job_id, "ok": false, "error": error})]
    }
}

/// yt_download.py: percentages, then DOWNLOADED: <path>.
pub struct YtParser {
    job_id: String,
    finalized: bool,
    recent: VecDeque<String>,
    causes: VecDeque<String>,
}

impl YtParser {
    pub fn new(job_id: &str) -> YtParser {
        YtParser { job_id: job_id.into(), finalized: false, recent: VecDeque::new(), causes: VecDeque::new() }
    }

    fn remember(&mut self, line: &str) {
        let text: String = line.chars().take(900).collect();
        self.recent.push_back(text.clone());
        if self.recent.len() > 4 {
            self.recent.pop_front();
        }
        if is_cause(line) || line.to_ascii_lowercase().starts_with("hint:") || line.contains(" -m pip ") {
            self.causes.push_back(text);
            if self.causes.len() > 6 {
                self.causes.pop_front();
            }
        }
    }
}

impl Lines for YtParser {
    fn line(&mut self, line: &str) -> Vec<Value> {
        if self.finalized {
            return vec![];
        }
        self.remember(line);
        if let Some(p) = line.strip_prefix("DOWNLOADED:").map(str::trim).filter(|p| !p.is_empty()) {
            self.finalized = true;
            return vec![
                json!({"event": "forge.progress", "jobId": self.job_id, "stage": "Done", "percent": 100, "message": "Download complete"}),
                json!({"event": "forge.done", "jobId": self.job_id, "ok": true, "result": {"downloadedPath": p}}),
            ];
        }
        if let Some(pct) = yt_percent(line) {
            return vec![json!({"event": "forge.progress", "jobId": self.job_id, "stage": "Download", "percent": pct, "message": line})];
        }
        vec![json!({"event": "forge.log", "jobId": self.job_id, "line": line, "level": if is_error(line) { "error" } else { "info" }})]
    }

    fn exit(&mut self, code: Option<i32>, cancelled: bool) -> Vec<Value> {
        if self.finalized {
            return vec![];
        }
        self.finalized = true;
        let error = if cancelled {
            "cancelled".to_string()
        } else if code != Some(0) {
            let lines = if self.causes.is_empty() { &self.recent } else { &self.causes };
            let why = lines.iter().map(String::as_str).collect::<Vec<_>>().join("\n");
            let tail: String = why.chars().rev().take(900).collect();
            let why: String = tail.chars().rev().collect();
            let code_s = code.map_or("null".to_string(), |c| c.to_string());
            if why.is_empty() { format!("exit code {code_s}") } else { format!("{why}\n(exit code {code_s})") }
        } else {
            // Electron said nothing here and the panel waited forever.
            "finished without producing output".to_string()
        };
        vec![json!({"event": "forge.done", "jobId": self.job_id, "ok": false, "error": error})]
    }
}

// ---- the pid file ------------------------------------------------------------------

static PID_FILE: Mutex<()> = Mutex::new(());

pub fn read_pids(file: &Path) -> Vec<u32> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .map(|v| v.iter().filter_map(Value::as_u64).map(|p| p as u32).collect())
        .unwrap_or_default()
}

fn write_pids(file: &Path, pids: &[u32]) {
    let _ = std::fs::write(file, serde_json::to_string(pids).unwrap_or_else(|_| "[]".into()));
}

pub fn track_pid(file: &Path, pid: u32) {
    let _g = PID_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let mut pids = read_pids(file);
    if !pids.contains(&pid) {
        pids.push(pid);
        write_pids(file, &pids);
    }
}

pub fn untrack_pid(file: &Path, pid: u32) {
    let _g = PID_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let pids: Vec<u32> = read_pids(file).into_iter().filter(|p| *p != pid).collect();
    write_pids(file, &pids);
}

/// At startup: anything in the pid file still alive as an interpreter is a
/// job from a host that died without its job objects closing. Only the pids
/// this reap looked at are forgotten.
pub fn reap_orphans(file: &Path) -> usize {
    let pids = read_pids(file);
    if pids.is_empty() {
        return 0;
    }
    let snap = winjob::snapshot();
    let mut killed = 0;
    for pid in &pids {
        let ours = snap.iter().any(|(p, _, name)| p == pid && winjob::is_reapable_name(name));
        if ours && winjob::kill_tree(*pid) {
            killed += 1;
        }
    }
    let _g = PID_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let left: Vec<u32> = read_pids(file).into_iter().filter(|p| !pids.contains(p)).collect();
    write_pids(file, &left);
    killed
}

// ---- the runner ----------------------------------------------------------------------

struct Entry {
    pid: u32,
    job: Arc<Job>,
    cancelled: Arc<AtomicBool>,
}

struct Slot {
    v: Mutex<Option<Value>>,
    cv: Condvar,
}

#[derive(Default)]
struct CheckState {
    cache: Option<(Option<PathBuf>, Instant, Value)>,
    in_flight: Option<(Option<PathBuf>, Arc<Slot>)>,
}

pub struct Runner {
    emit: Emit,
    log: Log,
    ctx: GetCtx,
    pid_file: PathBuf,
    jobs: Mutex<HashMap<String, Entry>>,
    seq: AtomicU64,
    paused: AtomicBool,
    background: AtomicBool,
    check: Mutex<CheckState>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A payload emitted after the IPC reply that returned the job id, as the
/// setTimeout(…, 0) calls did.
fn emit_later(emit: &Emit, v: Value) {
    let emit = emit.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        emit(v);
    });
}

impl Runner {
    pub fn new(emit: Emit, log: Log, ctx: GetCtx, pid_file: PathBuf) -> Arc<Runner> {
        Arc::new(Runner {
            emit,
            log,
            ctx,
            pid_file,
            jobs: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            paused: AtomicBool::new(false),
            background: AtomicBool::new(false),
            check: Mutex::new(CheckState::default()),
        })
    }

    pub fn is_running(&self) -> bool {
        !lock(&self.jobs).is_empty()
    }

    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn fail_later(&self, job_id: &str, error: &str) {
        emit_later(&self.emit, json!({"event": "forge.done", "jobId": job_id, "ok": false, "error": error}));
    }

    /// Pause frees the GPU without losing the minutes already spent: every
    /// process in every job's tree is suspended, not just the direct child.
    pub fn set_paused(&self, paused: bool) -> Value {
        let jobs: Vec<(u32, Arc<Job>)> = lock(&self.jobs).values().map(|e| (e.pid, e.job.clone())).collect();
        if jobs.is_empty() {
            return json!({"ok": false, "error": "Nothing is running."});
        }
        let mut done = false;
        for (pid, job) in &jobs {
            let mut pids = job.pids();
            if pids.is_empty() {
                pids.push(*pid);
            }
            for p in pids {
                done = winjob::suspend(p, !paused) || done;
            }
        }
        if !done {
            return json!({"ok": false, "error": "Could not pause the job on this system."});
        }
        self.paused.store(paused, Ordering::SeqCst);
        (self.emit)(json!({"event": "forge.paused", "paused": paused}));
        json!({"ok": true, "paused": paused})
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Idle while playback is live or a game is up front, below normal otherwise.
    pub fn set_background(&self, background: bool) {
        self.background.store(background, Ordering::SeqCst);
        let jobs: Vec<(u32, Arc<Job>)> = lock(&self.jobs).values().map(|e| (e.pid, e.job.clone())).collect();
        for (pid, job) in jobs {
            let mut pids = job.pids();
            if pids.is_empty() {
                pids.push(pid);
            }
            for p in pids {
                winjob::set_priority(p, background);
            }
        }
    }

    /// Spawn `args` in a job of its own and stream its output through `lines`.
    fn launch(self: &Arc<Self>, job_id: &str, args: Vec<OsString>, env: EnvMap, lines: Box<dyn Lines>) {
        let ctx = (self.ctx)();
        let idle = self.background.load(Ordering::SeqCst) || ctx.perf.get("lowPriority") == Some(&json!(true));
        let fail = |e: String| (self.emit)(json!({"event": "forge.done", "jobId": job_id, "ok": false, "error": format!("spawn failed: {e}")}));
        let job = match Job::new(winjob::mem_limit()) {
            Ok(j) => Arc::new(j),
            Err(e) => return fail(e.to_string()),
        };
        let mut cmd = Command::new(&args[0]);
        let cwd = if args.get(1).is_some_and(|arg| arg == "pipeline") {
            Path::new(&args[0]).parent().map(Path::to_path_buf).unwrap_or_default()
        } else { engine_dir() };
        cmd.args(&args[1..]).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        env.apply(&mut cmd);
        let (mut child, in_job) = match winjob::spawn_in_job(&mut cmd, &job, idle) {
            Ok(c) => c,
            Err(e) => return fail(e.to_string()),
        };
        let pid = child.id();
        let cancelled = Arc::new(AtomicBool::new(false));
        lock(&self.jobs).insert(job_id.to_string(), Entry { pid, job: job.clone(), cancelled: cancelled.clone() });
        track_pid(&self.pid_file, pid);
        (self.log)(&format!(
            "forge {job_id}: pid {pid} in_job={in_job} kill_on_close={} mem_limit={:?} priority_class=0x{:x}",
            job.kills_on_close(),
            job.memory_limit(),
            winjob::priority_class(pid)
        ));

        let lines = Arc::new(Mutex::new(lines));
        let (eof_tx, eof_rx) = mpsc::channel::<()>();
        let readers: Vec<Box<dyn Read + Send>> = [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .collect();
        let n_readers = readers.len();
        for mut r in readers {
            let (lines, emit, tx, cancelled) = (lines.clone(), self.emit.clone(), eof_tx.clone(), cancelled.clone());
            std::thread::spawn(move || {
                let mut pump = Pump::default();
                let mut buf = [0u8; 8192];
                let mut handle = |line: &str| {
                    let evs = active_line(lock(&lines).as_mut(), line, &cancelled);
                    for ev in evs {
                        emit(ev);
                    }
                };
                loop {
                    match r.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => pump.feed(&buf[..n], &mut handle),
                    }
                }
                pump.finish(&mut handle);
                let _ = tx.send(());
            });
        }
        drop(eof_tx);
        let me = self.clone();
        let id = job_id.to_string();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            // A grandchild that inherited the pipes can hold them open after
            // the child is gone; it gets a moment, then the job ends it.
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut got = 0;
            while got < n_readers {
                let left = deadline.saturating_duration_since(Instant::now());
                match eof_rx.recv_timeout(left) {
                    Ok(()) => got += 1,
                    Err(_) => {
                        job.terminate();
                        let _ = eof_rx.recv_timeout(Duration::from_secs(2));
                        break;
                    }
                }
            }
            let peak = job.peak_memory();
            {
                let mut jobs = lock(&me.jobs);
                jobs.remove(&id);
                if jobs.is_empty() {
                    me.paused.store(false, Ordering::SeqCst);
                }
            }
            untrack_pid(&me.pid_file, pid);
            let was_cancelled = cancelled.load(Ordering::SeqCst);
            (me.log)(&format!(
                "forge {id}: exit code={code:?} cancelled={was_cancelled} peak_job_commit={:.3} GiB",
                peak as f64 / (1u64 << 30) as f64
            ));
            let near_cap = job.configured_limit().is_some_and(|l| peak as f64 >= l as f64 * 0.97);
            let evs = lock(&lines).exit(code, was_cancelled);
            for mut ev in evs {
                if near_cap && ev["ok"] == json!(false) && !was_cancelled {
                    if let Some(Value::String(e)) = ev.get_mut("error") {
                        e.push_str(&format!("\n(the job reached its {:.1} GB memory limit)", job.configured_limit().unwrap_or(0) as f64 / (1u64 << 30) as f64));
                    }
                }
                (me.emit)(ev);
            }
            drop(job);
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn run(self: &Arc<Self>, input: &str, pipeline: &str, skip: bool, advanced: &Value, timing: &Value, output_name: &str, output_dir: &Path) -> String {
        let job_id = self.next_id("job");
        let ctx = (self.ctx)();
        // forgeEnvReady, not "python.exe exists": a cancelled setup leaves an
        // interpreter without torch, and the job died on import.
        if input.is_empty() {
            self.fail_later(&job_id, "No input file.");
            return job_id;
        }
        let (script, table) = select_script(pipeline, skip);
        let start = parse_time_seconds(timing.get("start"));
        let end = parse_time_seconds(timing.get("end"));
        if let (Some(s), Some(e)) = (start, end) {
            if e <= s {
                self.fail_later(&job_id, "Stop time must be after start time.");
                return job_id;
            }
        }
        let env = job_env(fpaths::forge_child_env(&ctx.paths), &ctx.perf, self.background.load(Ordering::SeqCst), advanced, start, end, pipeline, skip);
        let audio_out = if pipeline == "expressive" {
            // Expressive exports go straight to the chosen output folder, including on read-only input media.
            let source = Path::new(input);
            let target = output_dir.join(source.file_name().unwrap_or_default());
            let default_name = format!("{} - Medley", source.file_stem().unwrap_or_default().to_string_lossy());
            let name = if output_name.trim().is_empty() { &default_name } else { output_name };
            output_midi_path(&target.to_string_lossy(), start, end, name)
        } else {
            output_midi_path(input, start, end, output_name)
        };
        let rust = if pipeline == "expressive" {
            match expressive_engine(&env) {
                Ok(exe) => Some(exe),
                Err(why) => { self.fail_later(&job_id, &why); return job_id; }
            }
        } else if ctx.forge_engine == "rust" { self.rust_engine_for(&job_id, pipeline, &env, skip) } else { None };
        let label = if rust.is_some() { "forge-rs pipeline (Rust engine)".to_string() } else { script.to_string() };
        (self.emit)(json!({"event": "forge.progress", "jobId": job_id, "stage": "Queued", "percent": -1, "message": format!("Starting {label}")}));
        let meta = json!({
            "pipeline": pipeline,
            "engine": if rust.is_some() { "rust" } else { "python" },
            "timing": {"start": start.map_or(Value::Null, num_val), "end": end.map_or(Value::Null, num_val)},
        });
        let args = match rust {
            // Same input and output as the script; forge-rs reads the same
            // env knobs, and the job runs under the same Job Object, cap,
            // pause, cancel and priority as any other.
            Some(exe) => {
                let mut a: Vec<OsString> = vec![exe.into_os_string(), "pipeline".into(), input.into(), audio_out.clone().into(), "--mode".into(), pipeline.into()];
                if skip {
                    a.push("--skip-separation".into());
                }
                // The host's Job Object owns the cap; forge-rs's own 7.5 GiB
                // CLI default would otherwise still apply.
                a.extend(["--mem-limit-gb".into(), "0".into()]);
                a
            }
            None => {
                let Some(py) = fpaths::forge_env_python(&ctx.paths).filter(|_| fpaths::forge_env_ready(&ctx.paths)) else {
                    self.fail_later(&job_id, "Open Forge and choose Set up Forge to install the selected engine.");
                    return job_id;
                };
                vec![py.into_os_string(), engine_dir().join(script).into_os_string(), input.into(), audio_out.clone().into()]
            }
        };
        self.launch(&job_id, args, env, Box::new(JobParser::new(&job_id, table, &audio_out, meta)));
        job_id
    }

    /// forge-rs for this job, when the Rust engine is chosen, covers the
    /// mode and is ready; otherwise None, with one log line saying why the
    /// job stays on Python.
    fn rust_engine_for(&self, job_id: &str, pipeline: &str, env: &EnvMap, skip: bool) -> Option<PathBuf> {
        let why = match rust_blocker(pipeline, env, skip) {
            Some(why) => why,
            None => match fpaths::forge_rs_exe() {
                None => "this build does not include the Rust engine".into(),
                Some(exe) => match probe_rust_for(&exe, env, Some((pipeline, skip))) {
                    Ok(v) => match cpu_blocker(&v) {
                        Some(why) => why,
                        None => return Some(exe),
                    },
                    Err(e) => format!("the Rust engine is not ready ({e})"),
                },
            },
        };
        (self.log)(&format!("forge {job_id}: python engine: {why}"));
        (self.emit)(json!({"event": "forge.log", "jobId": job_id, "level": "info", "line": format!("Using the Python engine for this job: {why}.")}));
        None
    }

    pub fn yt(self: &Arc<Self>, url: &str, out_dir: &str) -> String {
        let job_id = self.next_id("yt");
        let ctx = (self.ctx)();
        let Some(py) = fpaths::forge_env_python(&ctx.paths) else {
            self.fail_later(&job_id, "Midi-Forge isn't set up yet.");
            return job_id;
        };
        if url.is_empty() {
            self.fail_later(&job_id, "No URL.");
            return job_id;
        }
        let env = fpaths::forge_child_env(&ctx.paths);
        let mut args = vec![py.into_os_string(), engine_dir().join("yt_download.py").into_os_string(), url.into()];
        // Empty: yt_download.py picks its own writable default (never cwd).
        if !out_dir.is_empty() {
            args.push(out_dir.into());
        }
        (self.emit)(json!({"event": "forge.progress", "jobId": job_id, "stage": "Download", "percent": -1, "message": format!("Downloading {url}")}));
        self.launch(&job_id, args, env, Box::new(YtParser::new(&job_id)));
        job_id
    }

    /// The whole tree, at once: TerminateJobObject, with taskkill's walk as
    /// the fallback for a child that never made it into its job.
    pub fn cancel(&self, job_id: &str) -> bool {
        let jobs = lock(&self.jobs);
        let Some(e) = jobs.get(job_id) else { return false };
        e.cancelled.store(true, Ordering::SeqCst);
        // A suspended tree must be able to die (TerminateJobObject works on
        // suspended processes, but the fallback walk wants them running).
        if !e.job.terminate() {
            winjob::kill_tree(e.pid);
        }
        true
    }

    pub fn cancel_all(&self) {
        let ids: Vec<String> = lock(&self.jobs).keys().cloned().collect();
        for id in ids {
            self.cancel(&id);
        }
    }

    pub fn invalidate_check(&self) {
        lock(&self.check).cache = None;
    }

    /// The out-of-process capability probe: {forgeReady, forgePython, gpu,
    /// torch, missing}. Callers that arrive while one runs share it, and a
    /// verdict is reused for CHECK_TTL; fresh bypasses both.
    pub fn check(&self, fresh: bool) -> Value {
        let ctx = (self.ctx)();
        let py = fpaths::forge_env_python(&ctx.paths);
        let slot = {
            let mut st = lock(&self.check);
            if fresh {
                st.cache = None;
            }
            if let Some((cpy, at, v)) = &st.cache {
                if *cpy == py && at.elapsed() < CHECK_TTL {
                    return v.clone();
                }
            }
            match &st.in_flight {
                Some((ipy, slot)) if *ipy == py && !fresh => Err(slot.clone()),
                _ => {
                    let slot = Arc::new(Slot { v: Mutex::new(None), cv: Condvar::new() });
                    st.in_flight = Some((py.clone(), slot.clone()));
                    Ok(slot)
                }
            }
        };
        match slot {
            Err(shared) => {
                let mut g = lock(&shared.v);
                while g.is_none() {
                    g = shared.cv.wait(g).unwrap_or_else(|e| e.into_inner());
                }
                g.clone().unwrap_or(Value::Null)
            }
            Ok(mine) => {
                let v = self.run_check(py.clone(), &ctx);
                {
                    let mut st = lock(&self.check);
                    st.cache = Some((py, Instant::now(), v.clone()));
                    if st.in_flight.as_ref().is_some_and(|(_, s)| Arc::ptr_eq(s, &mine)) {
                        st.in_flight = None;
                    }
                }
                *lock(&mine.v) = Some(v.clone());
                mine.cv.notify_all();
                v
            }
        }
    }

    fn run_check(&self, py: Option<PathBuf>, ctx: &Ctx) -> Value {
        let py_v = py.as_ref().map_or(Value::Null, |p| json!(p.to_string_lossy()));
        // Rust chosen and ready: its own probe answers, so no torch import
        // and the GPU named is the one the jobs will really run on. A Rust
        // engine that is not ready sends jobs to Python, so Python answers.
        if ctx.forge_engine == "rust" {
            if let Some(Ok(v)) = fpaths::forge_rs_exe().map(|e| probe_rust(&e, &fpaths::forge_child_env(&ctx.paths))) {
                return rust_verdict(&v, py_v, fpaths::nvidia_gpu_name);
            }
        }
        let none = |missing: &str| json!({"forgeReady": false, "forgePython": py_v, "gpu": null, "torch": false, "missing": [missing]});
        let Some(py) = py else { return none("forge-env") };
        let Ok(job) = Job::new(winjob::mem_limit()) else { return none("forge-env") };
        let mut cmd = Command::new(&py);
        cmd.arg(engine_dir().join("env_probe.py")).current_dir(engine_dir()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let Ok((mut child, _)) = winjob::spawn_in_job(&mut cmd, &job, true) else { return none("forge-env") };
        let mut out = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_string(&mut s);
            }
            s
        });
        let t = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) if t.elapsed() > CHECK_TIMEOUT => {
                    job.terminate();
                    let _ = child.wait();
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            }
        }
        let out = reader.join().unwrap_or_default();
        drop(job);
        probe_verdict(&out, py_v, fpaths::forge_env_ready(&ctx.paths))
    }
}

/// The probe prints one JSON line last; read the last line that looks like one.
pub fn probe_verdict(out: &str, forge_python: Value, env_ready: bool) -> Value {
    let probe = out.lines().rev().map(str::trim).find(|l| l.starts_with('{')).and_then(|l| serde_json::from_str::<Value>(l).ok());
    let flag = |k: &str| probe.as_ref().and_then(|p| p.get(k)).is_some_and(|v| truthy(Some(v)));
    let torch = flag("torch");
    let mut missing = Vec::new();
    if !torch {
        missing.push("torch");
    }
    if probe.is_some() {
        if !flag("transkun") {
            missing.push("transkun");
        }
        if !flag("basic_pitch") {
            missing.push("basic-pitch");
        }
        if !flag("yt_dlp") {
            missing.push("yt-dlp");
        }
    }
    json!({
        "forgeReady": env_ready && torch,
        "forgePython": forge_python,
        "gpu": probe.as_ref().and_then(|p| p.get("gpu")).cloned().unwrap_or(Value::Null),
        "torch": torch,
        "missing": missing,
    })
}

/// forge:check from a ready `forge-rs probe`. gpu follows its EP: CUDA names
/// the card, CPU is null so the UI says CPU.
pub fn rust_verdict(probe: &Value, forge_python: Value, gpu_name: impl FnOnce() -> Option<String>) -> Value {
    let gpu = if probe["ep"] == "cuda" {
        json!(format!("{} (CUDA)", gpu_name().unwrap_or_else(|| "NVIDIA GPU".into())))
    } else {
        Value::Null
    };
    json!({
        "forgeReady": true,
        "forgePython": forge_python,
        "gpu": gpu,
        "torch": false,
        "missing": [],
        "engine": "rust",
        "ep": probe["ep"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pump_all(chunks: &[&[u8]]) -> Vec<String> {
        let mut p = Pump::default();
        let mut out = Vec::new();
        for c in chunks {
            p.feed(c, |l| out.push(l.to_string()));
        }
        p.finish(|l| out.push(l.to_string()));
        out
    }

    #[test]
    fn pump_splits_on_cr_lf_and_crlf() {
        // tqdm's own format: it rewrites one bar with \r only, then one \n.
        let tqdm: &[u8] = b"Processing audio chunks:   0%|          | 0/18 [00:00<?, ?it/s]\rProcessing audio chunks:  11%|\xe2\x96\x88         | 2/18 [00:01<00:12,  1.30it/s]\rProcessing audio chunks: 100%|\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88| 18/18 [00:11<00:00,  1.55it/s]\n";
        let got = pump_all(&[tqdm]);
        assert_eq!(got.len(), 3);
        assert!(got[1].contains("11%|\u{2588}"));
        assert_eq!(pump_all(&[b"a\r\nb\n\nc\rd"]), vec!["a", "b", "c", "d"]);
        // A \r\n split across reads and a UTF-8 character split across reads.
        assert_eq!(pump_all(&[b"one\r", b"\ntw\xe2\x96", b"\x88o\n"]), vec!["one", "tw\u{2588}o"]);
        assert_eq!(pump_all(&[b"   \r\n  padded  \n"]), vec!["padded"]);
    }

    #[test]
    fn pump_bounds_a_line_that_never_ends() {
        let mut p = Pump::default();
        let big = vec![b'x'; 20_000];
        let mut n = 0;
        p.feed(&big, |_| n += 1);
        assert_eq!(n, 0);
        assert!(p.buf.len() <= 8192);
        let mut many = Vec::new();
        for i in 0..20_000 {
            many.extend_from_slice(format!("{i}%\r").as_bytes());
        }
        let mut lines = 0;
        Pump::default().feed(&many, |_| lines += 1);
        assert_eq!(lines, 20_000);
    }

    fn feed(p: &mut JobParser, lines: &[&str]) -> Vec<Value> {
        lines.iter().flat_map(|l| p.line(l)).collect()
    }

    #[test]
    fn song_to_midi_stages() {
        // song_to_midi.py's own print() lines in order (CUDA path, with
        // transcribe_fast.py's TSEG counts), as the pump delivers them.
        let mut p = JobParser::new("job-1", STAGES_3, r"C:\m\song.mid", json!({"pipeline": "piano", "timing": {"start": null, "end": null}}));
        let ev = feed(&mut p, &[
            "Device: cuda (NVIDIA GeForce RTX 3070)",
            "Input: Clean Bandit - Symphony.mp3",
            "[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem, batch 2)",
            "separation done in 41.2s",
            "using piano stem -> Symphony_piano.wav",
            "Normalizing stem to -20.0 dB RMS (peak ceiling -1.0 dB)",
            "[2/3] Transcribing with Transkun V2 (SOTA piano MIDI), cuda",
            "TSEG|0|12",
            "TSEG|6|12",
            "TSEG|12|12",
            "done in 18.0s",
            "[3/3] Cleaning MIDI (drop notes < 0.03s or velocity < 20)",
            "1023 -> 998 notes (dropped 25)",
            "RESULT|{\"sourceAudio\": \"C:\\\\m\\\\song.mp3\", \"candidateCounts\": {\"clean\": 812}}",
            "DONE.",
        ]);
        let stages: Vec<(String, i64)> = ev
            .iter()
            .filter(|e| e["event"] == "forge.progress")
            .map(|e| (e["stage"].as_str().unwrap().to_string(), e["percent"].as_i64().unwrap()))
            .collect();
        assert_eq!(
            stages,
            vec![
                ("Separate".into(), 15),
                ("Separating".into(), 18),
                ("Transcribing".into(), 50),
                ("Transcribe".into(), 55),
                ("Transcribe".into(), 55),
                ("Transcribe".into(), 72),
                ("Transcribe".into(), 88),
                ("Clean".into(), 90),
                ("Done".into(), 100),
            ]
        );
        // The "Input: ... Clean ..." echo is a log line, not a 90% jump.
        assert_eq!(ev[1]["event"], "forge.log");
        assert_eq!(ev[1]["line"], "Input: Clean Bandit - Symphony.mp3");
        let done = ev.last().unwrap();
        assert_eq!(done["event"], "forge.done");
        assert_eq!(done["ok"], true);
        assert_eq!(done["result"]["midiPath"], r"C:\m\song.mid");
        assert_eq!(done["result"]["candidateCounts"]["clean"], 812);
        assert_eq!(done["result"]["pipeline"], "piano");
        assert!(p.exit(Some(0), false).is_empty(), "DONE already finalized");
    }

    #[test]
    fn transcribe_py_keywords_and_monotonic_percent() {
        // Captured from a live run of this host (transcribe.py, piano +
        // skip separation, TRANSCRIBE_BACKEND=cpu, 2026-10-21): stdout and the
        // Transkun grandchild's stderr warnings, as the pump split them.
        let mut p = JobParser::new("job-1", STAGES_2, "x.mid", json!({}));
        let ev = feed(&mut p, &[
            "Backend: cpu",
            "Normalizing to -20.0 dB RMS -> forge-clip_norm.wav",
            "Transcribing with Transkun V2: forge-clip.wav",
            "import pkg_resources",
            "return fn(*args, **kwargs)",
            "check_backward_validity(args)",
            "done in 23.7s",
            "MIDI cleanup: 16 -> 16 notes (dropped 0); velocity gamma 0.85",
            "DONE. MIDI: C:\\scratch\\forge-live\\in\\forge-clip.mid",
        ]);
        let pr: Vec<(String, i64)> =
            ev.iter().filter(|e| e["event"] == "forge.progress").map(|e| (e["stage"].as_str().unwrap().into(), e["percent"].as_i64().unwrap())).collect();
        assert_eq!(pr, vec![("Transcribing".into(), 50), ("Transcribing".into(), 60), ("Cleaning".into(), 90), ("Done".into(), 100)]);
        let logs: Vec<&str> = ev.iter().filter(|e| e["event"] == "forge.log").map(|e| e["line"].as_str().unwrap()).collect();
        assert_eq!(logs, vec!["Backend: cpu", "import pkg_resources", "return fn(*args, **kwargs)", "check_backward_validity(args)", "done in 23.7s"]);
        let mut p = JobParser::new("job-3", STAGES_2, "x.mid", json!({}));
        let ev = feed(&mut p, &["[2/2] Cleaning", "Separating again?"]);
        assert_eq!(ev[1]["percent"], 90, "the bar never walks backwards");
        assert_eq!(ev[1]["stage"], "Separating");
    }

    #[test]
    fn failures_report_causes() {
        let mut p = JobParser::new("job-4", STAGES_2, "x.mid", json!({}));
        feed(&mut p, &[
            "Backend: cpu",
            "Traceback (most recent call last):",
            "  File \"transcribe.py\", line 27, in <module>",
            "ModuleNotFoundError: No module named 'pretty_midi'",
        ]);
        let ev = p.exit(Some(1), false);
        assert_eq!(ev[0]["ok"], false);
        assert_eq!(ev[0]["error"], "Traceback (most recent call last):\nModuleNotFoundError: No module named 'pretty_midi'\n(exit code 1)");
        let mut p = JobParser::new("job-5", STAGES_2, "x.mid", json!({}));
        feed(&mut p, &["a", "b", "c", "d", "e"]);
        assert_eq!(p.exit(Some(3), false)[0]["error"], "b\nc\nd\ne\n(exit code 3)");
        assert_eq!(JobParser::new("j", STAGES_2, "x", json!({})).exit(Some(2), false)[0]["error"], "exit code 2");
        assert_eq!(JobParser::new("j", STAGES_2, "x", json!({})).exit(Some(1), true)[0]["error"], "cancelled");
        assert_eq!(JobParser::new("j", STAGES_2, "x", json!({})).exit(Some(0), false)[0]["error"], "finished without producing output");
        let mut p = JobParser::new("j", STAGES_2, "x", json!({}));
        let ev = p.line("RESULT|{not json");
        assert_eq!(ev[0]["level"], "error");
        let ev = p.line("RuntimeError: CUDA out of memory");
        assert_eq!(ev[0]["level"], "error");
    }

    #[test]
    fn forge_rs_pipeline_lines() {
        // forge-rs pipeline's own stdout for a piano job (CUDA), in order.
        let mut p = JobParser::new("job-7", STAGES_3, r"C:\m\song.mid", json!({"pipeline": "piano", "engine": "rust"}));
        let ev = feed(&mut p, &[
            "Device: cuda (NVIDIA GeForce RTX 5060)",
            "Input: song.wav",
            "Engine: forge-rs, ONNX Runtime 1.22 (C:\\fe\\ort-gpu\\onnxruntime.dll), fp32, CUDA (TF32 off)",
            "[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem, batch 2)",
            "separator ready in 2.1s on cuda (fp32, model cache hit)",
            "SSEG|1|4",
            "SSEG|4|4",
            "separation done in 9.0s",
            "using piano stem -> piano.wav",
            "Normalizing stem to -20.0 dB RMS (peak ceiling -1.0 dB)",
            "[2/3] Transcribing with Transkun V2 (SOTA piano MIDI), cuda",
            "TSEG|1|3",
            "TSEG|3|3",
            "done in 1.2s",
            "[3/3] Cleaning MIDI (drop notes < 0.03s or velocity < 20); velocity gamma 0.85",
            "90 -> 88 notes (dropped 2)",
            "DONE.",
        ]);
        let pr: Vec<(String, i64)> =
            ev.iter().filter(|e| e["event"] == "forge.progress").map(|e| (e["stage"].as_str().unwrap().into(), e["percent"].as_i64().unwrap())).collect();
        assert_eq!(
            pr,
            vec![
                ("Separate".into(), 15),
                ("Separating".into(), 18),
                ("Separate".into(), 25),
                ("Separate".into(), 53),
                ("Separating".into(), 53),
                ("Transcribing".into(), 53),
                ("Transcribe".into(), 55),
                ("Transcribe".into(), 66),
                ("Transcribe".into(), 88),
                ("Clean".into(), 90),
                ("Done".into(), 100),
            ]
        );
        let done = ev.last().unwrap();
        assert_eq!(done["result"]["engine"], "rust");
        assert_eq!(done["result"]["midiPath"], r"C:\m\song.mid");
        // A table without a Separate stage ignores SSEG.
        let mut p = JobParser::new("j", STAGES_2, "x", json!({}));
        assert!(p.line("SSEG|1|2").is_empty());
    }

    #[test]
    fn rust_engine_routing() {
        let env = |pairs: &[(&str, &str)]| {
            let mut e = EnvMap::default();
            for (k, v) in pairs {
                e.set(k, v);
            }
            e
        };
        for m in ["piano", "general", "melody", "drums", "fast"] {
            assert_eq!(rust_blocker(m, &env(&[]), false), None, "{m}");
            assert_eq!(rust_blocker(m, &env(&[]), true), None, "{m} skip");
        }
        assert_eq!(rust_blocker("general", &env(&[("USE_TTA", "0"), ("BIGSHIFTS", "1"), ("SEGMENT_SIZE", "16")]), false), None);
        assert!(rust_blocker("stems", &env(&[]), false).is_some(), "not a Forge mode");
        assert!(rust_blocker("piano", &env(&[("USE_TTA", "1")]), false).is_some());
        assert!(rust_blocker("piano", &env(&[("BIGSHIFTS", "3")]), false).is_some());
        assert!(rust_blocker("piano", &env(&[("SEGMENT_SIZE", "12")]), false).is_some());
        assert!(rust_blocker("piano", &env(&[("SEGMENT_SIZE", "12")]), true).is_some(), "transcribe.py runs Transkun too");
        assert!(rust_blocker("general", &env(&[("SEPARATION_BACKEND", "ONNX_DML")]), false).is_some());
        assert!(rust_blocker("melody", &env(&[("USE_TTA", "1")]), false).is_some());
        assert!(rust_blocker("drums", &env(&[("SEPARATION_BACKEND", "onnx_dml")]), false).is_some());
        // Knobs a job does not use do not send it to Python.
        assert_eq!(rust_blocker("melody", &env(&[("SEGMENT_SIZE", "12")]), false), None);
        assert_eq!(rust_blocker("fast", &env(&[("USE_TTA", "1"), ("BIGSHIFTS", "3")]), false), None);
        assert_eq!(rust_blocker("drums", &env(&[("USE_TTA", "1"), ("SKIP_SEPARATION", "1")]), false), None);
        assert_eq!(rust_blocker("piano", &env(&[("USE_TTA", "1")]), true), None);
        // What the Advanced panel sends becomes these env values.
        let adv = json!({"USE_TTA": true});
        let e = job_env(EnvMap::default(), &json!({}), false, &adv, None, None, "piano", false);
        assert!(rust_blocker("piano", &e, false).is_some());
        let e = job_env(EnvMap::default(), &json!({}), false, &json!({"USE_TTA": false, "SEGMENT_HOP": "4"}), None, None, "piano", false);
        assert_eq!(rust_blocker("piano", &e, false), None);
        let e = job_env(EnvMap::default(), &json!({}), false, &adv, None, None, "melody", true);
        assert_eq!(rust_blocker("melody", &e, true), None, "a skipped separation ignores its knobs");
    }

    #[test]
    fn melody_separation_walks_isolate_lead() {
        let mut p = JobParser::new("j", STAGES_4, "x.mid", json!({}));
        let ev = feed(&mut p, &["[1/4] Isolating pitched lead material", "SSEG|2|4", "SSEG|4|4", "[2/4] Detecting instrument-agnostic pitches"]);
        let pr: Vec<(String, i64)> = ev.iter().map(|e| (e["stage"].as_str().unwrap().into(), e["percent"].as_i64().unwrap())).collect();
        assert_eq!(pr, vec![("Isolate lead".into(), 12), ("Isolate lead".into(), 29), ("Isolate lead".into(), 46), ("Detect melody".into(), 48)]);
    }

    #[test]
    fn forge_rs_melody_result_and_done() {
        let mut p = JobParser::new("j", STAGES_4, r"C:\m\s.mid", json!({"pipeline": "melody", "engine": "rust"}));
        let ev = feed(&mut p, &[
            r#"RESULT|{"midiPath": "C:\\m\\s.mid", "candidates": {"clean": "C:\\m\\s.mid", "balanced": "C:\\m\\s_balanced.mid", "detailed": "C:\\m\\s_detailed.mid"}, "candidateCounts": {"clean": 3, "balanced": 4, "detailed": 5}, "sourceAudio": "C:\\m\\s.wav", "previewAudio": "C:\\m\\s.wav", "pipeline": "melody"}"#,
            "DONE.",
        ]);
        let done = ev.last().unwrap();
        assert_eq!(done["event"], "forge.done");
        assert_eq!(done["result"]["candidateCounts"]["detailed"], 5);
        assert_eq!(done["result"]["engine"], "rust");
        // The sparse-piano check's own DONE line is prefixed and only a log line.
        let mut p = JobParser::new("j", STAGES_3, "x.mid", json!({}));
        let ev = p.line("basic-pitch: DONE. MIDI: C:\\w\\fallback_basic_pitch.mid");
        assert_eq!(ev[0]["event"], "forge.log");
    }

    #[test]
    fn melody_stages_and_tseg_without_transcribe() {
        let mut p = JobParser::new("j", STAGES_4, "x.mid", json!({}));
        let ev = feed(&mut p, &["[1/4] Isolating pitched lead material", "TSEG|1|2", "[4/4] Preparing review"]);
        assert_eq!(ev.len(), 2, "no Transcribe stage in this table, TSEG says nothing");
        assert_eq!(ev[0]["stage"], "Isolate lead");
        assert_eq!(ev[1]["percent"], 94);
    }

    #[test]
    fn yt_lines() {
        let mut p = YtParser::new("yt-1");
        let ev = p.line("[download]  45.3% of    3.21MiB at    1.20MiB/s ETA 00:01");
        assert_eq!(ev[0]["percent"], 45);
        assert_eq!(p.line("[download] 100% of 3.21MiB")[0]["percent"], 99);
        assert_eq!(p.line("[download]   0.4% of 3.21MiB")[0]["percent"], 5);
        assert_eq!(p.line("[ExtractAudio] Destination: x.mp3")[0]["event"], "forge.log");
        assert_eq!(p.line("DONE.")[0]["event"], "forge.log");
        let ev = p.line("DOWNLOADED: C:\\Users\\me\\Music\\Song.mp3");
        assert_eq!(ev[1]["result"]["downloadedPath"], "C:\\Users\\me\\Music\\Song.mp3");
        assert!(p.exit(Some(0), false).is_empty());
        assert!(p.line("DOWNLOADED: duplicate.mp3").is_empty());
        assert_eq!(YtParser::new("y").exit(Some(1), false)[0]["error"], "exit code 1");
    }

    #[test]
    fn yt_failure_keeps_site_error_and_hint() {
        let mut p = YtParser::new("yt-1");
        let ev = p.line("ERROR: [MuseScore] Unable to download metadata: HTTP Error 404");
        assert_eq!(ev[0]["level"], "error");
        p.line("[ERROR] DownloadError: HTTP Error 404");
        p.line("Hint: Update the downloader in Forge setup and retry.");
        p.line("Output folder: C:\\music");
        let ev = p.exit(Some(1), false);
        let error = ev[0]["error"].as_str().unwrap();
        assert!(error.contains("[MuseScore]") && error.contains("HTTP Error 404") && error.contains("Hint:"));
        assert!(!error.contains("Output folder"));
        assert!(error.ends_with("(exit code 1)"));
        assert!(p.exit(Some(1), false).is_empty());
    }

    #[test]
    fn yt_failure_keeps_bounded_recent_diagnostics() {
        let mut p = YtParser::new("y");
        for n in 0..30 {
            p.line(&format!("ERROR: attempt {n} {}", "声".repeat(400)));
        }
        p.line("Hint: The latest actionable hint.");
        assert_eq!(p.causes.len(), 6);
        assert_eq!(p.recent.len(), 4);
        let error = p.exit(Some(1), false)[0]["error"].as_str().unwrap().to_string();
        assert!(error.chars().count() <= 914);
        assert!(error.contains("attempt 29") && error.contains("latest actionable hint"));
        let mut p = YtParser::new("y");
        for n in 0..10 { p.line(&format!("diagnostic {n}")); }
        let error = p.exit(Some(2), false)[0]["error"].as_str().unwrap().to_string();
        assert!(error.contains("diagnostic 9") && !error.contains("diagnostic 0"));
    }

    #[test]
    fn yt_cancel_and_missing_output_finish_once() {
        let mut p = YtParser::new("y");
        p.line("ERROR: failed network request");
        assert_eq!(p.exit(Some(1), true)[0]["error"], "cancelled");
        assert!(p.exit(Some(1), true).is_empty());
        let mut p = YtParser::new("y");
        p.line("DOWNLOADED:   ");
        assert_eq!(p.exit(Some(0), false)[0]["error"], "finished without producing output");
        assert!(p.line("DOWNLOADED: late.mp3").is_empty());
    }

    #[test]
    fn yt_cancel_discards_buffered_success_and_late_progress() {
        let mut parser = YtParser::new("y");
        let cancelled = AtomicBool::new(false);
        let mut pump = Pump::default();
        let mut events = Vec::new();
        pump.feed(b"DOWNLOADED: song.mp3", |line| events.extend(active_line(&mut parser, line, &cancelled)));
        assert!(events.is_empty());
        cancelled.store(true, Ordering::SeqCst);
        pump.finish(|line| events.extend(active_line(&mut parser, line, &cancelled)));
        assert!(active_line(&mut parser, "[download] 100%", &cancelled).is_empty());
        assert!(active_line(&mut parser, "DOWNLOADED: late.mp3", &cancelled).is_empty());
        assert!(events.is_empty());
        let done = parser.exit(Some(0), true);
        assert_eq!(done[0]["error"], "cancelled");
        assert!(parser.exit(Some(0), true).is_empty());
    }

    #[test]
    fn yt_success_before_cancel_stays_finalized() {
        let mut parser = YtParser::new("y");
        let cancelled = AtomicBool::new(false);
        let events = active_line(&mut parser, "DOWNLOADED: song.mp3", &cancelled);
        assert_eq!(events[1]["ok"], true);
        cancelled.store(true, Ordering::SeqCst);
        assert!(parser.exit(Some(0), true).is_empty());
    }

    #[test]
    fn rust_on_cpu_with_an_nvidia_card_stays_on_python() {
        assert_eq!(cpu_blocker(&json!({"ep": "cuda", "whyCpu": ""})), None);
        assert_eq!(cpu_blocker(&json!({"ep": "cpu", "whyCpu": "no NVIDIA driver"})), None);
        let why = cpu_blocker(&json!({"ep": "cpu", "whyCpu": "onnxruntime-gpu 1.22 not found"})).unwrap();
        assert!(why.contains("would run on the CPU") && why.contains("onnxruntime-gpu"), "{why}");
    }

    #[test]
    fn scripts_and_output_paths() {
        assert_eq!(select_script("expressive", true).0, "forge-rs");
        assert_eq!(select_script("melody", true).0, "melody_to_midi.py");
        assert_eq!(select_script("fast", true).0, "stem_to_midi.py");
        assert_eq!(select_script("piano", true).0, "transcribe.py");
        assert_eq!(select_script("piano", false).0, "song_to_midi.py");
        assert_eq!(select_script("general", false).0, "song_to_midi.py");
        assert_eq!(select_script("drums", true).0, "drums_to_midi.py");
        assert_eq!(output_midi_path(r"C:\a\song.mp3", None, None, ""), r"C:\a\song.mid");
        assert_eq!(output_midi_path(r"C:\a\song.mp3", Some(1.5), None, ""), r"C:\a\song_range_1p5_end.mid");
        assert_eq!(output_midi_path(r"C:\a\song.mp3", None, Some(10.0), ""), r"C:\a\song_range_0_10.mid");
        assert_eq!(output_midi_path(r"C:\a\song.mp3", Some(0.1234), Some(2.0), ""), r"C:\a\song_range_0p123_2.mid");
        assert_eq!(output_midi_path(r"C:\a\song.mp3", None, None, " My: Take?.MID "), r"C:\a\My Take.mid");
        assert_eq!(output_midi_path(r"C:\a.b\song", None, None, ""), r"C:\a.b\song.mid");
        assert_eq!(parse_time_seconds(Some(&json!(""))), None);
        assert_eq!(parse_time_seconds(Some(&json!("2.5"))), Some(2.5));
        assert_eq!(parse_time_seconds(Some(&json!(-1))), None);
        assert_eq!(parse_time_seconds(Some(&json!("x"))), None);
        assert_eq!(parse_time_seconds(None), None);
    }

    #[test]
    fn env_construction() {
        let mut base = EnvMap::default();
        base.set("OMP_NUM_THREADS", "7");
        let perf = json!({"batch": 2, "threads": 12, "lowPriority": false});
        let adv = json!({"USE_TTA": false, "LOUDNESS_NORM": true, "SEGMENT_HOP": "", "VELOCITY_GAMMA": "0.85", "BIGSHIFTS": 1, "X": null});
        let e = job_env(base.clone(), &perf, false, &adv, Some(1.0), Some(9.5), "general", false);
        assert_eq!(e.get("OMP_NUM_THREADS"), Some("7"), "a value the host already has wins");
        assert_eq!(e.get("MKL_NUM_THREADS"), Some("12"));
        assert_eq!(e.get("SEPARATION_BATCH"), Some("2"));
        assert_eq!(e.get("OMP_WAIT_POLICY"), Some("PASSIVE"));
        assert_eq!(e.get("KMP_BLOCKTIME"), Some("0"));
        assert_eq!(e.get("USE_TTA"), Some("0"));
        assert_eq!(e.get("LOUDNESS_NORM"), Some("1"));
        assert_eq!(e.get("SEGMENT_HOP"), None);
        assert_eq!(e.get("BIGSHIFTS"), Some("1"));
        assert_eq!(e.get("X"), None);
        assert_eq!(e.get("FORGE_START_SEC"), Some("1"));
        assert_eq!(e.get("FORGE_END_SEC"), Some("9.5"));
        assert_eq!(e.get("GENERAL_MODE"), Some("1"));
        assert_eq!(e.get("SKIP_SEPARATION"), None);
        let bg = job_env(EnvMap::default(), &perf, true, &json!({}), None, None, "melody", true);
        assert_eq!(bg.get("OMP_NUM_THREADS"), Some("6"), "halved in the background");
        assert_eq!(bg.get("TRANSCRIBE_BATCH"), Some("1"));
        assert_eq!(bg.get("SKIP_SEPARATION"), Some("1"));
        assert_eq!(bg.get("FORGE_START_SEC"), None);
        let d = job_env(EnvMap::default(), &json!({}), false, &json!({}), None, None, "piano", true);
        assert_eq!((d.get("OMP_NUM_THREADS"), d.get("SEPARATION_BATCH")), (Some("4"), Some("2")));
        // An explicit override in Advanced beats the policy default.
        let o = job_env(EnvMap::default(), &perf, false, &json!({"OMP_WAIT_POLICY": "ACTIVE"}), None, None, "piano", true);
        assert_eq!(o.get("OMP_WAIT_POLICY"), Some("ACTIVE"));
    }

    #[test]
    fn probe_verdicts() {
        let out = "some warning\n{\"torch\": true, \"cuda\": false, \"dml\": true, \"gpu\": \"AMD (ONNX + DirectML)\", \"transkun\": true, \"basic_pitch\": true, \"yt_dlp\": false}\n";
        let v = probe_verdict(out, json!("py"), true);
        assert_eq!(v["forgeReady"], true);
        assert_eq!(v["gpu"], "AMD (ONNX + DirectML)");
        assert_eq!(v["missing"], json!(["yt-dlp"]));
        let v = probe_verdict("", json!("py"), true);
        assert_eq!(v["forgeReady"], false);
        assert_eq!(v["missing"], json!(["torch"]));
        let v = probe_verdict("{\"torch\": true}", json!("py"), false);
        assert_eq!(v["forgeReady"], false, "torch without the .ready marker is not ready");
    }

    #[test]
    fn rust_verdict_follows_the_ep() {
        let cpu = rust_verdict(&json!({"ready": true, "ep": "cpu"}), json!("py"), || panic!("a CPU verdict names no card"));
        assert_eq!(cpu["forgeReady"], true);
        assert_eq!(cpu["gpu"], Value::Null, "the UI says CPU");
        assert_eq!(cpu["missing"], json!([]));
        let cuda = rust_verdict(&json!({"ready": true, "ep": "cuda"}), json!("py"), || Some("NVIDIA GeForce RTX 5060".into()));
        assert_eq!(cuda["gpu"], "NVIDIA GeForce RTX 5060 (CUDA)");
        assert_eq!(rust_verdict(&json!({"ep": "cuda"}), json!(null), || None)["gpu"], "NVIDIA GPU (CUDA)");
        assert!(!cuda["gpu"].as_str().unwrap().contains("DirectML"));
    }

    #[test]
    fn pid_file_round_trip() {
        let f = std::env::temp_dir().join(format!("ms-forge-pids-{}.json", std::process::id()));
        std::fs::write(&f, "[12168, \"junk\"]").unwrap();
        assert_eq!(read_pids(&f), vec![12168]);
        track_pid(&f, 5);
        track_pid(&f, 5);
        assert_eq!(read_pids(&f), vec![12168, 5]);
        untrack_pid(&f, 12168);
        assert_eq!(read_pids(&f), vec![5]);
        // A pid that is not an interpreter is forgotten, never killed.
        std::fs::write(&f, format!("[{}]", std::process::id())).unwrap();
        assert_eq!(reap_orphans(&f), 0);
        assert!(read_pids(&f).is_empty());
        let _ = std::fs::remove_file(&f);
    }
}
