//! python-engine/melody_shape.py and melody_to_midi.py's candidate and lead
//! mix steps: turn basic-pitch's dense transcription into Clean, Balanced
//! and Detailed lead lines.
//!
//! The Python works on pretty_midi Note objects and keys several steps on
//! object identity (`id(note)`); here a note's identity is its index in the
//! list the step was given, which is the same thing.

use crate::dsp;
use crate::pmidi::{Instrument, Note, PrettyMidi};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const DEFAULT_MIN_PITCH: i64 = 45;
pub const DEFAULT_MAX_PITCH: i64 = 100;

/// Python's round(x, ndigits): correctly rounded decimal, half to even on
/// the exact binary value.
pub fn py_round(x: f64, ndigits: usize) -> f64 {
    format!("{x:.ndigits$}").parse().unwrap_or(x)
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[s.len() / 2]
}

fn rounded_starts(notes: &[Note]) -> Vec<f64> {
    let mut s: Vec<f64> = notes.iter().map(|n| py_round(n.start, 4)).collect();
    s.sort_by(|a, b| a.total_cmp(b));
    s.dedup();
    s
}

/// estimate_bpm(notes, fallback=120.0)
pub fn estimate_bpm(notes: &[Note]) -> f64 {
    let starts = rounded_starts(notes);
    let gaps: Vec<f64> = starts.windows(2).map(|w| w[1] - w[0]).filter(|g| (0.02..=2.0).contains(g)).collect();
    if gaps.len() < 6 {
        return 120.0;
    }
    let mut bpm = 60.0 / (median(&gaps) * 4.0);
    while bpm < 90.0 {
        bpm *= 2.0;
    }
    while bpm > 250.0 {
        bpm /= 2.0;
    }
    py_round(bpm, 2)
}

/// TempoMap: the local note spacing, second by second.
pub struct TempoMap {
    fallback: f64,
    gaps_by_bucket: HashMap<i64, Vec<f64>>,
    cache: std::cell::RefCell<HashMap<i64, f64>>,
}

impl TempoMap {
    const BUCKET: f64 = 1.0;
    const SPAN: i64 = 2;

    pub fn new(notes: &[Note], fallback_step: f64) -> TempoMap {
        let mut gaps_by_bucket: HashMap<i64, Vec<f64>> = HashMap::new();
        let starts = rounded_starts(notes);
        for w in starts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let gap = b - a;
            if (0.015..=1.0).contains(&gap) {
                gaps_by_bucket.entry((a / Self::BUCKET).floor() as i64).or_default().push(gap);
            }
        }
        TempoMap { fallback: fallback_step, gaps_by_bucket, cache: Default::default() }
    }

    pub fn step_at(&self, time: f64) -> f64 {
        let bucket = (time.max(0.0) / Self::BUCKET).floor() as i64;
        if let Some(v) = self.cache.borrow().get(&bucket) {
            return *v;
        }
        let mut pool = Vec::new();
        for off in -Self::SPAN..=Self::SPAN {
            if let Some(g) = self.gaps_by_bucket.get(&(bucket + off)) {
                pool.extend_from_slice(g);
            }
        }
        let step = if pool.len() >= 5 { median(&pool) } else { self.fallback };
        let step = step.max(0.015).min(0.5);
        self.cache.borrow_mut().insert(bucket, step);
        step
    }
}

pub fn fold_into_range(notes: &[Note], low: i64, high: i64, fold: bool) -> Vec<Note> {
    let mut out = Vec::new();
    for n in notes {
        let mut pitch = n.pitch as i64;
        if fold {
            while pitch > high {
                pitch -= 12;
            }
            while pitch < low {
                pitch += 12;
            }
        }
        if !(low <= pitch && pitch <= high) {
            continue;
        }
        let mut c = *n;
        c.pitch = pitch as u8;
        out.push(c);
    }
    out
}

fn overlap(a: &Note, b: &Note) -> f64 {
    let span = a.end.min(b.end) - a.start.max(b.start);
    let shortest = (a.end - a.start).min(b.end - b.start);
    if shortest > 0.0 { span / shortest } else { 0.0 }
}

fn ghost_rule(interval: i64) -> Option<(f64, f64)> {
    match interval {
        12 | 24 => Some((0.6, 1.00)),
        7 | 19 => Some((0.85, 0.80)),
        _ => None,
    }
}

/// drop_harmonic_ghosts
pub fn drop_harmonic_ghosts(notes: &[Note], strict_fifths: bool) -> Vec<Note> {
    let mut ordered: Vec<Note> = notes.to_vec();
    ordered.sort_by(|a, b| (b.velocity).cmp(&a.velocity).then(a.start.total_cmp(&b.start)));
    let mut kept: Vec<Note> = Vec::new();
    for note in ordered {
        let mut ghost = false;
        for other in &kept {
            let interval = (note.pitch as i64 - other.pitch as i64).abs();
            let Some((min_overlap, max_ratio)) = ghost_rule(interval) else { continue };
            if (interval == 7 || interval == 19) && !strict_fifths {
                continue;
            }
            if overlap(&note, other) < min_overlap {
                continue;
            }
            if other.velocity != 0 && note.velocity as f64 / other.velocity as f64 > max_ratio {
                continue;
            }
            ghost = true;
            break;
        }
        if !ghost {
            kept.push(note);
        }
    }
    kept.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    kept
}

/// group_onsets: indices into `notes`, per group.
pub fn group_onsets(notes: &[Note], tm: &TempoMap) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by(|&a, &b| {
        let (x, y) = (&notes[a], &notes[b]);
        x.start.total_cmp(&y.start).then(y.velocity.cmp(&x.velocity)).then(y.pitch.cmp(&x.pitch))
    });
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut start: Option<f64> = None;
    for i in order {
        let n = &notes[i];
        let window = 0.055f64.min(0.012f64.max(tm.step_at(n.start) * 0.45));
        match start {
            Some(s) if n.start - s > window => {
                groups.push(std::mem::take(&mut current));
                current.push(i);
                start = Some(n.start);
            }
            _ => {
                start.get_or_insert(n.start);
                current.push(i);
            }
        }
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

pub fn salience(n: &Note, low: i64, high: i64) -> f64 {
    let velocity = n.velocity as f64 / 127.0;
    let duration = 1.0f64.min(0.0f64.max(n.end - n.start) / 0.45);
    let register = (n.pitch as i64 - low) as f64 / 1i64.max(high - low) as f64;
    velocity * 0.55 + duration * 0.20 + register * 0.25
}

fn step_cost(previous: &Note, note: &Note) -> f64 {
    let mut distance = (note.pitch as i64 - previous.pitch as i64).abs();
    if distance == 12 || distance == 24 {
        distance = 3;
    }
    let contour = 1.0f64.min(distance as f64 / 15.0);
    let dynamics = 1.0f64.min((note.velocity as f64 - previous.velocity as f64).abs() / 64.0);
    contour + dynamics * 0.35
}

/// lead_line: one note index per group, by dynamic programming.
pub fn lead_line(notes: &[Note], groups: &[Vec<usize>], low: i64, high: i64) -> Vec<usize> {
    const SMOOTHNESS: f64 = 0.55;
    if groups.is_empty() {
        return Vec::new();
    }
    // per layer, in insertion order: (note, (score, parent))
    let mut best: Vec<Vec<(usize, f64, Option<usize>)>> = vec![Vec::new()];
    let mut previous: Vec<(usize, f64, Option<usize>)> = Vec::new();
    for group in groups {
        let mut layer: Vec<(usize, f64, Option<usize>)> = Vec::new();
        for &i in group {
            let score = salience(&notes[i], low, high);
            if previous.is_empty() {
                layer.push((i, score, None));
                continue;
            }
            let mut cand: Option<(f64, usize)> = None;
            for &(pn, ps, _) in &previous {
                let total = ps + score - SMOOTHNESS * step_cost(&notes[pn], &notes[i]);
                if cand.is_none_or(|(t, _)| total > t) {
                    cand = Some((total, pn));
                }
            }
            let (t, p) = cand.expect("non-empty previous layer");
            layer.push((i, t, Some(p)));
        }
        previous = layer.clone();
        best.push(layer);
    }
    let mut line = Vec::new();
    let mut chosen = previous.iter().fold(None, |acc: Option<&(usize, f64, Option<usize>)>, item| match acc {
        Some(a) if a.1 >= item.1 => Some(a),
        _ => Some(item),
    });
    for _ in groups.iter().rev() {
        let Some(&(note, _, parent)) = chosen else { break };
        line.push(note);
        let Some(parent) = parent else { break };
        chosen = best[groups.len() - line.len()].iter().find(|c| c.0 == parent);
    }
    line.reverse();
    line
}

pub fn merge_repeats(notes: &[Note], tm: &TempoMap) -> Vec<Note> {
    let mut sorted = notes.to_vec();
    sorted.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    let mut out: Vec<Note> = Vec::new();
    for note in sorted {
        if let Some(last) = out.last_mut() {
            if last.pitch == note.pitch {
                let step = tm.step_at(note.start);
                let gap = note.start - last.end;
                let within_step = note.start - last.start < step * 0.75;
                if within_step && gap <= step * 0.75 {
                    last.end = last.end.max(note.end);
                    last.velocity = last.velocity.max(note.velocity);
                    continue;
                }
            }
        }
        out.push(note);
    }
    out
}

fn metrical_weight(index: i64) -> i64 {
    if index % 8 == 0 {
        3
    } else if index % 4 == 0 {
        2
    } else if index % 2 == 0 {
        1
    } else {
        0
    }
}

pub fn limit_density(notes: Vec<Note>, notes_per_second: f64, tm: Option<&TempoMap>) -> Vec<Note> {
    const WINDOW: f64 = 1.0;
    if notes_per_second == 0.0 || notes_per_second <= 0.0 || notes_per_second.is_nan() {
        return notes;
    }
    let mut ordered = notes.clone();
    ordered.sort_by(|a, b| a.start.total_cmp(&b.start));
    if ordered.is_empty() {
        return notes;
    }
    let budget = 1i64.max((notes_per_second * WINDOW).round_ties_even() as i64) as usize;
    let origin = ordered[0].start;
    let rank = |n: &Note| -> (i64, u8) {
        let Some(tm) = tm else { return (0, n.velocity) };
        let step = tm.step_at(n.start);
        let index = if step > 0.0 { ((n.start - origin) / step).round_ties_even() as i64 } else { 0 };
        (metrical_weight(index), n.velocity)
    };
    let mut kept: Vec<Note> = Vec::new();
    let mut bucket: Vec<Note> = Vec::new();
    let mut bucket_start: Option<f64> = None;
    let flush = |bucket: &mut Vec<Note>, kept: &mut Vec<Note>| {
        if bucket.is_empty() {
            return;
        }
        bucket.sort_by(|a, b| {
            let (ra, rb) = (rank(a), rank(b));
            rb.0.cmp(&ra.0).then(rb.1.cmp(&ra.1)).then(a.start.total_cmp(&b.start))
        });
        kept.extend(bucket.iter().take(budget).copied());
    };
    for n in ordered {
        let bs = *bucket_start.get_or_insert(n.start);
        if n.start - bs > WINDOW {
            flush(&mut bucket, &mut kept);
            bucket.clear();
            bucket_start = Some(n.start);
        }
        bucket.push(n);
    }
    flush(&mut bucket, &mut kept);
    kept.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    kept
}

/// shape(): range -> ghosts -> grouping -> lead line -> extras -> tidy.
#[allow(clippy::too_many_arguments)]
pub fn shape(raw: &[Note], polyphony: usize, min_duration: f64, bpm: f64, low: i64, high: i64, fold: bool, density: f64, strict_fifths: bool) -> Vec<Note> {
    let max_sustain_beats = 8.0;
    let beat = 60.0 / 20.0f64.max(bpm);
    let fallback_step = beat / 4.0;
    let notes = fold_into_range(raw, low, high, fold);
    let notes: Vec<Note> = notes.into_iter().filter(|n| n.end - n.start >= min_duration).collect();
    let notes: Vec<Note> = notes.into_iter().filter(|n| (n.end - n.start) <= max_sustain_beats * beat || n.velocity >= 90).collect();
    if notes.is_empty() {
        return Vec::new();
    }
    let tm = TempoMap::new(&notes, fallback_step);
    let notes = drop_harmonic_ghosts(&notes, strict_fifths);
    let groups = group_onsets(&notes, &tm);
    let line = lead_line(&notes, &groups, low, high);
    let chosen: HashSet<usize> = line.iter().copied().collect();
    let mut selected: Vec<Note> = line.iter().map(|&i| notes[i]).collect();
    if polyphony > 1 {
        for g in &groups {
            let mut extras: Vec<usize> = g.iter().copied().filter(|i| !chosen.contains(i)).collect();
            // list.sort(key=salience, reverse=True): stable, descending
            extras.sort_by(|&a, &b| salience(&notes[b], low, high).total_cmp(&salience(&notes[a], low, high)));
            selected.extend(extras.iter().take(polyphony - 1).map(|&i| notes[i]));
        }
    }
    let mut merged = merge_repeats(&selected, &tm);
    if polyphony == 1 {
        for k in 0..merged.len().saturating_sub(1) {
            let cur_start = merged[k + 1].start;
            let prev = &mut merged[k];
            if prev.end > cur_start {
                prev.end = (prev.start + 0.02).max(cur_start);
            }
        }
    }
    let merged: Vec<Note> = merged.into_iter().filter(|n| n.end - n.start >= 0.02).collect();
    limit_density(merged, density, Some(&tm))
}

/// Python's str.title() for the candidate names.
fn title(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

pub const CANDIDATES: [&str; 3] = ["clean", "balanced", "detailed"];

pub struct Candidate {
    pub name: &'static str,
    pub midi: PrettyMidi,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct MelodyOpts {
    pub min_pitch: i64,
    pub max_pitch: i64,
    pub fold: bool,
    pub density: f64,
    pub onset: f64,
    pub frame: f64,
    pub min_note_ms: i64,
    pub strict_fifths: bool,
}

/// build_candidates on the reloaded raw transcription. Err when it holds no
/// pitched notes.
pub fn build_candidates(raw: &PrettyMidi, o: &MelodyOpts, say: &mut dyn FnMut(String)) -> Result<(f64, Vec<Candidate>), String> {
    let raw_notes: Vec<Note> = raw.instruments.iter().filter(|i| !i.is_drum).flat_map(|i| i.notes.iter().copied()).collect();
    if raw_notes.is_empty() {
        return Err("No pitched notes were detected in the selected audio.".into());
    }
    let bpm = estimate_bpm(&raw_notes);
    say(format!("  detected tempo: {bpm:.0} BPM"));
    let specs: [(&str, usize, f64, f64); 3] = [("clean", 1, 0.070, o.density), ("balanced", 2, 0.055, o.density * 1.6), ("detailed", 3, 0.040, 0.0)];
    let mut out = Vec::new();
    for (name, poly, min_dur, density) in specs {
        let notes = shape(&raw_notes, poly, min_dur, bpm, o.min_pitch, o.max_pitch, o.fold, density, o.strict_fifths);
        let mut pm = PrettyMidi::new(220, bpm);
        let mut inst = Instrument::new(81, false, &format!("Main Melody - {}", title(name)));
        let mut sorted = notes.clone();
        sorted.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
        inst.notes = sorted;
        pm.instruments.push(inst);
        say(format!("  {name}: {} notes", notes.len()));
        out.push(Candidate { name, midi: pm, count: notes.len() });
    }
    Ok((bpm, out))
}

/// melody_to_midi._stem_label
pub fn stem_label(name: &str) -> String {
    let n = name.to_lowercase();
    for label in ["drums", "drum", "percussion", "bass", "vocals", "vocal", "other", "piano", "guitar"] {
        if n.contains(label) {
            return label.into();
        }
    }
    n
}

/// _mix_lead_stems' filter and level stage on planar float32 audio: a 4th
/// order Butterworth high-pass at max(45 Hz, MIN_PITCH - 12), forward and
/// back (float64), back to float32, then a 0.98 peak cap.
pub fn highpass_and_limit(planar: &[Vec<f32>], sr: u32, min_pitch: i64) -> Result<Vec<Vec<f32>>, String> {
    let cutoff = 45.0f64.max(crate::basicpitch::midi_to_hz((min_pitch - 12) as f64));
    let sos = dsp::butter_highpass_sos(4, cutoff, sr as f64)?;
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(planar.len());
    for ch in planar {
        out.push(dsp::sosfiltfilt(&sos, ch)?.iter().map(|&v| v as f32).collect());
    }
    let peak = out.iter().flatten().fold(0f32, |m, &v| if v.abs() > m || v.is_nan() { v.abs() } else { m }) as f64;
    if peak > 0.0 {
        let s = 1.0f64.min(0.98 / peak) as f32;
        for v in out.iter_mut().flatten() {
            *v *= s;
        }
    }
    Ok(out)
}

/// RESULT| payload, formatted as json.dumps(result, ensure_ascii=False).
pub fn result_json(clean: &str, paths: &BTreeMap<&str, String>, counts: &BTreeMap<&str, usize>, source: &str) -> String {
    let q = |s: &str| serde_json::to_string(s).expect("string");
    let cand = CANDIDATES.iter().map(|k| format!("{}: {}", q(k), q(&paths[k]))).collect::<Vec<_>>().join(", ");
    let cnt = CANDIDATES.iter().map(|k| format!("{}: {}", q(k), counts[k])).collect::<Vec<_>>().join(", ");
    format!(
        "{{\"midiPath\": {}, \"candidates\": {{{cand}}}, \"candidateCounts\": {{{cnt}}}, \"sourceAudio\": {}, \"previewAudio\": {}, \"pipeline\": \"melody\"}}",
        q(clean),
        q(source),
        q(source)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(pitch: i64, start: f64, length: f64, velocity: u8) -> Note {
        Note { velocity, pitch: pitch as u8, start, end: start + length }
    }

    /// melody_shape.demo()
    #[test]
    fn demo_self_check() {
        let bpm = 200.0;
        let step = 60.0 / bpm / 4.0;
        let melody: Vec<i64> = [72, 74, 76, 79, 76, 74, 72, 67].iter().copied().cycle().take(24).collect();
        let mut raw = Vec::new();
        for (index, &pitch) in melody.iter().enumerate() {
            let at = index as f64 * step;
            raw.push(note(pitch, at, step * 0.9, 104));
            raw.push(note(pitch + 12, at, step * 0.9, 112));
            raw.push(note(pitch - 12, at, step * 0.9, 88));
            raw.push(note(pitch - 5, at, step * 0.9, 70));
        }
        raw.push(note(48, 0.0, melody.len() as f64 * step, 55));
        let detected = estimate_bpm(&raw);
        assert!((150.0..=250.0).contains(&detected), "{detected}");
        let clean = shape(&raw, 1, 0.03, bpm, 45, 100, true, 0.0, true);
        assert_eq!(clean.len(), melody.len());
        for (n, m) in clean.iter().zip(&melody) {
            assert_eq!((n.pitch as i64 - m).abs() % 12, 0);
        }
        for w in clean.windows(2) {
            assert!(w[0].end <= w[1].start + 1e-6);
        }
        let ts = 60.0 / 200.0 / 8.0;
        let repeats: Vec<Note> = (0..16).map(|i| note(76, i as f64 * ts, ts * 0.85, 100)).collect();
        assert!(shape(&repeats, 1, 0.01, 200.0, 45, 100, true, 0.0, true).len() >= 14);
        let split = [note(60, 0.0, 0.020, 100), note(60, 0.022, 0.020, 100)];
        assert_eq!(merge_repeats(&split, &TempoMap::new(&split, 0.075)).len(), 1);
        let grid = 0.05;
        let run: Vec<Note> = (0..40).map(|i| note(60 + (i % 5), i as f64 * grid, grid * 0.9, if i % 2 == 1 { 127 } else { 70 })).collect();
        let tm = TempoMap::new(&run, grid);
        let thinned = limit_density(run.clone(), 5.0, Some(&tm));
        let on_grid = thinned.iter().filter(|n| ((n.start / grid).round_ties_even() as i64) % 2 == 0).count();
        assert!(on_grid * 2 > thinned.len());
        let dense: Vec<Note> = (0..100).map(|i| note(60 + (i % 12), i as f64 * 0.02, 0.02, (60 + (i % 40)) as u8)).collect();
        assert!(limit_density(dense, 10.0, None).len() <= 25);
        assert_eq!(drop_harmonic_ghosts(&[note(60, 0.0, 0.5, 80), note(72, 0.0, 0.5, 120)], true).iter().map(|n| n.pitch).collect::<Vec<_>>(), vec![72]);
        assert_eq!(drop_harmonic_ghosts(&[note(60, 0.0, 0.5, 120), note(67, 0.0, 0.5, 70)], true).iter().map(|n| n.pitch).collect::<Vec<_>>(), vec![60]);
        assert_eq!(drop_harmonic_ghosts(&[note(60, 0.0, 0.5, 110), note(67, 0.0, 0.5, 108)], true).len(), 2);
        let slow: Vec<Note> = (0..8).map(|i| note(60, i as f64 * 0.5, 0.4, 100)).collect();
        let fast: Vec<Note> = (0..80).map(|i| note(60, 4.0 + i as f64 * 0.05, 0.04, 100)).collect();
        let both: Vec<Note> = slow.iter().chain(&fast).copied().collect();
        let tm = TempoMap::new(&both, 0.1);
        assert!(tm.step_at(1.0) > tm.step_at(6.0) * 3.0);
        let folded = fold_into_range(&[note(108, 0.0, 0.2, 100)], 45, 100, true);
        assert_eq!(folded[0].pitch, 96);
    }

    #[test]
    fn python_round() {
        assert_eq!(py_round(0.125, 2), 0.12);
        assert_eq!(py_round(172.4149999, 2), 172.41);
        assert_eq!(py_round(2.675, 2), 2.67, "2.675 is stored just below");
    }

    #[test]
    fn result_line_is_python_json() {
        let mut p = BTreeMap::new();
        p.insert("clean", r"C:\a\b.mid".to_string());
        p.insert("balanced", r"C:\a\b_balanced.mid".to_string());
        p.insert("detailed", r"C:\a\b_detailed.mid".to_string());
        let mut c = BTreeMap::new();
        c.insert("clean", 1);
        c.insert("balanced", 2);
        c.insert("detailed", 3);
        let s = result_json(r"C:\a\b.mid", &p, &c, r"C:\a\b.wav");
        assert!(s.starts_with(r#"{"midiPath": "C:\\a\\b.mid", "candidates": {"clean": "C:\\a\\b.mid", "balanced""#), "{s}");
        assert!(s.ends_with(r#""pipeline": "melody"}"#));
    }
}
