// library.rs: electron/library.js, ported. Finds every MIDI the user has and
// remembers what it learned, in the SAME library-index.json the Electron
// build writes, keyed and valued the same way, so a user moving across keeps
// their tags, play counts and the cached lengths and note counts.
//
// The scan is electron/library.js's contract unchanged: the Forge output
// folder plus the Documents folder plus any folder the user added, breadth
// first, depth 4, cap 4000, the skip set, X_balanced / X_detailed folded into
// their primary X, partial batches every 70 ms or 250 files so the Library tab
// paints as it fills, and ONE coalesced walk shared by every caller (one
// finished Forge job makes every frame re-list at once).
//
// What Electron did with e.senderFrame, the bridge now does with a
// tauri::ipc::Channel created per call by the frame that asked: library-progress
// reaches that frame and no other. library-changed is still a broadcast, and
// Host::push drops the cached scan whenever one goes out.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Number, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{allow_dir, paths, Host, MAIN};

const MAX_DEPTH: usize = 4;
pub const MAX_FILES: usize = 4000;
const SKIP: [&str; 6] = ["node_modules", ".git", "forge-env", "MIDI Studio Forge", "pip-cache", "__pycache__"];
const STAT_BATCH: usize = 48;
const BATCH_MS: u128 = 70;
const BATCH_FILES: usize = 250;
const FRESH: Duration = Duration::from_millis(2000);
const PARSE_CAP: usize = 32;
const ROLL_NOTES: usize = 2200;
const INDEX_V: i64 = 1;
const USAGE_EVENTS: usize = 24;
const PLAY_KINDS: [&str; 3] = ["player", "selfmidi", "preview"];
const SAVE_DELAY: Duration = Duration::from_millis(800);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ===========================================================================
// JavaScript's spellings of strings, numbers and paths
// ===========================================================================

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// A JS number as JSON: integral values print as integers, like JSON.stringify.
fn jnum(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        json!(x as i64)
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// String(v || '').
fn js_str(v: &Value) -> String {
    match v {
        _ if !js_truthy(v) => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), |f| jnum(f).to_string()),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_str(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        Value::Null => String::new(),
    }
}

/// Number(v), NaN as None.
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(t)) => {
            let t = t.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// Number(v) || 0.
fn num_or_zero(v: Option<&Value>) -> f64 {
    let n = js_number(v);
    if n.is_nan() {
        0.0
    } else {
        n
    }
}

/// Math.round: the nearest integer, ties towards +infinity, exactly.
fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

fn round3(x: f64) -> f64 {
    js_round(x * 1000.0) / 1000.0
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn ends_with_ci(s: &str, suffix: &str) -> Option<usize> {
    let cut = s.len().checked_sub(suffix.len())?;
    (s.is_char_boundary(cut) && s[cut..].eq_ignore_ascii_case(suffix)).then_some(cut)
}

/// /\.midi?$/i, as the index of the match.
fn midi_suffix(name: &str) -> Option<usize> {
    ends_with_ci(name, ".mid").or_else(|| ends_with_ci(name, ".midi"))
}

fn strip_midi(name: &str) -> &str {
    midi_suffix(name).map_or(name, |i| &name[..i])
}

/// /_(balanced|detailed)$/i, as the index of the match.
fn candidate_suffix(name: &str) -> Option<usize> {
    ends_with_ci(name, "_balanced").or_else(|| ends_with_ci(name, "_detailed"))
}

fn strip_candidate(name: &str) -> &str {
    candidate_suffix(name).map_or(name, |i| &name[..i])
}

/// path.parse(p).root for an absolute Windows path: "C:\" or "\\server\share\".
fn path_root(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        return if b.len() >= 3 && (b[2] == b'\\' || b[2] == b'/') { s[..3].to_string() } else { s[..2].to_string() };
    }
    if s.starts_with("\\\\") || s.starts_with("//") {
        let rest = &s[2..];
        let mut parts = rest.splitn(3, ['\\', '/']);
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        if !server.is_empty() && !share.is_empty() {
            return format!("\\\\{server}\\{share}\\");
        }
    }
    if s.starts_with('\\') || s.starts_with('/') {
        return "\\".into();
    }
    String::new()
}

/// Node's path.resolve on Windows: absolute, backslashes, no trailing
/// separator except on a root.
pub fn resolve(p: &str) -> String {
    let abs = std::path::absolute(if p.is_empty() { Path::new(".") } else { Path::new(p) })
        .map(|a| a.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
        .replace('/', "\\");
    let root = path_root(&abs).len();
    let mut s = abs;
    while s.len() > root.max(1) && s.ends_with('\\') {
        s.pop();
    }
    s
}

/// path.join(dir, name) for a resolved dir and a bare file name.
fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') || dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}\\{name}")
    }
}

fn dirname(p: &str) -> String {
    Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|| ".".into())
}

fn basename(p: &str) -> &str {
    p.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("")
}

/// fs.Stats.mtimeMs: libuv's (sec, nsec) folded the way Node folds them, so
/// a value read back from an Electron-written index compares equal.
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    let Ok(t) = meta.modified() else { return 0.0 };
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => {
            let d = e.duration();
            let (sec, nsec) = if d.subsec_nanos() == 0 {
                (-(d.as_secs() as f64), 0.0)
            } else {
                (-(d.as_secs() as f64) - 1.0, f64::from(1_000_000_000 - d.subsec_nanos()))
            };
            sec * 1e3 + nsec / 1e6
        }
    }
}

// ===========================================================================
// THE SCAN
// ===========================================================================

#[derive(Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub size: u64,
    pub modified: f64,
    pub source: Option<&'static str>,
    pub has_audio: Option<bool>,
}

impl FileEntry {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("path".into(), json!(self.path));
        o.insert("name".into(), json!(self.name));
        o.insert("dir".into(), json!(self.dir));
        o.insert("size".into(), json!(self.size));
        o.insert("modified".into(), jnum(self.modified));
        if let Some(s) = self.source {
            o.insert("source".into(), json!(s));
        }
        if let Some(a) = self.has_audio {
            o.insert("hasAudio".into(), json!(a));
        }
        Value::Object(o)
    }
}

fn files_json(files: &[FileEntry]) -> Value {
    Value::Array(files.iter().map(FileEntry::to_json).collect())
}

fn norm_roots(list: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in list.iter().filter(|r| !r.is_empty()) {
        let abs = resolve(r);
        if seen.insert(lower(&abs)) {
            out.push(abs);
        }
    }
    out
}

fn signature(roots: &[String]) -> String {
    lower(&norm_roots(roots).join("|"))
}

/// One entry per path, melody candidates folded into a primary that exists,
/// newest first (stable, like Array.prototype.sort).
fn shape(found: Vec<FileEntry>) -> (Vec<FileEntry>, bool) {
    let truncated = found.len() >= MAX_FILES;
    let mut seen = HashSet::new();
    let unique: Vec<FileEntry> = found.into_iter().filter(|f| seen.insert(lower(&f.path))).collect();
    let primaries: HashSet<String> = unique.iter().map(|f| lower(&join(&f.dir, &f.name))).collect();
    let mut files: Vec<FileEntry> = unique
        .into_iter()
        .filter(|f| match candidate_suffix(&f.name) {
            None => true,
            Some(i) => !primaries.contains(&lower(&join(&f.dir, &f.name[..i]))),
        })
        .collect();
    files.sort_by(|a, b| b.modified.partial_cmp(&a.modified).unwrap_or(std::cmp::Ordering::Equal));
    (files, truncated)
}

/// libuv's dirent type on Windows: ANY reparse point is a link (so neither
/// walked into nor counted as a directory), then the directory bit.
#[derive(PartialEq)]
enum Dirent {
    Dir,
    Other,
}

fn dirent_type(e: &std::fs::DirEntry) -> Dirent {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(m) = e.metadata() {
            let a = m.file_attributes();
            return if a & 0x400 != 0 {
                Dirent::Other
            } else if a & 0x10 != 0 {
                Dirent::Dir
            } else {
                Dirent::Other
            };
        }
        Dirent::Other
    }
    #[cfg(not(windows))]
    {
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            Dirent::Dir
        } else {
            Dirent::Other
        }
    }
}

struct Walk {
    found: Vec<FileEntry>,
    sidecars: HashSet<String>,
}

/// Breadth first over an explicit queue, with a partial batch handed to
/// on_batch every BATCH_MS or BATCH_FILES.
fn walk(roots: &[String], on_batch: &mut dyn FnMut(&[FileEntry])) -> Walk {
    let mut found: Vec<FileEntry> = Vec::new();
    let mut known: HashSet<String> = HashSet::new();
    let mut sidecars = HashSet::new();
    let mut queue: VecDeque<(String, usize)> = norm_roots(roots).into_iter().map(|d| (d, 0)).collect();
    let mut seen_dir: HashSet<String> = queue.iter().map(|(d, _)| lower(d)).collect();
    let mut pending: Vec<FileEntry> = Vec::new();
    let mut last_flush = Instant::now();

    let mut flush = |pending: &mut Vec<FileEntry>, known: &HashSet<String>, last: &mut Instant, force: bool| {
        if pending.is_empty() || (!force && pending.len() < BATCH_FILES && last.elapsed().as_millis() < BATCH_MS) {
            return;
        }
        let out: Vec<FileEntry> = pending
            .drain(..)
            .filter(|f| match candidate_suffix(&f.name) {
                None => true,
                Some(i) => !known.contains(&lower(&join(&f.dir, &f.name[..i]))),
            })
            .collect();
        *last = Instant::now();
        if !out.is_empty() {
            on_batch(&out);
        }
    };

    while let Some((dir, depth)) = queue.pop_front() {
        if found.len() >= MAX_FILES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut midis = Vec::new();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if dirent_type(&e) == Dirent::Dir {
                if name.starts_with('.') || SKIP.contains(&name.as_str()) || depth + 1 > MAX_DEPTH {
                    continue;
                }
                let full = join(&dir, &name);
                if seen_dir.insert(lower(&full)) {
                    queue.push_back((full, depth + 1));
                }
            } else if midi_suffix(&name).is_some() {
                midis.push(name);
            } else if let Some(i) = ends_with_ci(&name, ".midstudio.json") {
                sidecars.insert(lower(&join(&dir, &name[..i])));
            }
        }
        for chunk in midis.chunks(STAT_BATCH) {
            if found.len() >= MAX_FILES {
                break;
            }
            for n in chunk {
                if found.len() >= MAX_FILES {
                    break;
                }
                let full = join(&dir, n);
                let Ok(st) = std::fs::metadata(&full) else { continue };
                if !st.is_file() {
                    continue;
                }
                let file = FileEntry {
                    name: strip_midi(n).to_string(),
                    dir: dir.clone(),
                    size: st.len(),
                    modified: mtime_ms(&st),
                    path: full,
                    source: None,
                    has_audio: None,
                };
                known.insert(lower(&join(&file.dir, &file.name)));
                found.push(file.clone());
                pending.push(file);
            }
            flush(&mut pending, &known, &mut last_flush, false);
        }
        flush(&mut pending, &known, &mut last_flush, false);
    }
    flush(&mut pending, &known, &mut last_flush, true);
    Walk { found, sidecars }
}

fn sidecar_key(dir: &str, stem: &str) -> String {
    lower(&join(dir, stem))
}

fn sidecar_of(f: &FileEntry, sidecars: &HashSet<String>) -> bool {
    sidecars.contains(&sidecar_key(&f.dir, &f.name)) || sidecars.contains(&sidecar_key(&f.dir, strip_candidate(&f.name)))
}

/// Source is derived, never parsed: a sidecar or the program output folder
/// means Forge made it, a folder the user added means Imported.
fn with_source(files: &mut [FileEntry], sidecars: &HashSet<String>, dirs: &[String], extra: &[String]) {
    let output = dirs.first().filter(|d| !d.is_empty()).map(|d| lower(&resolve(d))).unwrap_or_default();
    let extra: Vec<String> = norm_roots(extra).iter().map(|d| lower(d)).collect();
    let under = |dir: &str, root: &str| dir == root || dir.starts_with(&format!("{root}\\"));
    for f in files.iter_mut() {
        let has = sidecar_of(f, sidecars);
        let dir = lower(&f.dir);
        let source = if has || (!output.is_empty() && under(&dir, &output)) {
            "generated"
        } else if extra.iter().any(|x| under(&dir, x)) {
            "imported"
        } else {
            "library"
        };
        f.source = Some(source);
        f.has_audio = Some(has);
    }
}

// ===========================================================================
// THE MIDI PARSER (library.js parseMidi: note count, length, a thumbnail)
// ===========================================================================

pub struct Parsed {
    pub notes: u64,
    pub duration: f64,
    pub bpm: Option<f64>,
    pub roll: Option<Vec<[f64; 3]>>,
    pub sampled: bool,
}

/// readVarInt: at most four bytes, never past the buffer.
fn read_var(buf: &[u8], pos: usize) -> (u32, usize) {
    let mut v: u32 = 0;
    let mut i = pos;
    for _ in 0..4 {
        let Some(&b) = buf.get(i) else { return (v, i) };
        i += 1;
        v = (v << 7) | u32::from(b & 0x7f);
        if b & 0x80 == 0 {
            break;
        }
    }
    (v, i)
}

fn ascii_eq(buf: &[u8], at: usize, want: &[u8; 4]) -> bool {
    // Buffer.toString('ascii') drops the high bit.
    buf.get(at..at + 4).is_some_and(|s| s.iter().zip(want).all(|(a, b)| a & 0x7f == *b))
}

fn u32_be(buf: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
}

pub fn parse_midi(buf: &[u8], want_roll: bool) -> Option<Parsed> {
    if buf.len() < 14 || !ascii_eq(buf, 0, b"MThd") {
        return None;
    }
    let header_len = u32_be(buf, 4) as usize;
    let division = i16::from_be_bytes([buf[12], buf[13]]);
    let mut pos = 8usize.saturating_add(header_len);

    let mut tempos: Vec<(f64, u32)> = Vec::new();
    struct N {
        tick: f64,
        end: f64,
        pitch: u8,
    }
    let mut notes: Vec<N> = Vec::new();
    let mut note_ons = 0u64;
    let mut last_tick = 0f64;
    let at = |p: usize| buf.get(p).copied();

    while pos.saturating_add(8) <= buf.len() {
        let is_trk = ascii_eq(buf, pos, b"MTrk");
        let len = u32_be(buf, pos + 4) as usize;
        let start = pos + 8;
        let end = buf.len().min(start.saturating_add(len));
        pos = start.saturating_add(len);
        if !is_trk {
            continue;
        }
        let mut p = start;
        let mut tick = 0f64;
        let mut running = 0u8;
        let mut open: HashMap<u16, usize> = HashMap::new();
        while p < end {
            let (delta, np) = read_var(buf, p);
            p = np;
            tick += f64::from(delta);
            if p >= end {
                break;
            }
            let mut status = buf[p];
            if status & 0x80 != 0 {
                p += 1;
                if status < 0xf0 {
                    running = status;
                }
            } else {
                status = running;
            }
            if status == 0 {
                break;
            }
            let kind = status & 0xf0;
            if status == 0xff {
                let meta = at(p);
                p += 1;
                let (mlen, np) = read_var(buf, p);
                p = np;
                if meta == Some(0x51) && mlen >= 3 && p + 3 <= end {
                    tempos.push((tick, (u32::from(buf[p]) << 16) | (u32::from(buf[p + 1]) << 8) | u32::from(buf[p + 2])));
                }
                p = p.saturating_add(mlen as usize);
            } else if status == 0xf0 || status == 0xf7 {
                let (slen, np) = read_var(buf, p);
                p = np.saturating_add(slen as usize);
            } else if kind == 0x90 || kind == 0x80 {
                let pitch = at(p).unwrap_or(0) & 0x7f;
                let vel = at(p + 1).unwrap_or(0) & 0x7f;
                p += 2;
                let key = (u16::from(status & 0x0f) << 8) | u16::from(pitch);
                if kind == 0x90 && vel > 0 {
                    note_ons += 1;
                    let idx = notes.len();
                    notes.push(N { tick, end: tick, pitch });
                    if let Some(prev) = open.get(&key).copied() {
                        notes[prev].end = notes[prev].end.max(tick);
                    }
                    open.insert(key, idx);
                } else if let Some(idx) = open.remove(&key) {
                    notes[idx].end = tick;
                }
            } else if kind == 0xc0 || kind == 0xd0 {
                p += 1;
            } else if kind == 0xa0 || kind == 0xb0 || kind == 0xe0 {
                p += 2;
            } else {
                break;
            }
            if tick > last_tick {
                last_tick = tick;
            }
        }
        for idx in open.values() {
            notes[*idx].end = notes[*idx].end.max(tick);
        }
    }

    // ticks -> seconds
    let bpm;
    let to_seconds: Box<dyn Fn(f64) -> f64> = if division < 0 {
        let frames = -(i32::from(division) >> 8);
        let per_frame = i32::from(division) & 0xff;
        let per_tick = if frames > 0 && per_frame > 0 { 1.0 / f64::from(frames * per_frame) } else { 1.0 / 480.0 };
        bpm = None;
        Box::new(move |t| t * per_tick)
    } else {
        let ppq = if division > 0 { f64::from(division) } else { 480.0 };
        tempos.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        // (tick, sec, seconds per tick)
        let mut segs: Vec<(f64, f64, f64)> = vec![(0.0, 0.0, 500000.0 / 1e6 / ppq)];
        for (t, us) in &tempos {
            let last = segs.last_mut().expect("seeded");
            if *t <= last.0 {
                last.2 = f64::from(*us) / 1e6 / ppq;
                continue;
            }
            let (lt, ls, lspt) = *last;
            segs.push((*t, ls + (t - lt) * lspt, f64::from(*us) / 1e6 / ppq));
        }
        let first = tempos.first().map_or(500000.0, |t| f64::from(t.1));
        let b = js_round((6e7 / first) * 10.0) / 10.0;
        bpm = b.is_finite().then_some(b);
        Box::new(move |tick| {
            let (mut lo, mut hi) = (0usize, segs.len() - 1);
            while lo < hi {
                let mid = (lo + hi + 1) >> 1;
                if segs[mid].0 <= tick {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            let s = segs[lo];
            s.1 + (tick - s.0) * s.2
        })
    };

    let mut end_tick = last_tick;
    for n in &notes {
        if n.end > end_tick {
            end_tick = n.end;
        }
    }
    let duration = round3(to_seconds(end_tick));
    let mut out = Parsed { notes: note_ons, duration, bpm, roll: None, sampled: false };
    if want_roll {
        let step = if notes.len() > ROLL_NOTES { notes.len().div_ceil(ROLL_NOTES) } else { 1 };
        let roll = notes
            .iter()
            .step_by(step)
            .map(|n| {
                let s = to_seconds(n.tick);
                let e = to_seconds(n.end.max(n.tick + 1.0));
                [round3(s), round3(e - s).max(0.01), f64::from(n.pitch)]
            })
            .collect();
        out.roll = Some(roll);
        out.sampled = step > 1;
    }
    Some(out)
}

// ===========================================================================
// THE PERSISTED INDEX (metadata cache + tags + usage) and the shared scan
// ===========================================================================

struct Store {
    files: Map<String, Value>,
    tags: Map<String, Value>,
    usage: Map<String, Value>,
}

type Listener = Box<dyn Fn(&[FileEntry]) + Send>;

struct Job {
    sig: String,
    listeners: Mutex<Vec<Listener>>,
    result: Mutex<Option<Arc<Listing>>>,
    cv: Condvar,
}

impl Job {
    fn wait(&self) -> Arc<Listing> {
        let mut r = lock(&self.result);
        loop {
            if let Some(l) = r.as_ref() {
                return l.clone();
            }
            r = self.cv.wait(r).unwrap_or_else(|e| e.into_inner());
        }
    }
}

pub struct Listing {
    pub files: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Default)]
struct ScanState {
    cache: Option<(String, Instant, Arc<Listing>)>,
    inflight: Option<Arc<Job>>,
}

pub struct Library {
    file: PathBuf,
    store: Mutex<Option<Store>>,
    dirty: AtomicBool,
    save_scheduled: AtomicBool,
    scan: Mutex<ScanState>,
    index_job: Mutex<Option<Arc<AtomicBool>>>,
    scan_seq: AtomicU64,
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

impl Library {
    pub fn new(file: PathBuf) -> Arc<Library> {
        Arc::new(Library {
            file,
            store: Mutex::new(None),
            dirty: AtomicBool::new(false),
            save_scheduled: AtomicBool::new(false),
            scan: Mutex::new(ScanState::default()),
            index_job: Mutex::new(None),
            scan_seq: AtomicU64::new(0),
        })
    }

    /// The store, loaded on first use. Missing or corrupt rebuilds from
    /// nothing, which is always safe.
    fn with_store<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut g = lock(&self.store);
        let s = g.get_or_insert_with(|| {
            let parsed = std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            match parsed.filter(|p| p.get("v").and_then(Value::as_i64) == Some(INDEX_V)) {
                Some(p) => Store { files: obj(p.get("files")), tags: obj(p.get("tags")), usage: obj(p.get("usage")) },
                None => Store { files: Map::new(), tags: Map::new(), usage: Map::new() },
            }
        });
        f(s)
    }

    /// Temp file + rename, so a crash mid-write cannot leave half a document.
    fn write_now(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let text = self.with_store(|s| {
            let mut o = Map::new();
            o.insert("v".into(), json!(INDEX_V));
            o.insert("files".into(), Value::Object(s.files.clone()));
            o.insert("tags".into(), Value::Object(s.tags.clone()));
            o.insert("usage".into(), Value::Object(s.usage.clone()));
            serde_json::to_string(&Value::Object(o)).unwrap_or_default()
        });
        let mut tmp = self.file.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        if let Some(d) = self.file.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, &self.file)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    fn save_soon(self: &Arc<Self>) {
        self.dirty.store(true, Ordering::SeqCst);
        if self.save_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        let spawned = std::thread::Builder::new().name("library-index-write".into()).spawn(move || {
            std::thread::sleep(SAVE_DELAY);
            me.save_scheduled.store(false, Ordering::SeqCst);
            me.write_now();
        });
        if spawned.is_err() {
            self.save_scheduled.store(false, Ordering::SeqCst);
            self.write_now();
        }
    }

    pub fn flush(&self) {
        self.write_now();
    }

    pub fn invalidate(&self) {
        lock(&self.scan).cache = None;
    }

    // ---- the one shared, coalesced scan --------------------------------------
    pub fn cached_scan(self: &Arc<Self>, roots: &[String], extra: &[String], listener: Option<Listener>) -> Arc<Listing> {
        let sig = signature(roots);
        let job = {
            let mut st = lock(&self.scan);
            if let Some((s, at, l)) = &st.cache {
                if *s == sig && at.elapsed() < FRESH {
                    return l.clone();
                }
            }
            if let Some(j) = st.inflight.as_ref().filter(|j| j.sig == sig).cloned() {
                if let Some(l) = listener {
                    lock(&j.listeners).push(l);
                }
                drop(st);
                return j.wait();
            }
            let j = Arc::new(Job { sig: sig.clone(), listeners: Mutex::new(listener.into_iter().collect()), result: Mutex::new(None), cv: Condvar::new() });
            st.inflight = Some(j.clone());
            j
        };
        let w = walk(roots, &mut |batch| {
            for l in lock(&job.listeners).iter() {
                l(batch);
            }
        });
        let (mut files, truncated) = shape(w.found);
        with_source(&mut files, &w.sidecars, roots, extra);
        self.reconcile(&files);
        let listing = Arc::new(Listing { files, truncated });
        {
            let mut st = lock(&self.scan);
            st.cache = Some((sig, Instant::now(), listing.clone()));
            if st.inflight.as_ref().is_some_and(|j| Arc::ptr_eq(j, &job)) {
                st.inflight = None;
            }
        }
        *lock(&job.result) = Some(listing.clone());
        job.cv.notify_all();
        listing
    }

    /// A scan is also when we learn what is gone. Tags and usage are USER data
    /// and are never pruned here: a removable drive coming back must not have
    /// lost them.
    fn reconcile(self: &Arc<Self>, files: &[FileEntry]) {
        let changed = self.with_store(|s| {
            let live: HashMap<String, &FileEntry> = files.iter().map(|f| (lower(&f.path), f)).collect();
            let before = s.files.len();
            s.files.retain(|k, e| match live.get(k) {
                None => false,
                Some(f) => entry_matches(e, f.modified, f.size as f64),
            });
            s.files.len() != before
        });
        if changed {
            self.save_soon();
        }
    }

    fn meta_of(&self, path: &str, modified: f64, size: f64) -> Option<Value> {
        self.with_store(|s| s.files.get(&lower(path)).filter(|e| entry_matches(e, modified, size)).cloned())
    }

    fn parse_into(self: &Arc<Self>, path: &str, modified: f64, size: f64) -> Value {
        let entry = match std::fs::read(path).ok().and_then(|b| parse_midi(&b, false)) {
            Some(p) => json!({"m": jnum(modified), "s": jnum(size), "n": p.notes, "d": jnum(p.duration), "bpm": p.bpm.map_or(Value::Null, jnum)}),
            None => json!({"m": jnum(modified), "s": jnum(size), "bad": 1}),
        };
        self.with_store(|s| s.files.insert(lower(path), entry.clone()));
        self.save_soon();
        entry
    }

    pub fn meta_for(self: &Arc<Self>, requests: &Value, roll: &Value) -> Value {
        let mut out = Map::new();
        for req in requests.as_array().map(|a| &a[..a.len().min(PARSE_CAP)]).unwrap_or(&[]) {
            let Some(p) = req.get("path").filter(|p| js_truthy(p)) else { continue };
            let path = js_str(p);
            let modified = num_or_zero(req.get("modified"));
            let size = num_or_zero(req.get("size"));
            let e = self.meta_of(&path, modified, size).unwrap_or_else(|| self.parse_into(&path, modified, size));
            let v = if e.get("bad").is_some_and(js_truthy) {
                json!({"bad": true})
            } else {
                json!({"notes": e.get("n").cloned().unwrap_or(Value::Null), "duration": e.get("d").cloned().unwrap_or(Value::Null), "bpm": e.get("bpm").cloned().unwrap_or(Value::Null)})
            };
            out.insert(path, v);
        }
        let mut result = Map::new();
        result.insert("meta".into(), Value::Object(out));
        if js_truthy(roll) {
            result.insert("roll".into(), roll_for(&js_str(roll)));
        }
        Value::Object(result)
    }

    // ---- the background full index -------------------------------------------
    pub fn index_running(&self) -> bool {
        lock(&self.index_job).is_some()
    }

    pub fn start_index(self: &Arc<Self>, files: &[FileEntry], report: impl Fn(Value) + Send + 'static) -> Value {
        let cancel = {
            let mut g = lock(&self.index_job);
            if g.is_some() {
                return json!({"ok": false, "running": true});
            }
            let todo: Vec<FileEntry> = files.iter().filter(|f| self.meta_of(&f.path, f.modified, f.size as f64).is_none()).cloned().collect();
            if todo.is_empty() {
                report(json!({"done": true, "indexed": 0, "total": 0}));
                return json!({"ok": true, "total": 0});
            }
            let cancel = Arc::new(AtomicBool::new(false));
            *g = Some(cancel.clone());
            (cancel, todo)
        };
        let (cancel, todo) = cancel;
        let total = todo.len();
        let me = self.clone();
        std::thread::spawn(move || {
            let mut n = 0usize;
            let mut last: Option<Instant> = None;
            for f in &todo {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                me.parse_into(&f.path, f.modified, f.size as f64);
                n += 1;
                if last.is_none_or(|t| t.elapsed() > Duration::from_millis(180)) || n == total {
                    last = Some(Instant::now());
                    report(json!({"indexed": n, "total": total, "done": false}));
                }
            }
            *lock(&me.index_job) = None;
            me.flush();
            report(json!({"indexed": n, "total": total, "done": true, "cancelled": cancel.load(Ordering::SeqCst)}));
        });
        json!({"ok": true, "total": total})
    }

    pub fn cancel_index(&self) -> Value {
        if let Some(c) = lock(&self.index_job).as_ref() {
            c.store(true, Ordering::SeqCst);
        }
        json!({"ok": true})
    }

    // ---- tags and usage --------------------------------------------------------
    pub fn set_tags(self: &Arc<Self>, file: &Value, tags: &Value) -> Value {
        let key = lower(&js_str(file));
        let mut clean: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for raw in tags.as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let s = js_str(raw);
            let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            // .slice(0, 32) counts UTF-16 units.
            let mut units = 0;
            let t: String = t
                .chars()
                .take_while(|c| {
                    units += c.len_utf16();
                    units <= 32
                })
                .collect();
            if t.is_empty() || !seen.insert(lower(&t)) {
                continue;
            }
            clean.push(t);
            if clean.len() >= 12 {
                break;
            }
        }
        self.with_store(|s| {
            if clean.is_empty() {
                s.tags.shift_remove(&key);
            } else {
                s.tags.insert(key.clone(), json!(clean));
            }
        });
        self.save_soon();
        json!(clean)
    }

    pub fn record_usage(self: &Arc<Self>, file: &Value, kind: &Value, at: &Value) -> Value {
        let key = lower(&js_str(file));
        let k = lower(&js_str(kind));
        if key.is_empty() || k.is_empty() {
            return Value::Null;
        }
        let t = {
            let n = js_number(Some(at));
            if n.is_nan() || n == 0.0 {
                now_ms()
            } else {
                n
            }
        };
        let u = self.with_store(|s| {
            let u = s.usage.entry(key.clone()).or_insert_with(|| json!({"c": 0, "l": 0, "e": []}));
            if !js_truthy(u) || !u.is_object() {
                *u = json!({"c": 0, "l": 0, "e": []});
            }
            let o = u.as_object_mut().expect("object");
            if PLAY_KINDS.contains(&k.as_str()) {
                let c = num_or_zero(o.get("c")) + 1.0;
                o.insert("c".into(), jnum(c));
                o.insert("l".into(), jnum(t));
            }
            if !o.get("e").is_some_and(Value::is_array) {
                o.insert("e".into(), json!([]));
            }
            let e = o.get_mut("e").and_then(Value::as_array_mut).expect("array");
            e.insert(0, json!({"k": k, "t": jnum(t)}));
            e.truncate(USAGE_EVENTS);
            u.clone()
        });
        self.save_soon();
        u
    }

    pub fn user_state(&self) -> (Value, Value) {
        self.with_store(|s| (Value::Object(s.tags.clone()), Value::Object(s.usage.clone())))
    }

    pub fn next_scan_id(&self) -> u64 {
        self.scan_seq.fetch_add(1, Ordering::SeqCst) + 1
    }
}

fn entry_matches(e: &Value, modified: f64, size: f64) -> bool {
    e.get("m").and_then(Value::as_f64) == Some(modified) && e.get("s").and_then(Value::as_f64) == Some(size)
}

/// The inspector's thumbnail plus what the Forge sidecar knows about where
/// the file came from. One file, on selection, never a list.
fn roll_for(target: &str) -> Value {
    if target.is_empty() {
        return Value::Null;
    }
    let mut out = Map::new();
    out.insert("path".into(), json!(target));
    if let Some(p) = std::fs::read(target).ok().and_then(|b| parse_midi(&b, true)) {
        out.insert("notes".into(), json!(p.notes));
        out.insert("duration".into(), jnum(p.duration));
        out.insert("bpm".into(), p.bpm.map_or(Value::Null, jnum));
        out.insert("roll".into(), Value::Array(p.roll.unwrap_or_default().iter().map(|r| json!([jnum(r[0]), jnum(r[1]), jnum(r[2])])).collect()));
        out.insert("sampled".into(), json!(p.sampled));
    }
    let stem = strip_candidate(strip_midi(basename(target)));
    let project = join(&dirname(target), &format!("{stem}.midstudio.json"));
    if let Some(doc) = std::fs::read_to_string(&project).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        out.insert("projectPath".into(), json!(project));
        if !doc.is_null() {
            let field = |k: &str| doc.get(k).filter(|v| js_truthy(v)).cloned();
            out.insert("previewAudio".into(), field("previewAudio").or_else(|| field("sourceAudio")).unwrap_or(json!("")));
            for k in ["sourceAudio", "pipeline", "createdAt"] {
                out.insert(k.into(), field(k).unwrap_or(json!("")));
            }
        }
    }
    Value::Object(out)
}

/// The drive the folder lives on: what the user actually thinks in.
fn storage_for(dir: &str) -> Value {
    let root = path_root(&resolve(dir));
    let probe = if !dir.is_empty() && Path::new(dir).exists() { dir.to_string() } else { root.clone() };
    match disk_space(&probe) {
        Some((total, free)) => json!({"root": root, "totalBytes": total, "freeBytes": free, "usedBytes": total.saturating_sub(free)}),
        None => json!({"root": "", "totalBytes": null, "freeBytes": null, "usedBytes": null}),
    }
}

#[cfg(windows)]
fn disk_space(p: &str) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    if p.is_empty() {
        return None;
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(p).encode_wide().chain(std::iter::once(0)).collect();
    let (mut avail, mut total, mut free_all) = (0u64, 0u64, 0u64);
    // SAFETY: a NUL-terminated wide string and three valid out pointers.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free_all) };
    (ok != 0).then_some((total, avail))
}

#[cfg(not(windows))]
fn disk_space(_p: &str) -> Option<(u64, u64)> {
    None
}

// ===========================================================================
// THE IPC SURFACE (main.js's library:* handlers)
// ===========================================================================

static LIB: OnceLock<Arc<Library>> = OnceLock::new();

pub fn lib() -> &'static Arc<Library> {
    LIB.get_or_init(|| Library::new(paths::user_data_dir().join("library-index.json")))
}

/// Host::push calls this for every library-changed it sends.
pub fn invalidate() {
    if let Some(l) = LIB.get() {
        l.invalidate();
    }
}

pub fn flush() {
    if let Some(l) = LIB.get() {
        l.flush();
    }
}

fn extra_dirs(h: &Host) -> Vec<String> {
    h.settings.get("library.dirs").as_array().map_or_else(Vec::new, |a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect())
}

fn library_dirs(h: &Host) -> Vec<String> {
    let mut v = vec![
        paths::program_output_dir(&h.settings.get_str("forge.outputDir")).to_string_lossy().into_owned(),
        paths::home_dir().join("Documents").join("MIDI Studio").to_string_lossy().into_owned(),
    ];
    v.extend(extra_dirs(h));
    v
}

fn broadcast_changed(app: &AppHandle, dir: &str) {
    Host::push(app, "library-changed", json!(dir));
}

/// The library:* channels. None: not one of ours.
pub fn handle(app: &AppHandle, channel: &str, args: &[Value], progress: Option<Channel<Value>>) -> Option<Result<Value, String>> {
    const OURS: [&str; 9] = [
        "library:list", "library:scan", "library:meta", "library:setTags", "library:usage",
        "library:index", "library:delete", "library:addFolder", "library:removeFolder",
    ];
    if !OURS.contains(&channel) {
        return None;
    }
    let h: Arc<Host> = app.state::<Arc<Host>>().inner().clone();
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    let p = if a0.is_object() { a0.clone() } else { json!({}) };
    let l = lib();
    Some(Ok(match channel {
        "library:list" => {
            let (dirs, extra) = (library_dirs(&h), extra_dirs(&h));
            let r = l.cached_scan(&dirs, &extra, None);
            json!({"dirs": dirs, "extra": extra, "files": files_json(&r.files), "truncated": r.truncated})
        }
        "library:scan" => {
            let (dirs, extra) = (library_dirs(&h), extra_dirs(&h));
            let scan_id = l.next_scan_id();
            let listener: Option<Listener> = progress.map(|ch| -> Listener {
                Box::new(move |files: &[FileEntry]| {
                    let _ = ch.send(json!({"scanId": scan_id, "kind": "scan", "files": files_json(files)}));
                })
            });
            let r = l.cached_scan(&dirs, &extra, listener);
            let (tags, usage) = l.user_state();
            json!({
                "scanId": scan_id, "dirs": dirs, "extra": extra, "files": files_json(&r.files), "truncated": r.truncated,
                "storage": storage_for(&dirs[0]), "tags": tags, "usage": usage, "indexing": l.index_running(),
            })
        }
        "library:meta" => l.meta_for(p.get("paths").unwrap_or(&Value::Null), p.get("roll").unwrap_or(&Value::Null)),
        "library:setTags" => {
            let tags = l.set_tags(p.get("path").unwrap_or(&Value::Null), p.get("tags").unwrap_or(&Value::Null));
            json!({"ok": true, "tags": tags})
        }
        "library:usage" => {
            let u = l.record_usage(p.get("path").unwrap_or(&Value::Null), p.get("kind").unwrap_or(&Value::Null), p.get("at").unwrap_or(&Value::Null));
            json!({"ok": true, "usage": u})
        }
        "library:index" => {
            if p.get("cancel").is_some_and(js_truthy) {
                return Some(Ok(l.cancel_index()));
            }
            let r = l.cached_scan(&library_dirs(&h), &extra_dirs(&h), None);
            l.start_index(&r.files, move |msg: Value| {
                if let (Some(ch), Value::Object(m)) = (&progress, msg) {
                    let mut o = Map::new();
                    o.insert("kind".into(), json!("index"));
                    o.extend(m);
                    let _ = ch.send(Value::Object(o));
                }
            })
        }
        // The Recycle Bin, never straight off the disk: the Library is a file
        // manager for work the user cannot regenerate cheaply.
        "library:delete" => {
            let list: Vec<String> = p.get("paths").and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().map(js_str_any).filter(|f| !f.is_empty() && midi_suffix(f).is_some()).collect());
            let mut trashed = Vec::new();
            let mut failed = Vec::new();
            for f in list {
                match trash::delete(&f) {
                    Ok(()) => trashed.push(f),
                    Err(e) => failed.push(json!({"path": f, "error": e.to_string()})),
                }
            }
            if let Some(first) = trashed.first() {
                broadcast_changed(app, &dirname(first));
            }
            json!({"ok": failed.is_empty(), "trashed": trashed, "failed": failed})
        }
        "library:addFolder" => {
            let mut d = app.dialog().file().set_title("Add a folder of MIDI files");
            if let Some(w) = app.get_webview_window(MAIN) {
                d = d.set_parent(&w);
            }
            let Some(picked) = d.blocking_pick_folder().and_then(|p| p.into_path().ok()) else {
                return Some(Ok(json!({"ok": false, "canceled": true})));
            };
            let picked = resolve(&picked.to_string_lossy());
            allow_dir(app, Path::new(&picked));
            let mut extra = extra_dirs(&h);
            if !extra.iter().any(|d| lower(&resolve(d)) == lower(&picked)) {
                extra.push(picked.clone());
            }
            h.settings.merge(&json!({"library": {"dirs": extra}}));
            broadcast_changed(app, &picked);
            json!({"ok": true, "dir": picked})
        }
        "library:removeFolder" => {
            let raw = js_str(&a0);
            let target = lower(&resolve(&raw));
            let extra: Vec<String> = extra_dirs(&h).into_iter().filter(|d| lower(&resolve(d)) != target).collect();
            h.settings.merge(&json!({"library": {"dirs": extra}}));
            broadcast_changed(app, &raw);
            json!({"ok": true})
        }
        _ => unreachable!(),
    }))
}

/// String(f) for library:delete's .map(String): null becomes "null".
fn js_str_any(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        other if !js_truthy(other) => "0".into(),
        other => js_str(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-lib-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// tools/library-smoke.js's generator: n notes of 0x60 ticks each.
    fn midi(notes: usize) -> Vec<u8> {
        let mut trk = Vec::new();
        for i in 0..notes {
            trk.extend([0x00, 0x90, 60 + (i % 12) as u8, 0x64]);
            trk.extend([0x60, 0x80, 60 + (i % 12) as u8, 0x00]);
        }
        trk.extend([0x00, 0xff, 0x2f, 0x00]);
        let mut out = b"MThd".to_vec();
        out.extend(6u32.to_be_bytes());
        out.extend([0, 0, 0, 1]);
        out.extend(480i16.to_be_bytes());
        out.extend(b"MTrk");
        out.extend((trk.len() as u32).to_be_bytes());
        out.extend(trk);
        out
    }

    fn names(files: &[FileEntry]) -> Vec<String> {
        let mut v: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        v.sort();
        v
    }

    // tools/run-tests.js "candidate fold".
    #[test]
    fn candidates_fold_into_their_primary_and_orphans_stay() {
        let d = tmp("fold");
        for n in ["song_melody.mid", "song_melody_balanced.mid", "song_melody_detailed.mid", "orphan_detailed.mid", "piano.mid"] {
            std::fs::write(d.join(n), b"").unwrap();
        }
        let w = walk(&[d.to_string_lossy().into_owned()], &mut |_| {});
        let (files, truncated) = shape(w.found);
        assert_eq!(names(&files), vec!["orphan_detailed", "piano", "song_melody"]);
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn walk_honours_depth_skip_set_and_dedupe() {
        let d = tmp("walk");
        let mut deep = d.clone();
        for i in 0..6 {
            deep = deep.join(format!("l{i}"));
            std::fs::create_dir_all(&deep).unwrap();
            std::fs::write(deep.join(format!("at{}.mid", i + 1)), b"").unwrap();
        }
        for skip in ["node_modules", ".hidden", "MIDI Studio Forge"] {
            std::fs::create_dir_all(d.join(skip)).unwrap();
            std::fs::write(d.join(skip).join("no.mid"), b"").unwrap();
        }
        std::fs::write(d.join("top.MIDI"), b"").unwrap();
        std::fs::write(d.join("notes.txt"), b"").unwrap();
        let root = d.to_string_lossy().into_owned();
        // The same folder twice, once with a trailing separator.
        let w = walk(&[root.clone(), format!("{root}\\")], &mut |_| {});
        let (files, _) = shape(w.found);
        assert_eq!(names(&files), vec!["at1", "at2", "at3", "at4", "top"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn source_and_has_audio_come_from_sidecars_and_roots() {
        let d = tmp("source");
        let out = d.join("out");
        let added = d.join("added");
        let lib = d.join("lib");
        for x in [&out, &added, &lib] {
            std::fs::create_dir_all(x).unwrap();
        }
        std::fs::write(out.join("a.mid"), midi(2)).unwrap();
        std::fs::write(added.join("b.mid"), midi(2)).unwrap();
        std::fs::write(lib.join("forged.mid"), midi(2)).unwrap();
        std::fs::write(lib.join("forged.midstudio.json"), b"{}").unwrap();
        std::fs::write(lib.join("plain.mid"), midi(2)).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let roots = vec![s(&out), s(&lib), s(&added)];
        let w = walk(&roots, &mut |_| {});
        let (mut files, _) = shape(w.found);
        with_source(&mut files, &w.sidecars, &roots, &[s(&added)]);
        let by = |n: &str| files.iter().find(|f| f.name == n).unwrap().clone();
        assert_eq!(by("a").source, Some("generated"));
        assert_eq!(by("b").source, Some("imported"));
        assert_eq!(by("forged").source, Some("generated"));
        assert_eq!(by("forged").has_audio, Some(true));
        assert_eq!(by("plain").source, Some("library"));
        assert_eq!(by("plain").has_audio, Some(false));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn batches_stream_and_the_cache_coalesces() {
        let d = tmp("batch");
        for i in 0..300 {
            std::fs::write(d.join(format!("s{i}.mid")), b"").unwrap();
        }
        let l = Library::new(d.join("library-index.json"));
        let roots = vec![d.to_string_lossy().into_owned()];
        let got = Arc::new(Mutex::new(0usize));
        let g = got.clone();
        let r = l.cached_scan(&roots, &[], Some(Box::new(move |b: &[FileEntry]| *lock(&g) += b.len())));
        assert_eq!(r.files.len(), 300);
        assert_eq!(*lock(&got), 300, "every file arrives in some batch");
        // Fresh: the second call is the same listing, not a second walk.
        let again = l.cached_scan(&roots, &[], None);
        assert!(Arc::ptr_eq(&r, &again));
        l.invalidate();
        assert!(!Arc::ptr_eq(&r, &l.cached_scan(&roots, &[], None)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn concurrent_callers_share_one_walk() {
        let d = tmp("coalesce");
        for i in 0..200 {
            std::fs::write(d.join(format!("s{i}.mid")), b"").unwrap();
        }
        let l = Library::new(d.join("library-index.json"));
        let roots = vec![d.to_string_lossy().into_owned()];
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (l, roots) = (l.clone(), roots.clone());
                std::thread::spawn(move || l.cached_scan(&roots, &[], None))
            })
            .collect();
        let results: Vec<Arc<Listing>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(results.iter().all(|r| r.files.len() == 200));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parse_counts_notes_and_length() {
        let p = parse_midi(&midi(4), true).unwrap();
        assert_eq!(p.notes, 4);
        // 4 notes of 96 ticks at 480 ppq, 120 bpm: 0.4 s.
        assert_eq!(p.duration, 0.4);
        assert_eq!(p.bpm, Some(120.0));
        let roll = p.roll.unwrap();
        assert_eq!(roll.len(), 4);
        assert_eq!(roll[1], [0.1, 0.1, 61.0]);
        assert!(parse_midi(b"not a midi file at all", false).is_none());
    }

    #[test]
    fn index_survives_a_round_trip_in_electrons_shape() {
        let d = tmp("index");
        let f = d.join("song.mid");
        std::fs::write(&f, midi(3)).unwrap();
        let file = d.join("library-index.json");
        let l = Library::new(file.clone());
        let fp = f.to_string_lossy().into_owned();
        let st = std::fs::metadata(&f).unwrap();
        let (m, s) = (mtime_ms(&st), st.len() as f64);
        let r = l.meta_for(&json!([{"path": fp, "modified": m, "size": s}]), &Value::Null);
        assert_eq!(r["meta"][&fp]["notes"], json!(3));
        assert_eq!(l.set_tags(&json!(fp), &json!([" a ", "A", "b", "", null])), json!(["a", "b"]));
        let u = l.record_usage(&json!(fp), &json!("Player"), &json!(1234));
        assert_eq!(u, json!({"c": 1, "l": 1234, "e": [{"k": "player", "t": 1234}]}));
        l.flush();
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back["v"], json!(1));
        let key = lower(&fp);
        assert_eq!(back["files"][&key]["n"], json!(3));
        assert_eq!(back["files"][&key]["m"].as_f64(), Some(m));
        assert_eq!(back["tags"][&key], json!(["a", "b"]));
        // A fresh instance reads it back and does not re-parse.
        let l2 = Library::new(file.clone());
        assert!(l2.meta_of(&fp, m, s).is_some());
        assert!(l2.meta_of(&fp, m + 1.0, s).is_none(), "a moved mtime is stale");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn paths_resolve_like_node() {
        assert_eq!(resolve(r"C:\a\b\"), r"C:\a\b");
        assert_eq!(resolve("C:/a/./b/../c"), r"C:\a\c");
        assert_eq!(resolve(r"C:\"), r"C:\");
        assert_eq!(path_root(r"C:\x\y"), r"C:\");
        assert_eq!(path_root(r"\\srv\share\x"), r"\\srv\share\");
        assert_eq!(join(r"C:\", "a.mid"), r"C:\a.mid");
        assert_eq!(strip_candidate("x_melody_Balanced"), "x_melody");
        assert_eq!(strip_midi("x.MIDI"), "x");
    }

    #[test]
    fn js_round_ties_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(round3(96.9775), 96.978);
    }
}
