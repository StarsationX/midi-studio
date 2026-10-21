//! transkun.Data.writeMidi + pretty_midi.PrettyMIDI.write, byte for byte:
//! resolution 960, 120 BPM, track 0 = set_tempo + 4/4, track 1 = piano
//! (program 0, channel 0) with notes and pedal CCs (pitch -64 / -67 ->
//! CC 64 / 67), pretty_midi's event ordering and mido's running status.
//! Also pretty_midi's *reader* for that same layout (used by post::clean).

use crate::transcribe::Note;
use anyhow::{bail, Result};
use midly::num::{u15, u24, u28, u4, u7};
use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};
use std::collections::HashMap;
use std::path::Path;

pub const RESOLUTION: u16 = 960;

/// pretty_midi's tick scale at 120 BPM, resolution 960.
pub fn tick_scale() -> f64 {
    60.0 / (120.0 * RESOLUTION as f64)
}

/// PrettyMIDI.time_to_tick on a fresh object (`__tick_to_time == [0]`).
pub fn time_to_tick(time: f64) -> u32 {
    if time <= 0.0 {
        return 0;
    }
    ((time - 0.0) / tick_scale()).round_ties_even() as u32
}

/// `__tick_to_time[tick]` of a loaded single-tempo file.
pub fn tick_to_time(tick: u32) -> f64 {
    0.0 + tick_scale() * tick as f64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MidiNote {
    pub start: u32,
    pub end: u32,
    pub pitch: u8,
    pub velocity: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MidiCc {
    pub tick: u32,
    pub control: u8,
    pub value: u8,
}

/// One pretty_midi Instrument (program 0, channel 0), in list order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Piano {
    pub notes: Vec<MidiNote>,
    pub control_changes: Vec<MidiCc>,
}

/// writeMidi(): pitch > 0 -> Note, pitch < 0 -> CC(-pitch, vel) on + CC 0 off.
pub fn piano_from_notes(notes: &[Note]) -> Result<Piano> {
    let mut p = Piano::default();
    for n in notes {
        if n.velocity > 127 {
            bail!("velocity out of range");
        }
        if n.pitch > 0 {
            if n.pitch > 127 {
                bail!("pitch out of range: {}", n.pitch);
            }
            p.notes.push(MidiNote { start: time_to_tick(n.start), end: time_to_tick(n.end), pitch: n.pitch as u8, velocity: n.velocity });
        } else {
            let control = (-n.pitch) as u8;
            p.control_changes.push(MidiCc { tick: time_to_tick(n.start), control, value: n.velocity });
            p.control_changes.push(MidiCc { tick: time_to_tick(n.end), control, value: 0 });
        }
    }
    Ok(p)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ev {
    Program,
    NoteOn { key: u8, vel: u8 },
    Cc { ctrl: u8, value: u8 },
}

impl Ev {
    /// pretty_midi event_compare secondary key.
    fn secondary(&self) -> u32 {
        const B: u32 = 256 * 256;
        match *self {
            Ev::Program => 6 * B,
            Ev::Cc { ctrl, value } => 8 * B + ctrl as u32 * 256 + value as u32,
            Ev::NoteOn { key, vel } => 10 * B + key as u32 * 256 + vel as u32,
        }
    }
}

/// The instrument track's events, absolute ticks, in pretty_midi's order.
fn piano_events(p: &Piano) -> Vec<(u32, Ev)> {
    let mut evs: Vec<(u32, Ev)> = vec![(0, Ev::Program)];
    for n in &p.notes {
        evs.push((n.start, Ev::NoteOn { key: n.pitch, vel: n.velocity }));
        evs.push((n.end, Ev::NoteOn { key: n.pitch, vel: 0 }));
    }
    for c in &p.control_changes {
        evs.push((c.tick, Ev::Cc { ctrl: c.control, value: c.value }));
    }
    // sorted(track, key=cmp_to_key(event_compare)): stable on (tick, secondary)
    evs.sort_by_key(|(t, e)| (*t, e.secondary()));
    // note-off-before-note-on fix-up over the pre-pass pairs
    let orig = evs.clone();
    for i in 0..orig.len().saturating_sub(1) {
        if let ((t1, Ev::NoteOn { key: k1, vel: v1 }), (t2, Ev::NoteOn { key: k2, vel: v2 })) = (orig[i], orig[i + 1]) {
            if t1 == t2 && k1 == k2 && v1 != 0 && v2 == 0 {
                evs[i] = orig[i + 1];
                evs[i + 1] = orig[i];
            }
        }
    }
    evs
}

/// PrettyMIDI.write() of a file holding `piano` (None = no instruments).
pub fn piano_to_bytes(piano: Option<&Piano>) -> Result<Vec<u8>> {
    let tempo = (6e7 / (60.0 / (tick_scale() * RESOLUTION as f64))) as u32;
    let mut tracks = vec![vec![
        TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(tempo))) },
        TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::TimeSignature(4, 2, 24, 8)) },
        TrackEvent { delta: u28::new(1), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) },
    ]];
    if let Some(p) = piano {
        let ch = u4::new(0);
        let evs = piano_events(p);
        let mut track = Vec::with_capacity(evs.len() + 1);
        let mut last = 0u32;
        for (t, e) in &evs {
            let message = match *e {
                Ev::Program => MidiMessage::ProgramChange { program: u7::new(0) },
                Ev::NoteOn { key, vel } => MidiMessage::NoteOn { key: u7::new(key), vel: u7::new(vel) },
                Ev::Cc { ctrl, value } => MidiMessage::Controller { controller: u7::new(ctrl), value: u7::new(value) },
            };
            track.push(TrackEvent { delta: u28::new(t - last), kind: TrackEventKind::Midi { channel: ch, message } });
            last = *t;
        }
        track.push(TrackEvent { delta: u28::new(1), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
        tracks.push(track);
    }
    let smf = Smf { header: Header { format: Format::Parallel, timing: Timing::Metrical(u15::new(RESOLUTION)) }, tracks };
    let mut out = Vec::new();
    smf.write_std(&mut out)?;
    Ok(out)
}

pub fn to_bytes(notes: &[Note]) -> Result<Vec<u8>> {
    piano_to_bytes(Some(&piano_from_notes(notes)?))
}

pub fn write(notes: &[Note], path: &Path) -> Result<()> {
    std::fs::write(path, to_bytes(notes)?)?;
    Ok(())
}

/// What `pretty_midi.PrettyMIDI(path).instruments` yields for a file this
/// module wrote: replays the written event stream through pretty_midi's
/// note-on/off pairing (zero-length notes vanish, a note-off closes every
/// earlier open note of that pitch) and straggler-CC rules.
pub fn reload(p: &Piano) -> Option<Piano> {
    let mut open: HashMap<u8, Vec<(u32, u8)>> = HashMap::new();
    let mut notes = Vec::new();
    let mut ccs = Vec::new();
    for (tick, e) in piano_events(p) {
        match e {
            Ev::Program => {}
            Ev::NoteOn { key, vel } if vel > 0 => open.entry(key).or_default().push((tick, vel)),
            Ev::NoteOn { key, .. } => {
                if let Some(list) = open.remove(&key) {
                    let (close, keep): (Vec<_>, Vec<_>) = list.into_iter().partition(|(s, _)| *s != tick);
                    for (s, v) in &close {
                        notes.push(MidiNote { start: *s, end: tick, pitch: key, velocity: *v });
                    }
                    if !close.is_empty() && !keep.is_empty() {
                        open.insert(key, keep);
                    }
                }
            }
            Ev::Cc { ctrl, value } => ccs.push(MidiCc { tick, control: ctrl, value }),
        }
    }
    if notes.is_empty() {
        return None; // only a straggler instrument: dropped by pretty_midi
    }
    Some(Piano { notes, control_changes: ccs })
}
