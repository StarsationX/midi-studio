use std::collections::{HashMap, HashSet};
use std::path::Path;

use indexmap::IndexMap;
use midly::{Format, MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};

use crate::mapping::{NoteToKey, Resolver};

const DEFAULT_TEMPO: u32 = 500_000;
const DEDUP_WINDOW: f64 = 0.005;
const CHORD_WINDOW: f64 = 0.003;

#[derive(Clone, Debug, PartialEq)]
pub struct NoteEvent {
    pub t: f64,
    pub key: String,
    pub dur: f64,
    pub note: i64,
    pub ch: u8,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Msg {
    NoteOn { ch: u8, note: u8, vel: u8 },
    NoteOff { ch: u8, note: u8 },
    Tempo(u32),
    Other,
}

/// A MIDI file read the way mido reads one: every track merged into one
/// stream in playback order, each message carrying its delta in seconds.
pub struct MidiFile {
    pub format: Format,
    pub messages: Vec<(f64, Msg)>,
}

impl MidiFile {
    pub fn open(path: impl AsRef<Path>) -> Result<MidiFile, String> {
        let path = path.as_ref();
        let bytes = std::fs::read(path).map_err(|e| format!("{e}: '{}'", path.display()))?;
        MidiFile::parse(&bytes)
    }

    pub fn parse(bytes: &[u8]) -> Result<MidiFile, String> {
        let smf = Smf::parse(bytes).map_err(|e| e.to_string())?;
        struct Abs {
            tick: u64,
            msg: Msg,
            eot: bool,
        }
        let mut all: Vec<Abs> = Vec::new();
        for track in &smf.tracks {
            let mut now: u64 = 0;
            for ev in track {
                now += u64::from(u32::from(ev.delta));
                let (msg, eot) = match ev.kind {
                    TrackEventKind::Midi { channel, message } => {
                        let ch = u8::from(channel);
                        match message {
                            MidiMessage::NoteOn { key, vel } => {
                                (Msg::NoteOn { ch, note: u8::from(key), vel: u8::from(vel) }, false)
                            }
                            MidiMessage::NoteOff { key, .. } => (Msg::NoteOff { ch, note: u8::from(key) }, false),
                            _ => (Msg::Other, false),
                        }
                    }
                    TrackEventKind::Meta(MetaMessage::Tempo(t)) => (Msg::Tempo(u32::from(t)), false),
                    TrackEventKind::Meta(MetaMessage::EndOfTrack) => (Msg::Other, true),
                    _ => (Msg::Other, false),
                };
                all.push(Abs { tick: now, msg, eot });
            }
        }
        all.sort_by_key(|a| a.tick);

        let tick_secs = |ticks: u64, tempo: u32| -> f64 {
            match smf.header.timing {
                Timing::Metrical(tpb) => {
                    let scale = tempo as f64 * 1e-6 / u16::from(tpb) as f64;
                    ticks as f64 * scale
                }
                Timing::Timecode(fps, sub) => ticks as f64 / (fps.as_f32() as f64 * sub as f64),
            }
        };

        let mut messages = Vec::with_capacity(all.len() + 1);
        let mut tempo = DEFAULT_TEMPO;
        let mut last = 0u64;
        let mut end = 0u64;
        for a in &all {
            if a.eot {
                end = end.max(a.tick);
                continue;
            }
            let delta = a.tick - last;
            last = a.tick;
            end = 0;
            messages.push((if delta > 0 { tick_secs(delta, tempo) } else { 0.0 }, a.msg));
            if let Msg::Tempo(t) = a.msg {
                tempo = t;
            }
        }
        let tail = end.saturating_sub(last);
        messages.push((if tail > 0 { tick_secs(tail, tempo) } else { 0.0 }, Msg::Other));
        Ok(MidiFile { format: smf.header.format, messages })
    }

    pub fn length(&self) -> Result<f64, String> {
        if self.format == Format::Sequential {
            return Err("impossible to compute length for type 2 (asynchronous) file".into());
        }
        Ok(neumaier_sum(self.messages.iter().map(|m| m.0)))
    }
}

/// Python 3.12+ `sum()` over floats: Neumaier-compensated, so mido's
/// `MidiFile.length` is not the naive running total.
fn neumaier_sum(values: impl Iterator<Item = f64>) -> f64 {
    let (mut sum, mut c) = (0.0f64, 0.0f64);
    for x in values {
        let t = sum + x;
        if sum.abs() >= x.abs() {
            c += (sum - t) + x;
        } else {
            c += (x - t) + sum;
        }
        sum = t;
    }
    if c != 0.0 && c.is_finite() {
        sum += c;
    }
    sum
}

#[derive(Clone, Debug)]
pub struct ParseOpts {
    pub transpose: i64,
    pub fold: bool,
    pub hand: String,
    pub hand_split: i64,
    pub chord_stagger: f64,
}

impl Default for ParseOpts {
    fn default() -> Self {
        ParseOpts { transpose: 0, fold: true, hand: "both".into(), hand_split: 60, chord_stagger: 0.0 }
    }
}

#[derive(Clone, Debug)]
pub struct Parsed {
    pub events: Vec<NoteEvent>,
    pub unmapped: Vec<i64>,
    pub total: f64,
    pub bpm: f64,
    pub bpm_estimate: f64,
}

pub fn parse_midi(path: impl AsRef<Path>, note_to_key: &NoteToKey, tempo_scale: f64, opts: &ParseOpts) -> Result<Parsed, String> {
    parse_midi_file(&MidiFile::open(path)?, note_to_key, tempo_scale, opts)
}

pub fn parse_midi_file(mid: &MidiFile, note_to_key: &NoteToKey, tempo_scale: f64, opts: &ParseOpts) -> Result<Parsed, String> {
    let hand = if opts.hand.is_empty() { "both".to_string() } else { opts.hand.to_lowercase() };
    let hand_split = if opts.hand_split == 0 { 60 } else { opts.hand_split };
    let chord_stagger = opts.chord_stagger.max(0.0);
    let mut resolver = Resolver::new(note_to_key, opts.fold);

    let mut events: Vec<NoteEvent> = Vec::new();
    let mut unmapped: HashSet<i64> = HashSet::new();
    let mut open_notes: IndexMap<(u8, u8), (f64, String)> = IndexMap::new();
    let mut abs_time = 0.0f64;

    for &(dt, msg) in &mid.messages {
        abs_time += dt;
        match msg {
            Msg::NoteOn { ch, note, vel } if vel > 0 => {
                let n = note as i64;
                if hand == "right" && n < hand_split {
                    continue;
                }
                if hand == "left" && n >= hand_split {
                    continue;
                }
                match resolver.resolve(n + opts.transpose) {
                    None => {
                        unmapped.insert(n);
                    }
                    Some(key) => {
                        open_notes.insert((ch, note), (abs_time, key.to_string()));
                    }
                }
            }
            Msg::NoteOn { ch, note, .. } | Msg::NoteOff { ch, note } => {
                if let Some((start, key)) = open_notes.shift_remove(&(ch, note)) {
                    events.push(NoteEvent { t: start, key, dur: abs_time - start, note: note as i64, ch });
                }
            }
            _ => {}
        }
    }
    for ((ch, note), (start, key)) in open_notes {
        events.push(NoteEvent { t: start, key, dur: (abs_time - start).max(0.05), note: note as i64, ch });
    }

    events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));

    let mut last_t_for: HashMap<String, f64> = HashMap::new();
    events.retain(|e| {
        let last = last_t_for.get(&e.key).copied().unwrap_or(-1.0);
        if e.t - last < DEDUP_WINDOW {
            return false;
        }
        last_t_for.insert(e.key.clone(), e.t);
        true
    });

    if tempo_scale == 0.0 {
        return Err("float division by zero".into());
    }
    let first_t = events.first().map(|e| e.t).unwrap_or(0.0);
    for e in &mut events {
        e.t = (e.t - first_t) / tempo_scale;
        e.dur /= tempo_scale;
    }
    let total = (mid.length()? - first_t) / tempo_scale;

    if chord_stagger > 0.0 && !events.is_empty() {
        let n = events.len();
        let mut rolled = Vec::with_capacity(n);
        let mut i = 0;
        while i < n {
            let mut j = i + 1;
            while j < n && events[j].t - events[i].t < CHORD_WINDOW {
                j += 1;
            }
            let mut chord: Vec<NoteEvent> = events[i..j].to_vec();
            chord.sort_by_key(|e| e.note);
            let t0 = events[i].t;
            for (k, mut e) in chord.into_iter().enumerate() {
                e.t = t0 + k as f64 * chord_stagger;
                rolled.push(e);
            }
            i = j;
        }
        rolled.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
        events = rolled;
    }

    let mut bpm = 120.0;
    for (_, m) in &mid.messages {
        if let Msg::Tempo(t) = m {
            if *t == 0 {
                return Err("float division by zero".into());
            }
            bpm = 60_000_000.0 / *t as f64;
            break;
        }
    }
    let starts: Vec<f64> = events.iter().map(|e| e.t).collect();
    let estimate = bpm_from_onsets(&starts, bpm);
    bpm *= tempo_scale;

    let mut unmapped: Vec<i64> = unmapped.into_iter().collect();
    unmapped.sort_unstable();
    Ok(Parsed { events, unmapped, total: total.max(0.0), bpm, bpm_estimate: estimate * tempo_scale })
}

/// Semitone shift (-limit..+limit) that maps the most notes; ties go to the
/// smaller shift, and to 0 when it is already the best.
pub fn best_transpose(path: impl AsRef<Path>, note_to_key: &NoteToKey, limit: i64) -> (i64, usize, usize) {
    let mid = match MidiFile::open(path) {
        Ok(m) => m,
        Err(_) => return (0, 0, 0),
    };
    let pitches: Vec<i64> = mid
        .messages
        .iter()
        .filter_map(|(_, m)| match m {
            Msg::NoteOn { note, vel, .. } if *vel > 0 => Some(*note as i64),
            _ => None,
        })
        .collect();
    if pitches.is_empty() {
        return (0, 0, 0);
    }
    let hits = |shift: i64| pitches.iter().filter(|p| note_to_key.contains_key(&(**p + shift))).count();
    let mut shifts: Vec<i64> = (-limit..=limit).collect();
    shifts.sort_by_key(|v| (v.abs(), *v));
    let (mut best, mut best_hits) = (0, hits(0));
    for shift in shifts {
        let h = hits(shift);
        if h > best_hits {
            best = shift;
            best_hits = h;
        }
    }
    (best, best_hits, pitches.len())
}

/// Python's round(x, n): correctly rounded on the exact binary value.
pub fn py_round(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{x:.digits$}").parse().unwrap_or(x)
}

pub fn bpm_from_onsets(starts: &[f64], fallback: f64) -> f64 {
    let mut uniq: Vec<f64> = starts.iter().map(|t| py_round(*t, 4)).collect();
    uniq.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    uniq.dedup();
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChordReport {
    pub max_chord: usize,
    pub big_chords: usize,
    pub ghost_limit: usize,
    pub short_notes: usize,
}

pub fn chord_report(events: &[NoteEvent]) -> ChordReport {
    let (window, ghost_limit, short_sec) = (0.003, 6, 0.03);
    let (mut max_chord, mut big_chords) = (0, 0);
    let n = events.len();
    let mut i = 0;
    while i < n {
        let mut j = i + 1;
        while j < n && events[j].t - events[i].t < window {
            j += 1;
        }
        let size = events[i..j].iter().map(|e| e.key.as_str()).collect::<HashSet<_>>().len();
        max_chord = max_chord.max(size);
        if size > ghost_limit {
            big_chords += 1;
        }
        i = j;
    }
    let short_notes = events.iter().filter(|e| e.dur < short_sec).count();
    ChordReport { max_chord, big_chords, ghost_limit, short_notes }
}

/// Virtual Piano style sheet text: `[asd] f g - - h |`, quantised to eighths.
pub fn events_to_sheet(events: &[NoteEvent], bpm: f64) -> String {
    if events.is_empty() {
        return String::new();
    }
    let beats_per_line = 8i64;
    let eighth = 60.0 / bpm.max(1.0) / 2.0;
    let slots_per_line = beats_per_line * 2;
    let mut out: Vec<String> = Vec::new();
    let mut line: Vec<String> = Vec::new();
    let (mut prev_slot, mut line_start_slot) = (0i64, 0i64);
    let n = events.len();
    let mut i = 0;
    while i < n {
        let mut j = i + 1;
        while j < n && events[j].t - events[i].t < 0.03 {
            j += 1;
        }
        let mut chord: Vec<&NoteEvent> = events[i..j].iter().collect();
        chord.sort_by_key(|e| e.note);
        let mut keys: Vec<&str> = Vec::new();
        for e in chord {
            if !keys.contains(&e.key.as_str()) {
                keys.push(&e.key);
            }
        }
        let slot = (events[i].t / eighth).round_ties_even() as i64;
        if i > 0 {
            let rests = (slot - prev_slot - 1).min(slots_per_line).max(0);
            line.extend((0..rests).map(|_| "-".to_string()));
        }
        while slot - line_start_slot >= slots_per_line {
            out.push(line.join(" ") + " |");
            line.clear();
            line_start_slot += slots_per_line;
        }
        let mut token = String::new();
        if keys.len() > 1 {
            token.push('[');
        }
        for key in &keys {
            // The extended Virtual Piano layout also uses sheet punctuation as pitches.
            if matches!(*key, "[" | "]" | "|" | "-" | "\\") {
                token.push('\\');
            }
            token.push_str(key);
        }
        if keys.len() > 1 {
            token.push(']');
        }
        line.push(token);
        prev_slot = slot;
        i = j;
    }
    if !line.is_empty() {
        out.push(line.join(" "));
    }
    out.join("\n") + "\n"
}
