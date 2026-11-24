//! Pasted sheets are scores on a fixed grid, not keypress commands. Convert them
//! to real MIDI so queue entries, previews and playback all use the normal path.
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_TEXT: usize = 64 * 1024;
const MAX_NOTES: usize = 16_384;
// Exactly one tick per percentage point of gate at every subdivision.
const STEP: u32 = 100;

// This is the shipped VP notation, never a user's edited target keyboard mapping.
static PITCHES: LazyLock<Result<[u8; 128], String>> = LazyLock::new(|| {
    let map: Value = serde_json::from_str(include_str!("../../python-engine/mappings/virtualpiano.json"))
        .map_err(|e| e.to_string())?;
    let mut pitches = [0; 128];
    for (number, key) in map["note_to_key"].as_object().ok_or("Missing VP mapping")? {
        let pitch: u8 = number.parse().map_err(|_| "Invalid VP pitch")?;
        let [key] = key.as_str().unwrap_or_default().as_bytes() else { return Err("Invalid VP key".into()) };
        if !(1..128).contains(&pitch) || !key.is_ascii() || pitches[*key as usize] != 0 {
            return Err("Invalid or ambiguous VP mapping".into());
        }
        pitches[*key as usize] = pitch;
    }
    Ok(pitches)
});

fn integer(args: &Value, field: &str, label: &str, max: u32) -> Result<u32, String> {
    args[field].as_f64().filter(|v| v.fract() == 0.0 && (1.0..=max as f64).contains(v))
        .map(|v| v as u32).ok_or_else(|| format!("{label} must be a whole number from 1 to {max}."))
}

struct Sheet {
    midi: Vec<u8>,
    notes: usize,
    duration: f64,
}

fn encode(args: &Value) -> Result<Sheet, String> {
    let text = args["text"].as_str().ok_or("Paste a Virtual Piano sheet first.")?;
    if text.len() > MAX_TEXT { return Err("Sheet is too long (64 KiB maximum).".into()); }
    let bpm = args["bpm"].as_f64().filter(|n| (20.0..=400.0).contains(n)).ok_or("Tempo must be 20 to 400 BPM.")?;
    let steps = integer(args, "stepsPerBeat", "Steps per beat", 8)?;
    let gate = integer(args, "gatePercent", "Note length (%)", 100)?;
    let tempo = (60_000_000.0 / bpm).round() as u32;
    let ppq = steps * STEP;
    let keys = PITCHES.as_ref().map_err(Clone::clone)?;
    let mut track = vec![TrackEvent { delta: 0.into(), kind: TrackEventKind::Meta(MetaMessage::Tempo(tempo.into())) }];
    let (mut notes, mut next_tick, mut last_off) = (0usize, 0u32, 0u32);
    let mut chord = Vec::new();
    let mut first_line = true;

    for (row, line) in text.trim_start_matches('\u{feff}').lines().enumerate() {
        if first_line && line.trim().is_empty() { continue; }
        if first_line {
            first_line = false;
            // Export writes this header to .vp.txt, but not to the clipboard.
            if line.trim_start().starts_with("# ") && line.contains(" BPM | ") && line.contains(" notes") { continue; }
        }
        let mut chars = line.chars().enumerate();
        let mut chord_start = None;
        let mut chord_mask = 0u128;
        while let Some((col, ch)) = chars.next() {
            let location = |message: &str| format!("Line {}, column {}: {message}", row + 1, col + 1);
            match ch {
                '[' => {
                    if chord_start.is_some() { return Err(location("A chord cannot contain another [ chord.")); }
                    chord_start = Some(col);
                    chord_mask = 0;
                    continue;
                }
                ']' => {
                    if chord_start.take().is_none() { return Err(location("Closing ] has no opening [.")); }
                    if chord.is_empty() { return Err(location("Add at least one key inside the chord.")); }
                }
                ch if ch.is_whitespace() || ch == '|' || ch == '-' => {
                    if chord_start.is_some() { return Err(location("Use keys only inside [chords]; escape literal punctuation with a backslash.")); }
                    // Player starts at the first onset; a trailing rest has no following note.
                    if ch == '-' && notes > 0 { next_tick += STEP; }
                    continue;
                }
                ch => {
                    let key = if ch == '\\' {
                        match chars.next() {
                            Some((_, key @ ('[' | ']' | '-' | '|' | '\\'))) => key,
                            _ => return Err(location(r"Use \ only before [, ], -, | or another backslash.")),
                        }
                    } else { ch };
                    let pitch = keys.get(key as usize).copied().unwrap_or(0);
                    if pitch == 0 { return Err(location(&format!("{key:?} is not a Virtual Piano key."))); }
                    if chord_start.is_some() {
                        let bit = 1u128 << pitch;
                        if chord_mask & bit != 0 { return Err(location(&format!("Key {key:?} appears twice in this chord."))); }
                        chord_mask |= bit;
                        chord.push(pitch);
                        continue;
                    }
                    chord.push(pitch);
                }
            }
            notes += chord.len();
            if notes > MAX_NOTES { return Err(location("Sheet has more than 16,384 notes.")); }
            let end = next_tick + gate;
            if u64::from(end) * u64::from(tempo) > 3_600_000_000 * u64::from(ppq) {
                return Err(location("Sheet would play for longer than one hour."));
            }
            for (i, &pitch) in chord.iter().enumerate() {
                track.push(TrackEvent { delta: (if i == 0 { next_tick - last_off } else { 0 }).into(),
                    kind: TrackEventKind::Midi { channel: 0.into(), message: MidiMessage::NoteOn { key: pitch.into(), vel: 96.into() } } });
            }
            for (i, &pitch) in chord.iter().enumerate() {
                track.push(TrackEvent { delta: (if i == 0 { gate } else { 0 }).into(),
                    kind: TrackEventKind::Midi { channel: 0.into(), message: MidiMessage::NoteOff { key: pitch.into(), vel: 0.into() } } });
            }
            chord.clear();
            last_off = end;
            next_tick += STEP;
        }
        if let Some(col) = chord_start { return Err(format!("Line {}, column {}: chord is missing its closing ].", row + 1, col + 1)); }
    }
    if notes == 0 { return Err("Paste at least one Virtual Piano key, for example: t y [uo].".into()); }
    track.push(TrackEvent { delta: 0.into(), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
    let smf = Smf { header: Header::new(Format::SingleTrack, Timing::Metrical((ppq as u16).into())), tracks: vec![track] };
    let mut midi = Vec::new();
    smf.write_std(&mut midi).map_err(|e| format!("Could not encode the sheet: {e}"))?;
    Ok(Sheet { midi, notes, duration: f64::from(last_off) * f64::from(tempo) / (1_000_000.0 * f64::from(ppq)) })
}

// A user can open and edit one of these files in the Editor. Only reuse an
// exact match, never truncate an edited file or follow a symlink to write it.
fn matches_file(path: &Path, bytes: &[u8]) -> std::io::Result<bool> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() != bytes.len() as u64 { return Ok(false); }
    let mut file = File::open(path)?;
    let mut buf = [0; 8192];
    for chunk in bytes.chunks(buf.len()) {
        file.read_exact(&mut buf[..chunk.len()])?;
        if *chunk != buf[..chunk.len()] { return Ok(false); }
    }
    Ok(file.read(&mut buf[..1])? == 0)
}

pub(super) fn create(args: &Value, user_data: &Path) -> Result<(PathBuf, usize, f64), String> {
    let sheet = encode(args)?;
    let dir = user_data.join("vp-sheets");
    let storage = |e| format!("Could not save the sheet in {}: {e}", dir.display());
    fs::create_dir_all(&dir).map_err(storage)?;
    let hash = format!("{:x}", Sha256::digest(&sheet.midi));
    for suffix in 0..100 {
        let name = if suffix == 0 { format!("VP Sheet - {}.mid", &hash[..12]) }
                   else { format!("VP Sheet - {} ({suffix}).mid", &hash[..12]) };
        let path = dir.join(name);
        match File::create_new(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&sheet.midi) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(storage(e));
                }
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                if !matches_file(&path, &sheet.midi).map_err(storage)? { continue; }
            }
            Err(e) => return Err(storage(e)),
        }
        return Ok((path, sheet.notes, sheet.duration));
    }
    Err("Too many existing files with this sheet’s name. No files were overwritten.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use midi_player::mapping::{load_mapping, NoteToKey};
    use midi_player::midi::{events_to_sheet, parse_midi_file, MidiFile, NoteEvent, ParseOpts, Parsed};
    use serde_json::json;

    fn args(text: &str) -> Value {
        json!({"text": text, "bpm": 120, "stepsPerBeat": 2, "gatePercent": 80})
    }

    fn mapping() -> NoteToKey {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../python-engine");
        load_mapping("virtualpiano", &dir).unwrap().note_to_key
    }

    fn playback(sheet: &Sheet, mapping: &NoteToKey) -> Parsed {
        parse_midi_file(&MidiFile::parse(&sheet.midi).unwrap(), mapping, 1.0, &ParseOpts::default()).unwrap()
    }

    #[test]
    fn copied_text_and_file_header_use_the_input_tempo() {
        let input = "\u{feff}# demo.mid | virtualpiano | 90 BPM | 5 notes\r\n\r\n--tT - | \r\n [yu]t--";
        let sheet = encode(&args(input)).unwrap();
        let p = playback(&sheet, &mapping());
        assert_eq!(p.bpm, 120.0);
        assert_eq!(sheet.notes, 5);
        assert_eq!(p.events.iter().map(|e| e.note).collect::<Vec<_>>(), [60, 61, 62, 64, 60]);
        for (event, start) in p.events.iter().zip([0.0, 0.25, 0.75, 0.75, 1.0]) {
            assert!((event.t - start).abs() < 1e-9);
            assert!((event.dur - 0.2).abs() < 1e-9);
        }
        assert!((p.total - 1.2).abs() < 1e-9 && (p.total - sheet.duration).abs() < 1e-9);
    }

    #[test]
    fn exports_and_imports_all_88_canonical_keys_including_literal_syntax() {
        let map = mapping();
        let source: Vec<_> = (21..=108).map(|note| NoteEvent {
            t: ((note - 21) / 3) as f64 * 0.25, key: map[&note].clone(), dur: 0.2, note, ch: 0,
        }).collect();
        let text = events_to_sheet(&source, 120.0);
        let p = playback(&encode(&args(&text)).unwrap(), &map);
        assert_eq!(p.events.len(), source.len());
        for (actual, original) in p.events.iter().zip(&source) {
            assert_eq!((actual.note, &actual.key), (original.note, &original.key));
            assert!((actual.t - original.t).abs() < 1e-9);
        }
    }

    #[test]
    fn gate_and_subdivision_preserve_retriggers_at_the_same_tick() {
        let mut opts = args("tt");
        opts["stepsPerBeat"] = json!(3);
        opts["bpm"] = json!(60);
        opts["gatePercent"] = json!(100);
        let sheet = encode(&opts).unwrap();
        let p = playback(&sheet, &mapping());
        assert_eq!(p.events.len(), 2);
        assert!((p.events[0].dur - 1.0 / 3.0).abs() < 1e-9);
        assert!((p.events[1].t - p.events[0].dur).abs() < 1e-9);
        assert!((sheet.duration - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn syntax_errors_identify_the_source_location() {
        for (text, expected) in [
            ("[]", "Line 1, column 2"), ("[tt]", "Line 1, column 3"), ("q\nw]", "Line 2, column 2"),
            ("q [w", "Line 1, column 3"), ("[[w]]", "Line 1, column 2"), ("[t y]", "Line 1, column 3"),
            ("y\n [#]", "Line 2, column 3"), (r"\a", "Line 1, column 1"), ("t\\", "Line 1, column 2"),
            ("  \n | - -", "at least one"),
        ] {
            assert!(encode(&args(text)).err().unwrap().contains(expected), "{text:?}");
        }
    }

    #[test]
    fn rejects_out_of_range_settings_and_oversized_scores() {
        for (field, value) in [
            ("bpm", json!(19.99)), ("bpm", json!(401)), ("stepsPerBeat", json!(0)), ("stepsPerBeat", json!(9)),
            ("stepsPerBeat", json!(2.5)), ("gatePercent", json!(101)), ("gatePercent", json!(0)), ("gatePercent", json!("80")),
        ] {
            let mut opts = args("t");
            opts[field] = value;
            assert!(encode(&opts).is_err(), "{opts}");
        }
        assert!(encode(&args(&"t".repeat(MAX_TEXT + 1))).err().unwrap().contains("64 KiB"));
        let mut opts = args(&"t".repeat(MAX_NOTES + 1));
        opts["bpm"] = json!(400);
        opts["stepsPerBeat"] = json!(8);
        assert!(encode(&opts).err().unwrap().contains("16,384"));
        let long_rest = format!("t{}t", "-".repeat(14_400));
        assert!(encode(&args(&long_rest)).err().unwrap().contains("one hour"));
    }

    #[test]
    fn reuses_identical_midis_without_overwriting_edited_files() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("midi-studio-vp-{}-{now}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let opts = args("t - y");
        let (first, count, duration) = create(&opts, &dir).unwrap();
        assert_eq!(count, 2);
        assert!(first.starts_with(dir.join("vp-sheets")));
        assert!((MidiFile::open(&first).unwrap().length().unwrap() - duration).abs() < 1e-9);
        assert_eq!(create(&args("t-y"), &dir).unwrap().0, first);
        let original = fs::read(&first).unwrap();
        let edited = vec![42; original.len()];
        fs::write(&first, &edited).unwrap();
        let second = create(&opts, &dir).unwrap().0;
        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), edited);
        assert_eq!(fs::read(&second).unwrap(), original);
        assert_eq!(create(&opts, &dir).unwrap().0, second);
        fs::remove_dir_all(dir).unwrap();
    }
}
