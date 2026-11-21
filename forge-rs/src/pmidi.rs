//! pretty_midi 0.2.11 (on mido 1.3) as basic-pitch, stem_to_midi.py,
//! melody_to_midi.py and drums_to_midi.py use it: `PrettyMIDI(resolution,
//! initial_tempo)`, `PrettyMIDI(path)` (the reader), `time_to_tick` and
//! `write`, byte for byte.
//!
//! `midi.rs` is the narrow Transkun layout (resolution 960, one piano);
//! this is the general object: any resolution and tempo map, named
//! instruments, drum channel, pitch bends and control changes.

use anyhow::{anyhow, bail, Result};
use midly::num::{u14, u15, u24, u28, u4, u7};
use midly::{Format, Header, MetaMessage, MidiMessage, PitchBend as MidlyBend, Smf, Timing, TrackEvent, TrackEventKind};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Note {
    pub velocity: u8,
    pub pitch: u8,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchBend {
    /// -8192..=8191
    pub pitch: i32,
    pub time: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ControlChange {
    pub number: u8,
    pub value: u8,
    pub time: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Instrument {
    pub program: u8,
    pub is_drum: bool,
    pub name: String,
    pub notes: Vec<Note>,
    pub pitch_bends: Vec<PitchBend>,
    pub control_changes: Vec<ControlChange>,
}

impl Instrument {
    pub fn new(program: u8, is_drum: bool, name: &str) -> Instrument {
        Instrument { program, is_drum, name: name.into(), ..Default::default() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimeSignature {
    pub numerator: u8,
    pub denominator: u8,
    pub time: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrettyMidi {
    pub resolution: u16,
    /// (tick, seconds per tick)
    pub tick_scales: Vec<(u32, f64)>,
    tick_to_time: Vec<f64>,
    pub time_signatures: Vec<TimeSignature>,
    pub instruments: Vec<Instrument>,
}

/// Python's round() on a float: half to even.
#[inline]
fn py_round(x: f64) -> f64 {
    x.round_ties_even()
}

impl PrettyMidi {
    /// `PrettyMIDI(resolution=resolution, initial_tempo=initial_tempo)`.
    pub fn new(resolution: u16, initial_tempo: f64) -> PrettyMidi {
        PrettyMidi {
            resolution,
            tick_scales: vec![(0, 60.0 / (initial_tempo * resolution as f64))],
            tick_to_time: vec![0.0],
            time_signatures: Vec::new(),
            instruments: Vec::new(),
        }
    }

    /// `PrettyMIDI()`: resolution 220, 120 BPM.
    pub fn default_new() -> PrettyMidi {
        PrettyMidi::new(220, 120.0)
    }

    /// Build a conductor track from measured (source seconds, BPM) pairs.
    /// Each transition lands on the nearest tick of the preceding tempo.
    pub fn with_tempo_map(resolution: u16, changes: &[(f64, f64)]) -> PrettyMidi {
        let mut midi = PrettyMidi::new(resolution, 120.0);
        let mut time = 0.0;
        for &(seconds, bpm) in changes {
            if !seconds.is_finite() || seconds < time || !bpm.is_finite() || !(4.0..=1000.0).contains(&bpm) {
                continue;
            }
            let (previous_tick, previous_scale) = *midi.tick_scales.last().unwrap();
            let tick = previous_tick + ((seconds - time) / previous_scale).round() as u32;
            time += f64::from(tick - previous_tick) * previous_scale;
            let scale = (60_000_000.0 / bpm).round() / (1_000_000.0 * f64::from(resolution));
            if tick == previous_tick {
                midi.tick_scales.last_mut().unwrap().1 = scale;
            } else if scale != previous_scale {
                midi.tick_scales.push((tick, scale));
            } else {
                time -= f64::from(tick - previous_tick) * previous_scale;
            }
        }
        midi.update_tick_to_time(0);
        midi
    }

    /// `_update_tick_to_time(max_tick)`.
    fn update_tick_to_time(&mut self, max_tick: u32) {
        let max_scale_tick = self.tick_scales.iter().map(|t| t.0).max().unwrap_or(0);
        let max_tick = if max_tick > max_scale_tick { max_tick } else { max_scale_tick } as usize;
        let mut t2t = vec![0f64; max_tick + 1];
        let mut last_end_time = 0f64;
        for w in self.tick_scales.windows(2) {
            let ((start_tick, tick_scale), (end_tick, _)) = (w[0], w[1]);
            for k in 0..=(end_tick - start_tick) as usize {
                t2t[start_tick as usize + k] = last_end_time + tick_scale * k as f64;
            }
            last_end_time = t2t[end_tick as usize];
        }
        let (start_tick, tick_scale) = *self.tick_scales.last().expect("tick scale");
        for k in 0..(max_tick + 1 - start_tick as usize) {
            t2t[start_tick as usize + k] = last_end_time + tick_scale * k as f64;
        }
        self.tick_to_time = t2t;
    }

    pub fn tick_to_time(&self, tick: u32) -> f64 {
        self.tick_to_time[tick as usize]
    }

    /// `PrettyMIDI.time_to_tick`.
    pub fn time_to_tick(&self, time: f64) -> u32 {
        let t2t = &self.tick_to_time;
        // np.searchsorted(side="left")
        let tick = t2t.partition_point(|&v| v < time);
        if tick == t2t.len() {
            let tick = tick - 1;
            let (_, final_scale) = *self.tick_scales.last().expect("tick scale");
            let t = tick as f64 + (time - t2t[tick]) / final_scale;
            return py_round(t).max(0.0) as u32;
        }
        if tick > 0 && (time - t2t[tick - 1]).abs() < (time - t2t[tick]).abs() {
            (tick - 1) as u32
        } else {
            tick as u32
        }
    }

    /// `PrettyMIDI.write` to bytes.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        const B: i64 = 256 * 256;
        let res = self.resolution as f64;
        // ---- timing track
        // (tick, secondary key, event)
        enum Timing0 {
            Tempo(u32),
            Ts(u8, u8),
        }
        let mut timing: Vec<(u32, i64, Timing0)> = Vec::new();
        let add_ts = match self.time_signatures.iter().map(|t| t.time).reduce(f64::min) {
            Some(m) => m > 0.0,
            None => true,
        };
        if add_ts {
            timing.push((0, 2 * B, Timing0::Ts(4, 4)));
        }
        for &(tick, scale) in &self.tick_scales {
            let tempo = (6e7 / (60.0 / (scale * res))) as u32;
            timing.push((tick, B, Timing0::Tempo(tempo)));
        }
        for ts in &self.time_signatures {
            timing.push((self.time_to_tick(ts.time), 2 * B, Timing0::Ts(ts.numerator, ts.denominator)));
        }
        timing.sort_by_key(|e| (e.0, e.1));
        let mut tracks: Vec<Vec<TrackEvent<'_>>> = Vec::new();
        let mut t0 = Vec::with_capacity(timing.len() + 1);
        let mut last = 0u32;
        for (tick, _, e) in &timing {
            let kind = match *e {
                Timing0::Tempo(t) => TrackEventKind::Meta(MetaMessage::Tempo(u24::new(t))),
                Timing0::Ts(n, d) => {
                    if !d.is_power_of_two() {
                        bail!("time signature denominator {d} is not a power of two");
                    }
                    TrackEventKind::Meta(MetaMessage::TimeSignature(n, d.trailing_zeros() as u8, 24, 8))
                }
            };
            t0.push(TrackEvent { delta: u28::new(tick - last), kind });
            last = *tick;
        }
        t0.push(TrackEvent { delta: u28::new(1), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
        tracks.push(t0);

        // ---- one track per instrument
        let channels: Vec<u8> = (0..16u8).filter(|c| *c != 9).collect();
        #[derive(Clone, Copy, PartialEq)]
        enum Ev {
            Program(u8),
            NoteOn(u8, u8),
            Bend(i32),
            Cc(u8, u8),
        }
        for (n, inst) in self.instruments.iter().enumerate() {
            let channel = if inst.is_drum { 9 } else { channels[n % channels.len()] };
            let mut evs: Vec<(u32, i64, Ev)> = Vec::with_capacity(2 * inst.notes.len() + inst.pitch_bends.len() + inst.control_changes.len() + 1);
            evs.push((0, 6 * B, Ev::Program(inst.program)));
            for nt in &inst.notes {
                if nt.pitch > 127 || nt.velocity > 127 {
                    bail!("note out of range (pitch {}, velocity {})", nt.pitch, nt.velocity);
                }
                evs.push((self.time_to_tick(nt.start), 10 * B + nt.pitch as i64 * 256 + nt.velocity as i64, Ev::NoteOn(nt.pitch, nt.velocity)));
                evs.push((self.time_to_tick(nt.end), 10 * B + nt.pitch as i64 * 256, Ev::NoteOn(nt.pitch, 0)));
            }
            for b in &inst.pitch_bends {
                if !(-8192..=8191).contains(&b.pitch) {
                    bail!("pitch bend {} out of range", b.pitch);
                }
                evs.push((self.time_to_tick(b.time), 7 * B + b.pitch as i64, Ev::Bend(b.pitch)));
            }
            for c in &inst.control_changes {
                evs.push((self.time_to_tick(c.time), 8 * B + c.number as i64 * 256 + c.value as i64, Ev::Cc(c.number, c.value)));
            }
            // sorted(track, key=cmp_to_key(event_compare)), stable; the
            // track_name meta (outside the comparator's table) stays first.
            evs.sort_by_key(|e| (e.0, e.1));
            let orig = evs.clone();
            for i in 0..orig.len().saturating_sub(1) {
                if let ((t1, _, Ev::NoteOn(k1, v1)), (t2, _, Ev::NoteOn(k2, v2))) = (orig[i], orig[i + 1]) {
                    if t1 == t2 && k1 == k2 && v1 != 0 && v2 == 0 {
                        evs[i] = orig[i + 1];
                        evs[i + 1] = orig[i];
                    }
                }
            }
            let ch = u4::new(channel);
            let mut track = Vec::with_capacity(evs.len() + 2);
            if !inst.name.is_empty() {
                track.push(TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::TrackName(inst.name.as_bytes())) });
            }
            let mut last = 0u32;
            for (t, _, e) in &evs {
                let message = match *e {
                    Ev::Program(p) => MidiMessage::ProgramChange { program: u7::new(p) },
                    Ev::NoteOn(k, v) => MidiMessage::NoteOn { key: u7::new(k), vel: u7::new(v) },
                    Ev::Bend(p) => MidiMessage::PitchBend { bend: MidlyBend(u14::new((p + 8192) as u16)) },
                    Ev::Cc(c, v) => MidiMessage::Controller { controller: u7::new(c), value: u7::new(v) },
                };
                track.push(TrackEvent { delta: u28::new(t - last), kind: TrackEventKind::Midi { channel: ch, message } });
                last = *t;
            }
            track.push(TrackEvent { delta: u28::new(1), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
            tracks.push(track);
        }
        let smf = Smf { header: Header { format: Format::Parallel, timing: Timing::Metrical(u15::new(self.resolution)) }, tracks };
        let mut out = Vec::new();
        smf.write_std(&mut out)?;
        Ok(out)
    }

    pub fn write(&self, path: &std::path::Path) -> Result<()> {
        if let Some(d) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, self.to_bytes()?).map_err(|e| anyhow!("write {}: {e}", path.display()))
    }

    /// `PrettyMIDI(path)`: tempo map and time signatures from track 0,
    /// instruments per (program, channel, track) created at their first
    /// note-off, pretty_midi's note pairing and straggler rules.
    pub fn from_bytes(bytes: &[u8]) -> Result<PrettyMidi> {
        let smf = Smf::parse(bytes).map_err(|e| anyhow!("{e}"))?;
        let resolution = match smf.header.timing {
            Timing::Metrical(t) => t.as_int(),
            Timing::Timecode(..) => bail!("SMPTE-timed MIDI is not supported"),
        };
        // absolute ticks
        let tracks: Vec<Vec<(u32, TrackEventKind<'_>)>> = smf
            .tracks
            .iter()
            .map(|t| {
                let mut tick = 0u32;
                t.iter()
                    .map(|e| {
                        tick += e.delta.as_int();
                        (tick, e.kind)
                    })
                    .collect()
            })
            .collect();
        let max_tick = tracks.iter().filter_map(|t| t.iter().map(|e| e.0).max()).max().unwrap_or(0) + 1;
        let mut pm = PrettyMidi { resolution, tick_scales: vec![(0, 60.0 / (120.0 * resolution as f64))], tick_to_time: vec![0.0], time_signatures: Vec::new(), instruments: Vec::new() };
        let res = resolution as f64;
        if let Some(t0) = tracks.first() {
            for (tick, kind) in t0 {
                if let TrackEventKind::Meta(MetaMessage::Tempo(t)) = kind {
                    let tempo = t.as_int() as f64;
                    if *tick == 0 {
                        let bpm = 6e7 / tempo;
                        pm.tick_scales = vec![(0, 60.0 / (bpm * res))];
                    } else {
                        let last_scale = pm.tick_scales.last().expect("tick scale").1;
                        let scale = 60.0 / ((6e7 / tempo) * res);
                        if scale != last_scale {
                            pm.tick_scales.push((*tick, scale));
                        }
                    }
                }
            }
        }
        pm.update_tick_to_time(max_tick);
        if let Some(t0) = tracks.first() {
            for (tick, kind) in t0 {
                if let TrackEventKind::Meta(MetaMessage::TimeSignature(n, d, _, _)) = kind {
                    pm.time_signatures.push(TimeSignature { numerator: *n, denominator: 1u8 << d, time: pm.tick_to_time(*tick) });
                }
            }
        }

        // _load_instruments
        let mut order: Vec<(u8, u8, usize)> = Vec::new();
        let mut map: HashMap<(u8, u8, usize), Instrument> = HashMap::new();
        let mut stragglers: HashMap<(u8, usize), Instrument> = HashMap::new();
        let mut track_names: HashMap<usize, String> = HashMap::new();
        for (track_idx, track) in tracks.iter().enumerate() {
            let mut last_note_on: HashMap<(u8, u8), Vec<(u32, u8)>> = HashMap::new();
            let mut current = [0u8; 16];
            for (tick, kind) in track {
                if let TrackEventKind::Meta(MetaMessage::TrackName(name)) = kind {
                    let name = match std::str::from_utf8(name) {
                        Ok(text) => text.to_owned(),
                        Err(_) => name.iter().copied().map(char::from).collect(),
                    };
                    track_names.insert(track_idx, name);
                }
                let TrackEventKind::Midi { channel, message } = kind else { continue };
                let ch = channel.as_int();
                let name = track_names.get(&track_idx).cloned().unwrap_or_default();
                match *message {
                    MidiMessage::ProgramChange { program } => current[ch as usize] = program.as_int(),
                    MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                        last_note_on.entry((ch, key.as_int())).or_default().push((*tick, vel.as_int()));
                    }
                    MidiMessage::NoteOn { key, .. } | MidiMessage::NoteOff { key, .. } => {
                        let k = (ch, key.as_int());
                        let Some(open) = last_note_on.remove(&k) else { continue };
                        let end_tick = *tick;
                        let (close, keep): (Vec<_>, Vec<_>) = open.into_iter().partition(|(s, _)| *s != end_tick);
                        for (start_tick, velocity) in &close {
                            let note = Note { velocity: *velocity, pitch: key.as_int(), start: pm.tick_to_time(*start_tick), end: pm.tick_to_time(end_tick) };
                            let program = current[ch as usize];
                            let id = (program, ch, track_idx);
                            if !map.contains_key(&id) {
                                let mut inst = Instrument::new(program, ch == 9, &name);
                                if let Some(s) = stragglers.get(&(ch, track_idx)) {
                                    inst.control_changes = s.control_changes.clone();
                                    inst.pitch_bends = s.pitch_bends.clone();
                                }
                                map.insert(id, inst);
                                order.push(id);
                            }
                            map.get_mut(&id).expect("instrument").notes.push(note);
                        }
                        if !close.is_empty() && !keep.is_empty() {
                            last_note_on.insert(k, keep);
                        }
                    }
                    MidiMessage::PitchBend { bend } => {
                        let b = PitchBend { pitch: bend.as_int() as i32, time: pm.tick_to_time(*tick) };
                        let id = (current[ch as usize], ch, track_idx);
                        match map.get_mut(&id) {
                            Some(inst) => inst.pitch_bends.push(b),
                            None => stragglers.entry((ch, track_idx)).or_insert_with(|| Instrument::new(id.0, false, &name)).pitch_bends.push(b),
                        }
                    }
                    MidiMessage::Controller { controller, value } => {
                        let c = ControlChange { number: controller.as_int(), value: value.as_int(), time: pm.tick_to_time(*tick) };
                        let id = (current[ch as usize], ch, track_idx);
                        match map.get_mut(&id) {
                            Some(inst) => inst.control_changes.push(c),
                            None => stragglers.entry((ch, track_idx)).or_insert_with(|| Instrument::new(id.0, false, &name)).control_changes.push(c),
                        }
                    }
                    _ => {}
                }
            }
        }
        pm.instruments = order.into_iter().map(|id| map.remove(&id).expect("instrument")).collect();
        Ok(pm)
    }

    pub fn read(path: &std::path::Path) -> Result<PrettyMidi> {
        let bytes = std::fs::read(path).map_err(|e| anyhow!("read {}: {e}", path.display()))?;
        PrettyMidi::from_bytes(&bytes)
    }

    pub fn note_count(&self) -> usize {
        self.instruments.iter().map(|i| i.notes.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_time_to_tick_rounds_half_even() {
        let pm = PrettyMidi::default_new();
        let s = 60.0 / (120.0 * 220.0);
        assert_eq!(pm.time_to_tick(0.0), 0);
        assert_eq!(pm.time_to_tick(-1.0), 0);
        assert_eq!(pm.time_to_tick(2.5 * s), 2);
        assert_eq!(pm.time_to_tick(3.5 * s), 4);
    }

    #[test]
    fn round_trip_keeps_ticks_and_bends() {
        let mut pm = PrettyMidi::default_new();
        let mut inst = Instrument::new(4, false, "夢のこたえ");
        inst.notes.push(Note { velocity: 80, pitch: 60, start: 0.1, end: 0.5 });
        inst.notes.push(Note { velocity: 90, pitch: 64, start: 0.1, end: 0.3 });
        inst.pitch_bends.push(PitchBend { pitch: -1365, time: 0.1 });
        inst.pitch_bends.push(PitchBend { pitch: 0, time: 0.3 });
        pm.instruments.push(inst);
        let bytes = pm.to_bytes().unwrap();
        let back = PrettyMidi::from_bytes(&bytes).unwrap();
        assert_eq!(back.instruments.len(), 1);
        assert_eq!(back.instruments[0].name, "夢のこたえ");
        assert_eq!(back.instruments[0].notes.len(), 2);
        assert_eq!(back.instruments[0].pitch_bends.len(), 2);
        assert_eq!(back.to_bytes().unwrap(), bytes, "a reloaded file writes back identically");
    }

    #[test]
    fn reads_legacy_latin1_track_name() {
        let bytes = b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk\0\0\0\x14\0\xff\x03\x04Caf\xe9\0\x90\x3c\x40\x60\x80\x3c\0\0\xff\x2f\0";
        let midi = PrettyMidi::from_bytes(bytes).unwrap();
        assert_eq!(midi.instruments[0].name, "Café");
    }
}
