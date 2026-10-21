// midi_doc.rs: python-engine/midi_document.py, ported, so the Editor's load,
// project save and MIDI export no longer need a Python interpreter.
//
// THE CONTRACT IS MIDO'S, NOT THE SPEC'S. midi_document.py read files with
// mido 1.3 and every document the Editor has ever shown came out of that
// reader, so this one reproduces what mido does, construct for construct:
//
//   * running status survives meta events ("Meta messages don't set running
//     status") but IS armed by SysEx, System Common and Real Time bytes;
//   * merged playback order is a stable sort of every track's absolute ticks,
//     end_of_track messages are dropped and their delta folded into the next
//     message, and a single trailing end_of_track carries what is left;
//   * every merged delta is converted to seconds on its own
//     (tick * (tempo * 1e-6 / ticks_per_beat)) and SUMMED, because how a tick
//     interval is partitioned between messages changes the last bit of the
//     running total;
//   * python's round(x, n) is round-half-to-even on the exact binary value;
//   * the same files are refused: a malformed meta payload, a data byte over
//     127, a track that overruns its chunk, a type 2 file.
//
// midly is not used to READ for exactly that first reason: it clears running
// status on every meta event, which drops the notes of real files (it is the
// `running-status-meta` case in tools/run-tests.js). It does write: its
// encoder makes the same running-status choices mido's write_track makes, so
// the bytes are mido's bytes.
//
// Self-contained on purpose (serde_json and midly only): src/bin/midi-document.rs
// compiles this same file into the CLI the parity script drives.
#![allow(dead_code)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Number, Value};

const DEFAULT_TEMPO: u32 = 500_000;
const MAX_MESSAGE_LENGTH: u64 = 1_000_000;

// ===========================================================================
// python numerics
// ===========================================================================

/// python's round(x, n) for a float: correctly rounded, ties to even, on the
/// double's exact value. Rust's fixed-precision formatting is specified the
/// same way (exact value, ties to even), so the slow path is just that; the
/// fast path is the same answer for every value not within a hair of a tie.
pub fn py_round(x: f64, n: u32) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let s = 10f64.powi(n as i32);
    let y = x * s;
    // 2^38: below it half an ULP of y is under 5e-5, well inside the 1e-4
    // margin, so r is provably the correctly rounded integer.
    if y.abs() < 274_877_906_944.0 {
        let r = y.round();
        if 0.5 - (y - r).abs() > 1e-4 {
            return r / s;
        }
    }
    format!("{:.*}", n as usize, x).parse().unwrap_or(x)
}

/// python's round(x) with no ndigits: the nearest integer, ties to even.
fn py_round_int(x: f64) -> Result<i64, String> {
    if x.is_nan() {
        return Err("cannot convert float NaN to integer".into());
    }
    if x.is_infinite() {
        return Err("cannot convert float infinity to integer".into());
    }
    let r = x.round_ties_even();
    if r.abs() >= 9.2e18 {
        return Err("integer too large".into());
    }
    Ok(r as i64)
}

/// python's max(a, b): b only if it is strictly greater (so NaN never wins).
fn py_max(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

/// python's min(a, b): b only if it is strictly smaller.
fn py_min(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// python's float(v) for a JSON value.
fn py_float(v: &Value) -> Result<f64, String> {
    match v {
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::Number(n) => n.as_f64().ok_or_else(|| "bad number".to_string()),
        Value::String(s) => {
            let t = s.trim().replace('_', "");
            let low = t.to_ascii_lowercase();
            let body = low.trim_start_matches(['+', '-']);
            let neg = low.starts_with('-');
            if body == "inf" || body == "infinity" {
                return Ok(if neg { f64::NEG_INFINITY } else { f64::INFINITY });
            }
            if body == "nan" {
                return Ok(f64::NAN);
            }
            t.parse::<f64>().map_err(|_| format!("could not convert string to float: '{s}'"))
        }
        other => Err(format!("float() argument must be a string or a real number, not '{}'", type_name(other))),
    }
}

/// python's int(v) for a JSON value: floats truncate, strings must be integers.
fn py_int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Ok(i);
            }
            if let Some(u) = n.as_u64() {
                return i64::try_from(u).map_err(|_| "integer too large".to_string());
            }
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_nan() {
                return Err("cannot convert float NaN to integer".into());
            }
            if f.is_infinite() {
                return Err("cannot convert float infinity to integer".into());
            }
            Ok(f.trunc() as i64)
        }
        Value::String(s) => s
            .trim()
            .replace('_', "")
            .parse::<i64>()
            .map_err(|_| format!("invalid literal for int() with base 10: '{s}'")),
        other => Err(format!(
            "int() argument must be a string, a bytes-like object or a real number, not '{}'",
            type_name(other)
        )),
    }
}

/// python truthiness, for `x or default`.
fn py_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn float(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

// ===========================================================================
// paths, the way pathlib spells them
// ===========================================================================

/// pathlib's Path(p).stem, from the string it was given.
pub fn py_stem(p: &str) -> String {
    let trimmed = p.trim_end_matches(['\\', '/']);
    let name = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    // A drive-only remainder ("C:") has no name in pathlib.
    let name = if name.len() == 2 && name.ends_with(':') { "" } else { name };
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

/// str(Path(p).resolve()): the final, on-disk spelling, without the \\?\ prefix.
pub fn py_resolve(p: &Path) -> String {
    let strip = |s: String| -> String {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s
        }
    };
    match std::fs::canonicalize(p) {
        Ok(c) => strip(c.to_string_lossy().into_owned()),
        Err(_) => std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().into_owned(),
    }
}

// ===========================================================================
// THE READER (mido.MidiFile, as midi_document.py used it)
// ===========================================================================

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Other,
    NoteOn { ch: u8, note: u8, vel: u8 },
    NoteOff { ch: u8, note: u8 },
    Tempo(u32),
    Program { ch: u8, program: u8 },
    EndOfTrack,
}

struct Cursor<'a> {
    b: &'a [u8],
    p: usize,
}

const EOF: &str = "unexpected end of file (EOFError)";

impl Cursor<'_> {
    fn byte(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.p).ok_or(EOF)?;
        self.p += 1;
        Ok(v)
    }
    fn varint(&mut self) -> Result<u64, String> {
        let mut v: u64 = 0;
        loop {
            let b = self.byte()?;
            if v > (u64::MAX >> 7) {
                return Err("variable-length quantity too large".into());
            }
            v = (v << 7) | u64::from(b & 0x7f);
            if b < 0x80 {
                return Ok(v);
            }
        }
    }
    fn bytes(&mut self, n: u64) -> Result<&[u8], String> {
        if n > MAX_MESSAGE_LENGTH {
            return Err(format!("Message length {n} exceeds maximum length {MAX_MESSAGE_LENGTH}"));
        }
        let n = n as usize;
        if self.p + n > self.b.len() {
            self.p = self.b.len();
            return Err(EOF.into());
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn chunk_header(&mut self) -> Result<([u8; 4], u32), String> {
        if self.p + 8 > self.b.len() {
            return Err(EOF.into());
        }
        let h = &self.b[self.p..self.p + 8];
        self.p += 8;
        Ok(([h[0], h[1], h[2], h[3]], u32::from_be_bytes([h[4], h[5], h[6], h[7]])))
    }
}

fn data_byte_ok(bytes: &[u8]) -> Result<(), String> {
    if bytes.iter().any(|b| *b > 127) {
        return Err("data byte must be in range 0..127".into());
    }
    Ok(())
}

/// mido build_meta_message: the decoders that raise on a short or invalid payload.
fn meta_kind(meta_type: u8, data: &[u8]) -> Result<Kind, String> {
    let need = |n: usize| -> Result<(), String> {
        if data.len() < n {
            Err("list index out of range (malformed meta message)".into())
        } else {
            Ok(())
        }
    };
    match meta_type {
        0x00 if data.len() == 1 => need(2)?,
        0x20 => need(1)?,
        0x2f => return Ok(Kind::EndOfTrack),
        0x51 => {
            need(3)?;
            return Ok(Kind::Tempo((u32::from(data[0]) << 16) | (u32::from(data[1]) << 8) | u32::from(data[2])));
        }
        0x54 => {
            need(1)?;
            if data[0] >> 5 > 3 {
                return Err(format!("{} (bad SMPTE frame rate)", data[0] >> 5));
            }
            need(5)?;
        }
        0x58 => need(4)?,
        0x59 => {
            need(2)?;
            let key = data[0] as i8;
            let mode = data[1];
            if !(-7..=7).contains(&key) || mode > 1 {
                return Err(if key < 7 {
                    format!("Could not decode key with {} flats and mode {mode}", key.unsigned_abs())
                } else {
                    format!("Could not decode key with {key} sharps and mode {mode}")
                });
            }
        }
        _ => {}
    }
    Ok(Kind::Other)
}

/// mido SPEC_BY_STATUS lengths (status byte included) for non-SysEx statuses.
fn spec_length(status: u8) -> Option<usize> {
    match status {
        0x80..=0xbf | 0xe0..=0xef => Some(3),
        0xc0..=0xdf => Some(2),
        0xf1 | 0xf3 => Some(2),
        0xf2 => Some(3),
        0xf6 | 0xf8 | 0xfa | 0xfb | 0xfc | 0xfe | 0xff => Some(1),
        _ => None,
    }
}

/// mido read_message + Message.from_bytes.
fn channel_or_system(c: &mut Cursor, status: u8, peek: Option<u8>) -> Result<Kind, String> {
    let len = spec_length(status).ok_or_else(|| format!("undefined status byte 0x{status:02x}"))?;
    let want = len as i64 - 1 - i64::from(peek.is_some());
    let mut data: Vec<u8> = peek.into_iter().collect();
    if want > 0 {
        data.extend_from_slice(c.bytes(want as u64)?);
    }
    data_byte_ok(&data)?;
    // decode_message's length check, which the quarter_frame/songpos/pitchwheel
    // special cases skip.
    let special = matches!(status, 0xe0..=0xef | 0xf1 | 0xf2);
    if !special && data.len() != len - 1 {
        return Err("wrong number of bytes for message".into());
    }
    let ch = status & 0x0f;
    Ok(match status & 0xf0 {
        0x90 => Kind::NoteOn { ch, note: data[0], vel: data[1] },
        0x80 => Kind::NoteOff { ch, note: data[0] },
        0xc0 => Kind::Program { ch, program: data[0] },
        _ => Kind::Other,
    })
}

/// mido read_track: messages with their delta ticks.
fn read_track(c: &mut Cursor) -> Result<Vec<(u64, Kind)>, String> {
    let (name, size) = c.chunk_header()?;
    if &name != b"MTrk" {
        return Err("no MTrk header at start of track".into());
    }
    let start = c.p;
    let end = start + size as usize;
    let mut out = Vec::new();
    let mut last_status: Option<u8> = None;
    loop {
        if c.p == end {
            break;
        }
        // mido only stops on an EXACT match, so a message that overruns the
        // chunk keeps reading into whatever follows until the file runs out.
        if c.p > end {
            return Err(EOF.into());
        }
        let delta = c.varint()?;
        let mut status = c.byte()?;
        let mut peek = None;
        if status < 0x80 {
            peek = Some(status);
            status = last_status.ok_or("running status without last_status")?;
        } else if status != 0xff {
            last_status = Some(status);
        }
        let kind = if status == 0xff {
            let meta_type = c.byte()?;
            let len = c.varint()?;
            let data = c.bytes(len)?;
            meta_kind(meta_type, data)?
        } else if status == 0xf0 || status == 0xf7 {
            // A running-status SysEx drops the byte it peeked, as mido does.
            let len = c.varint()?;
            let mut data = c.bytes(len)?;
            if data.first() == Some(&0xf0) {
                data = &data[1..];
            }
            if data.last() == Some(&0xf7) {
                data = &data[..data.len() - 1];
            }
            data_byte_ok(data)?;
            Kind::Other
        } else {
            channel_or_system(c, status, peek)?
        };
        out.push((delta, kind));
    }
    Ok(out)
}

struct Parsed {
    ticks_per_beat: i16,
    /// The merged track: (delta ticks, kind), end_of_track folded away and
    /// one trailing end_of_track appended.
    merged: Vec<(u64, Kind)>,
}

fn parse(bytes: &[u8]) -> Result<Parsed, String> {
    let mut c = Cursor { b: bytes, p: 0 };
    let (name, size) = c.chunk_header()?;
    if &name != b"MThd" {
        return Err("MThd not found. Probably not a MIDI file".into());
    }
    let avail = (bytes.len() - c.p).min(size as usize);
    let header = &bytes[c.p..c.p + avail];
    c.p += avail;
    if header.len() < 6 {
        return Err(EOF.into());
    }
    let format = i16::from_be_bytes([header[0], header[1]]);
    let ntracks = i16::from_be_bytes([header[2], header[3]]);
    let ticks_per_beat = i16::from_be_bytes([header[4], header[5]]);

    let mut abs: Vec<(u64, Kind)> = Vec::new();
    for _ in 0..ntracks.max(0) {
        let mut now: u64 = 0;
        for (delta, kind) in read_track(&mut c)? {
            now = now.checked_add(delta).ok_or("track too long")?;
            abs.push((now, kind));
        }
    }
    if format == 2 {
        return Err("can't merge tracks in type 2 (asynchronous) file".into());
    }
    // merge_tracks: ONE stable sort by absolute tick over every track in order.
    abs.sort_by_key(|(t, _)| *t);
    let mut merged = Vec::with_capacity(abs.len() + 1);
    let mut prev = 0u64;
    let mut accum = 0u64;
    for (t, kind) in abs {
        let delta = t - prev;
        prev = t;
        if kind == Kind::EndOfTrack {
            accum += delta;
        } else {
            merged.push((accum + delta, kind));
            accum = 0;
        }
    }
    merged.push((accum, Kind::EndOfTrack));
    Ok(Parsed { ticks_per_beat, merged })
}

struct Note {
    pitch: u8,
    start: f64,
    end: f64,
    velocity: u8,
    channel: u8,
    unterminated: bool,
}

/// midi_document._bpm_from_onsets, rule for rule.
pub fn bpm_from_onsets(starts: &[f64], fallback: f64) -> f64 {
    let mut uniq: Vec<f64> = starts.iter().map(|s| py_round(*s, 4)).collect();
    uniq.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    uniq.dedup_by(|a, b| a == b);
    let mut gaps: Vec<f64> = uniq.windows(2).map(|w| w[1] - w[0]).filter(|g| (0.02..=2.0).contains(g)).collect();
    if gaps.len() < 6 {
        return fallback;
    }
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut bpm = 60.0 / (gaps[gaps.len() / 2] * 4.0);
    while bpm < 90.0 {
        bpm *= 2.0;
    }
    while bpm > 250.0 {
        bpm /= 2.0;
    }
    py_round(bpm, 2)
}

/// load_midi(path) from midi_document.py: the Editor's document.
pub fn load(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("[Errno 2] {e}: '{}'", path.display()))?;
    load_bytes(&bytes, &path.to_string_lossy(), &py_resolve(path))
}

/// The same, from bytes already in hand. `given` is the path as it was
/// passed (for `name`), `resolved` what `path` reports.
pub fn load_bytes(bytes: &[u8], given: &str, resolved: &str) -> Result<Value, String> {
    let parsed = parse(bytes)?;
    let tpb = f64::from(parsed.ticks_per_beat);
    let mut tempo = DEFAULT_TEMPO;
    let mut first_tempo = DEFAULT_TEMPO;
    let mut found_tempo = false;
    let mut time_sec = 0.0f64;
    // Insertion-ordered like python's dicts.
    let mut programs: Vec<(u8, u8)> = Vec::new();
    let mut active_keys: Vec<(u8, u8)> = Vec::new();
    let mut active: std::collections::HashMap<(u8, u8), std::collections::VecDeque<(f64, u8)>> = std::collections::HashMap::new();
    let mut notes: Vec<Note> = Vec::new();

    for (delta, kind) in &parsed.merged {
        if *delta > 0 {
            if parsed.ticks_per_beat == 0 {
                return Err("float division by zero".into());
            }
            // mido tick2second, in its exact operation order.
            let scale = f64::from(tempo) * 1e-6 / tpb;
            time_sec += *delta as f64 * scale;
        }
        match *kind {
            Kind::Tempo(t) => {
                if !found_tempo {
                    first_tempo = t;
                    found_tempo = true;
                }
                tempo = t;
            }
            Kind::Program { ch, program } => {
                if !programs.iter().any(|(c, _)| *c == ch) {
                    programs.push((ch, program));
                }
            }
            Kind::NoteOn { ch, note, vel } if vel > 0 => {
                let key = (ch, note);
                active
                    .entry(key)
                    .or_insert_with(|| {
                        active_keys.push(key);
                        std::collections::VecDeque::new()
                    })
                    .push_back((time_sec, vel));
            }
            Kind::NoteOn { ch, note, .. } | Kind::NoteOff { ch, note } => {
                if let Some((start, velocity)) = active.get_mut(&(ch, note)).and_then(|q| q.pop_front()) {
                    notes.push(Note {
                        pitch: note,
                        start: py_round(start, 6),
                        end: py_round(py_max(start + 0.01, time_sec), 6),
                        velocity,
                        channel: ch,
                        unterminated: false,
                    });
                }
            }
            _ => {}
        }
    }
    // A note whose note_off is missing is closed at the end of the file, in
    // the order python's dict met its key.
    for key in &active_keys {
        for (start, velocity) in active.get(key).into_iter().flatten() {
            notes.push(Note {
                pitch: key.1,
                start: py_round(*start, 6),
                end: py_round(py_max(start + 0.01, time_sec), 6),
                velocity: *velocity,
                channel: key.0,
                unterminated: true,
            });
        }
    }
    notes.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.pitch.cmp(&b.pitch))
    });

    let mut duration = time_sec;
    for n in &notes {
        if n.end > duration {
            duration = n.end;
        }
    }
    if first_tempo == 0 {
        return Err("float division by zero".into());
    }
    let estimated = !found_tempo;
    let mut bpm = py_round(60.0 * 1e6 / f64::from(first_tempo) * 4.0 / 4.0, 3);
    if estimated {
        let starts: Vec<f64> = notes.iter().map(|n| n.start).collect();
        bpm = bpm_from_onsets(&starts, bpm);
    }

    let mut prog = Map::new();
    for (c, p) in programs {
        prog.insert(c.to_string(), json!(p));
    }
    let notes: Vec<Value> = notes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let mut o = Map::new();
            o.insert("pitch".into(), json!(n.pitch));
            o.insert("start".into(), float(n.start));
            o.insert("end".into(), float(n.end));
            o.insert("velocity".into(), json!(n.velocity));
            o.insert("channel".into(), json!(n.channel));
            if n.unterminated {
                o.insert("unterminated".into(), json!(true));
            }
            o.insert("id".into(), json!(format!("n{}", i + 1)));
            Value::Object(o)
        })
        .collect();

    let mut doc = Map::new();
    doc.insert("path".into(), json!(resolved));
    doc.insert("name".into(), json!(py_stem(given)));
    doc.insert("bpm".into(), float(bpm));
    doc.insert("bpmEstimated".into(), json!(estimated));
    doc.insert("duration".into(), float(py_round(duration, 6)));
    doc.insert("programs".into(), Value::Object(prog));
    doc.insert("notes".into(), Value::Array(notes));
    Ok(Value::Object(doc))
}

// ===========================================================================
// THE WRITER (save_midi)
// ===========================================================================

fn get<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    o.get(k)
}

/// save_midi(path, document) to bytes: the .mid midi_document.py wrote.
pub fn encode(document: &Value) -> Result<Vec<u8>, String> {
    use midly::num::{u15, u24, u28, u4, u7};
    use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};

    let doc = document.as_object().ok_or_else(|| format!("'{}' object has no attribute 'get'", type_name(document)))?;
    let bpm_raw = match get(doc, "bpm") {
        Some(v) => py_float(v)?,
        None => 120.0,
    };
    let bpm = py_max(20.0, py_min(400.0, bpm_raw));
    const TICKS: u16 = 480;
    let tempo = py_round_int(60.0 * 1e6 / bpm * 4.0 / 4.0)?;
    let tempo_u = u32::try_from(tempo).map_err(|_| "tempo out of range".to_string())?;

    let programs = match get(doc, "programs") {
        Some(v) if py_truthy(v) => match v {
            Value::Object(o) => o.iter().map(|(c, p)| Ok((py_int(&json!(c))?, py_int(p)?))).collect::<Result<Vec<_>, String>>()?,
            other => return Err(format!("'{}' object has no attribute 'items'", type_name(other))),
        },
        _ => Vec::new(),
    };

    let empty = Vec::new();
    let notes = match get(doc, "notes") {
        None => &empty,
        Some(Value::Array(a)) => a,
        Some(other) => return Err(format!("'{}' object is not iterable as a note list", type_name(other))),
    };
    // (seconds, kind, pitch, velocity, channel); kind 1 = on, 0 = off.
    let mut events: Vec<(f64, u8, u8, u8, u8)> = Vec::with_capacity(notes.len() * 2);
    for note in notes {
        let n = note.as_object().ok_or_else(|| format!("'{}' object has no attribute 'get'", type_name(note)))?;
        let pitch = py_int(get(n, "pitch").unwrap_or(&json!(60)))?.clamp(0, 127) as u8;
        let velocity = py_int(get(n, "velocity").unwrap_or(&json!(96)))?.clamp(1, 127) as u8;
        let ch_v = get(n, "channel").filter(|v| py_truthy(v)).cloned().unwrap_or(json!(0));
        let channel = py_int(&ch_v)?.clamp(0, 15) as u8;
        let start = py_max(0.0, py_float(get(n, "start").unwrap_or(&json!(0)))?);
        let end_default = json!(start + 0.25);
        let end = py_max(start + 0.01, py_float(get(n, "end").unwrap_or(&end_default))?);
        events.push((start, 1, pitch, velocity, channel));
        events.push((end, 0, pitch, 0, channel));
    }
    events.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });

    let mut track: Vec<TrackEvent> = Vec::with_capacity(events.len() + 20);
    let meta = |m: MetaMessage<'static>| TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(m) };
    track.push(meta(MetaMessage::TrackName(b"MIDI Studio Review")));
    track.push(meta(MetaMessage::Tempo(u24::new(tempo_u))));
    let mut programs = programs;
    programs.sort_unstable();
    for (c, p) in programs {
        if (0..=15).contains(&c) && (0..=127).contains(&p) {
            track.push(TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Midi { channel: u4::new(c as u8), message: MidiMessage::ProgramChange { program: u7::new(p as u8) } },
            });
        }
    }
    // Deltas from absolute ticks, so rounding never accumulates.
    let scale = f64::from(tempo_u) * 1e-6 / f64::from(TICKS);
    let mut previous: i64 = 0;
    for (at, kind, pitch, velocity, channel) in events {
        let tick = py_round_int(at / scale)?;
        let delta = (tick - previous).max(0);
        previous = tick;
        if delta > i64::from(u32::from(u28::max_value())) {
            return Err("a note lies further out than a MIDI delta time can reach".into());
        }
        let message = if kind == 1 {
            MidiMessage::NoteOn { key: u7::new(pitch), vel: u7::new(velocity) }
        } else {
            MidiMessage::NoteOff { key: u7::new(pitch), vel: u7::new(0) }
        };
        track.push(TrackEvent { delta: u28::new(delta as u32), kind: TrackEventKind::Midi { channel: u4::new(channel), message } });
    }
    track.push(meta(MetaMessage::EndOfTrack));

    let smf = Smf { header: Header::new(Format::Parallel, Timing::Metrical(u15::new(TICKS))), tracks: vec![track] };
    let mut out = Vec::new();
    smf.write_std(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// save_midi: write beside the target and swap in, so a crash mid-write can't
/// leave a truncated MIDI where the song used to be.
pub fn save(path: &Path, document: &Value) -> Result<String, String> {
    let bytes = encode(document)?;
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut staging = path.as_os_str().to_owned();
    staging.push(".saving");
    let staging = PathBuf::from(staging);
    std::fs::write(&staging, &bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&staging, path) {
        let _ = std::fs::remove_file(&staging);
        return Err(e.to_string());
    }
    Ok(py_resolve(path))
}

// ===========================================================================
// python's json.dumps, byte for byte (for the parity CLI)
// ===========================================================================

/// repr(float): shortest round-trip digits, python's choice of notation.
pub fn py_float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let nd = digits.len() as i32;
    let decpt = exp + 1;
    if decpt <= -4 || decpt > 16 {
        let rest = &digits[1..];
        let m = if rest.is_empty() { digits[..1].to_string() } else { format!("{}.{}", &digits[..1], rest) };
        let ex = decpt - 1;
        return format!("{sign}{m}e{}{:02}", if ex < 0 { '-' } else { '+' }, ex.abs());
    }
    if decpt <= 0 {
        format!("{sign}0.{}{digits}", "0".repeat((-decpt) as usize))
    } else if decpt < nd {
        format!("{sign}{}.{}", &digits[..decpt as usize], &digits[decpt as usize..])
    } else {
        format!("{sign}{digits}{}.0", "0".repeat((decpt - nd) as usize))
    }
}

fn py_json_str(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// json.dumps(v, ensure_ascii=False): ", " and ": " separators.
pub fn py_json(v: &Value) -> String {
    fn go(v: &Value, out: &mut String) {
        match v {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => {
                if n.is_f64() {
                    out.push_str(&py_float_repr(n.as_f64().unwrap_or(0.0)));
                } else {
                    out.push_str(&n.to_string());
                }
            }
            Value::String(s) => py_json_str(s, out),
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    go(x, out);
                }
                out.push(']');
            }
            Value::Object(o) => {
                out.push('{');
                for (i, (k, x)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    py_json_str(k, out);
                    out.push_str(": ");
                    go(x, out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::new();
    go(v, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // tools/run-tests.js's own cases, every one taken from the interpreter.
    #[test]
    fn rounds_like_python() {
        let cases = [
            (76.1015625, 6, 76.101562),
            (76.1015635, 6, 76.101563),
            (42.8046875, 6, 42.804688),
            (0.1015625, 6, 0.101562),
            (100.0625, 3, 100.062),
            (100.0635, 3, 100.064),
            (0.5, 0, 0.0),
            (1.5, 0, 2.0),
            (2.5, 0, 2.0),
            (2.675, 2, 2.67),
        ];
        for (x, n, want) in cases {
            assert_eq!(py_round(x, n), want, "round({x}, {n})");
        }
        assert_eq!(py_round_int(2.5).unwrap(), 2);
        assert_eq!(py_round_int(3.5).unwrap(), 4);
        assert_eq!(py_round_int(-2.5).unwrap(), -2);
    }

    #[test]
    fn float_repr_matches_python() {
        let cases = [
            (1e-5, "1e-05"),
            (0.0001, "0.0001"),
            (1e16, "1e+16"),
            (1.5e16, "1.5e+16"),
            (1234567890123456.0, "1234567890123456.0"),
            (1788727397535.2617, "1788727397535.2617"),
            (0.1, "0.1"),
            (-0.0, "-0.0"),
            (120.0, "120.0"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ];
        for (x, want) in cases {
            assert_eq!(py_float_repr(x), want);
        }
    }

    #[test]
    fn stem_is_pathlibs() {
        assert_eq!(py_stem(r"C:\a\song.mid"), "song");
        assert_eq!(py_stem("C:/a/b.tar.gz"), "b.tar");
        assert_eq!(py_stem(r"C:\a\.hidden"), ".hidden");
        assert_eq!(py_stem(r"C:\a\x."), "x.");
    }

    fn vlq(mut n: u32) -> Vec<u8> {
        let mut out = vec![(n & 0x7f) as u8];
        n >>= 7;
        while n > 0 {
            out.insert(0, ((n & 0x7f) as u8) | 0x80);
            n >>= 7;
        }
        out
    }

    pub fn smf(format: u16, division: u16, tracks: &[Vec<(u32, Vec<u8>)>]) -> Vec<u8> {
        let mut out = b"MThd".to_vec();
        out.extend(6u32.to_be_bytes());
        out.extend(format.to_be_bytes());
        out.extend((tracks.len() as u16).to_be_bytes());
        out.extend(division.to_be_bytes());
        for t in tracks {
            let mut body = Vec::new();
            for (d, bytes) in t {
                body.extend(vlq(*d));
                body.extend(bytes);
            }
            body.extend([0, 0xff, 0x2f, 0]);
            out.extend(b"MTrk");
            out.extend((body.len() as u32).to_be_bytes());
            out.extend(body);
        }
        out
    }

    fn doc(bytes: &[u8]) -> Value {
        load_bytes(bytes, r"C:\x\t.mid", r"C:\x\t.mid").unwrap()
    }

    #[test]
    fn running_status_survives_a_meta_event() {
        let b = smf(0, 480, &[vec![
            (0, vec![0x90, 60, 100]),
            (0, vec![64, 100]),
            (0, vec![67, 100]),
            (0, vec![0xff, 0x06, 0x02, b'h', b'i']),
            (480, vec![60, 0]),
            (0, vec![64, 0]),
            (0, vec![67, 0]),
        ]]);
        let d = doc(&b);
        assert_eq!(d["notes"].as_array().unwrap().len(), 3);
        assert_eq!(d["notes"][0]["end"], json!(0.5));
        // ...which is exactly what midly gets wrong, and why it does not read.
        assert!(midly::Smf::parse(&b).map_or(true, |s| s.tracks[0].len() < 8));
    }

    #[test]
    fn unterminated_notes_are_kept_and_flagged() {
        let b = smf(0, 480, &[vec![(0, vec![0x90, 60, 100]), (240, vec![0x90, 64, 90]), (480, vec![0x80, 64, 0])]]);
        let d = doc(&b);
        let notes = d["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0]["unterminated"], json!(true));
        assert_eq!(notes[0]["end"], json!(0.75));
        assert_eq!(notes[1]["id"], json!("n2"));
        assert_eq!(d["bpmEstimated"], json!(true));
        assert_eq!(d["bpm"], json!(120.0));
    }

    #[test]
    fn trailing_silence_counts_towards_duration() {
        let b = smf(0, 480, &[vec![(0, vec![0x90, 60, 100]), (480, vec![0x80, 60, 0]), (960, vec![0xb0, 7, 100])]]);
        let d = doc(&b);
        assert_eq!(d["duration"], json!(1.5));
    }

    #[test]
    fn two_tracks_merge_with_tempo_and_programs() {
        let b = smf(1, 384, &[
            vec![
                (0, vec![0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]),
                (0, vec![0xc0, 0x18]),
                (0, vec![0x90, 60, 100]),
                (300, vec![0x80, 60, 0]),
                (100, vec![0xff, 0x51, 0x03, 0x05, 0x16, 0x15]),
                (0, vec![0x90, 62, 100]),
                (700, vec![0x80, 62, 0]),
            ],
            vec![(0, vec![0xc1, 0x30]), (150, vec![0x91, 67, 80]), (275, vec![0x81, 67, 0]), (13, vec![0x91, 69, 70]), (901, vec![0x81, 69, 0])],
        ]);
        let d = doc(&b);
        assert_eq!(d["notes"].as_array().unwrap().len(), 4);
        assert_eq!(d["programs"], json!({"0": 24, "1": 48}));
        assert_eq!(d["bpmEstimated"], json!(false));
        assert_eq!(d["bpm"], json!(120.0));
    }

    #[test]
    fn refuses_what_mido_refuses() {
        assert!(load_bytes(b"RIFF\0\0\0\0", "x", "x").is_err());
        assert!(load_bytes(&smf(2, 480, &[vec![(0, vec![0x90, 60, 100])]]), "x", "x").is_err());
        assert!(load_bytes(&smf(0, 480, &[vec![(0, vec![60, 100])]]), "x", "x").is_err());
        assert!(load_bytes(&smf(0, 480, &[vec![(0, vec![0xff, 0x51, 0x02, 1, 2])]]), "x", "x").is_err());
        assert!(load_bytes(&smf(0, 480, &[vec![(0, vec![0xff, 0x59, 0x02, 9, 0])]]), "x", "x").is_err());
    }

    #[test]
    fn save_writes_what_mido_wrote() {
        let d = json!({"bpm": 120, "programs": {"1": 5, "0": 3}, "notes": [
            {"pitch": 60, "start": 0.0, "end": 0.5, "velocity": 100, "channel": 0},
            {"pitch": 64, "start": 0.5, "end": 1.0, "velocity": 90, "channel": 0},
        ]});
        let bytes = encode(&d).unwrap();
        let want: Vec<u8> = [
            &b"MThd"[..], &[0, 0, 0, 6, 0, 1, 0, 1, 1, 0xe0], b"MTrk", &[0, 0, 0, 57],
            &[0, 0xff, 0x03, 18], b"MIDI Studio Review",
            &[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20],
            &[0, 0xc0, 3, 0, 0xc1, 5],
            &[0, 0x90, 60, 100],
            &[0x83, 0x60, 0x80, 60, 0],
            &[0, 0x90, 64, 90],
            &[0x83, 0x60, 0x80, 64, 0],
            &[0, 0xff, 0x2f, 0],
        ]
        .concat();
        assert_eq!(bytes, want);
    }
}
