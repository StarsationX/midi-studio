use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use midi_player::keys::{Key, KeyAction, KeySink, Modifier};
use midi_player::mapping::load_mapping;
use midi_player::midi::{bpm_from_onsets, chord_report, events_to_sheet, parse_midi, NoteEvent, ParseOpts};
use midi_player::player::{calibrate_injection, chord_aim_shifts, playback_loop, PlayOpts, State};

#[derive(Clone, Default)]
struct FakeKb {
    log: Arc<Mutex<Vec<(&'static str, String)>>>,
    batches: Arc<Mutex<Vec<usize>>>,
    panic_on_send: Arc<Mutex<Option<usize>>>,
}

impl FakeKb {
    fn log(&self) -> Vec<(&'static str, String)> {
        self.log.lock().unwrap().clone()
    }
}

impl KeySink for FakeKb {
    fn send(&mut self, actions: &[KeyAction]) {
        let n = self.batches.lock().unwrap().len();
        self.batches.lock().unwrap().push(actions.len());
        let mut log = self.log.lock().unwrap();
        for a in actions {
            log.push(match a {
                KeyAction::Down(k) => ("down", k.to_string()),
                KeyAction::Up(k) => ("up", k.to_string()),
            });
        }
        drop(log);
        let fail = self.panic_on_send.lock().unwrap().take_if(|at| *at == n).is_some();
        if fail {
            panic!("sink failed");
        }
    }
}

fn ev(t: f64, key: &str, dur: f64, note: i64) -> NoteEvent {
    NoteEvent { t, key: key.to_string(), dur, note, ch: 0 }
}

fn run(events: &[NoteEvent], opts: &PlayOpts) -> (Vec<(&'static str, String)>, FakeKb) {
    let state = State::new(1.0);
    let mut kb = FakeKb::default();
    playback_loop(events, &state, &mut kb, opts).unwrap();
    (kb.log(), kb)
}

fn d(k: &str) -> (&'static str, String) {
    ("down", k.to_string())
}
fn u(k: &str) -> (&'static str, String) {
    ("up", k.to_string())
}

#[test]
fn sustain_holds_and_retriggers() {
    let events = [ev(0.00, "q", 0.50, 60), ev(0.20, "w", 0.05, 62), ev(0.30, "q", 0.30, 60)];
    let (log, _) = run(&events, &PlayOpts { sustain: true, ..Default::default() });
    let q_downs: Vec<usize> = log.iter().enumerate().filter(|(_, e)| **e == d("q")).map(|(i, _)| i).collect();
    let q_ups: Vec<usize> = log.iter().enumerate().filter(|(_, e)| **e == u("q")).map(|(i, _)| i).collect();
    assert_eq!(log[0], d("q"), "{log:?}");
    assert!(q_downs.len() == 2 && q_ups.len() == 2, "{log:?}");
    assert!(q_ups[0] < q_downs[1], "retrigger releases the held key BEFORE the fresh press: {log:?}");
    assert_eq!(*log.last().unwrap(), u("q"), "final ring-out releases the retriggered q");
    assert!(log.contains(&d("w")) && log.contains(&u("w")), "{log:?}");

    let (log, _) = run(&events, &PlayOpts::default());
    assert_eq!(log, vec![d("q"), u("q"), d("w"), u("w"), d("q"), u("q")], "tap mode unchanged");
}

#[test]
fn shift_and_ctrl_wrap_only_their_own_note() {
    let events = [ev(0.0, "Q", 0.2, 61), ev(0.05, "ctrl+1", 0.2, 21)];
    let (log, _) = run(&events, &PlayOpts::default());
    assert_eq!(log, vec![d("shift"), d("q"), u("q"), u("shift"), d("ctrl"), d("1"), u("1"), u("ctrl")]);
    let (log, _) = run(&events, &PlayOpts { sustain: true, ..Default::default() });
    assert_eq!(log, vec![d("shift"), d("q"), u("shift"), d("ctrl"), d("1"), u("ctrl"), u("q"), u("1")]);
}

#[test]
fn same_timestamp_onsets_share_one_batch() {
    let events = [ev(0.0, "a", 0.1, 60), ev(0.0, "s", 0.1, 64), ev(0.0, "d", 0.1, 67), ev(0.002, "f", 0.1, 69)];
    let (_, kb) = run(&events, &PlayOpts::default());
    assert_eq!(*kb.batches.lock().unwrap(), vec![6, 2], "the 3-note chord is one SendInput, the near-miss is its own");
    let (_, kb) = run(&events, &PlayOpts { batch: false, ..Default::default() });
    assert_eq!(kb.batches.lock().unwrap().len(), 4);
}

#[test]
fn stats_measure_against_the_beat() {
    let events = [ev(0.0, "a", 0.1, 60), ev(0.05, "s", 0.1, 62), ev(0.1, "d", 0.1, 64)];
    let state = State::new(1.0);
    let mut kb = FakeKb::default();
    let errs = playback_loop(&events, &state, &mut kb, &PlayOpts { collect_stats: true, ..Default::default() }).unwrap();
    assert_eq!(errs.len(), 3);
    assert!(errs.iter().all(|e| e.abs() < 0.005), "{errs:?}");
    assert_eq!(state.played_count.load(std::sync::atomic::Ordering::Acquire), 3);
    assert!(state.stopped());
}

#[test]
fn end_at_stops_the_range() {
    let events = [ev(0.0, "a", 0.1, 60), ev(0.05, "s", 0.1, 62), ev(0.3, "d", 0.1, 64)];
    let (log, _) = run(&events, &PlayOpts { end_at: Some(0.1), ..Default::default() });
    assert_eq!(log, vec![d("a"), u("a"), d("s"), u("s")]);
}

fn spawn_play(events: Vec<NoteEvent>, opts: PlayOpts) -> (Arc<State>, FakeKb, std::thread::JoinHandle<()>) {
    let state = Arc::new(State::new(1.0));
    let kb = FakeKb::default();
    let (s, mut k) = (state.clone(), kb.clone());
    let h = std::thread::spawn(move || {
        playback_loop(&events, &s, &mut k, &opts).unwrap();
    });
    (state, kb, h)
}

#[test]
fn user_pause_is_not_undone_by_focus_regain() {
    let events = vec![ev(0.0, "a", 1.0, 60), ev(0.3, "s", 0.1, 62)];
    let (state, kb, h) = spawn_play(events, PlayOpts { sustain: true, ..Default::default() });
    std::thread::sleep(Duration::from_millis(80));
    state.set_user_paused(true);
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(kb.log(), vec![d("a"), u("a")], "pausing releases the held note");
    state.set_focus_lost(true);
    state.set_focus_lost(false);
    std::thread::sleep(Duration::from_millis(400));
    assert!(state.user_paused(), "focus coming back must not resume a user pause");
    assert_eq!(kb.log().len(), 2, "nothing played while paused");
    state.set_user_paused(false);
    h.join().unwrap();
    assert_eq!(kb.log(), vec![d("a"), u("a"), d("s"), u("s")], "resume plays on, and never re-presses the paused note");
}

#[test]
fn stop_is_final_and_releases_held_keys() {
    let events = vec![ev(0.0, "a", 5.0, 60), ev(2.0, "s", 0.1, 62)];
    let (state, kb, h) = spawn_play(events, PlayOpts { sustain: true, ..Default::default() });
    std::thread::sleep(Duration::from_millis(60));
    state.halt();
    h.join().unwrap();
    assert_eq!(kb.log(), vec![d("a"), u("a")]);
}

#[test]
fn seek_skips_ahead_and_releases() {
    let events = vec![ev(0.0, "a", 5.0, 60), ev(1.0, "s", 0.1, 62), ev(5.0, "d", 0.1, 64), ev(5.05, "f", 0.05, 65)];
    let (state, kb, h) = spawn_play(events, PlayOpts { sustain: true, ..Default::default() });
    std::thread::sleep(Duration::from_millis(60));
    state.seek(4.98);
    h.join().unwrap();
    let log = kb.log();
    assert_eq!(&log[..2], &[d("a"), u("a")], "{log:?}");
    assert!(!log.contains(&d("s")), "notes before the seek point are skipped: {log:?}");
    assert!(log.contains(&d("d")) && log.contains(&d("f")), "{log:?}");
}

#[test]
fn live_tempo_retimes_held_keys_and_future_onsets_without_replay() {
    struct Sink<'a> {
        state: &'a State,
        actions: Vec<(KeyAction, Instant)>,
    }
    impl KeySink for Sink<'_> {
        fn send(&mut self, actions: &[KeyAction]) {
            let now = Instant::now();
            self.actions.extend(actions.iter().map(|a| (*a, now)));
            // Change tempo on the second onset, while q is still down.
            if actions.contains(&KeyAction::Down(Key::Char('w'))) {
                self.state.set_tempo(4.0);
            }
        }
    }

    let events = [
        ev(0.0, "q", 1.3, 60), ev(0.1, "w", 0.2, 62), ev(1.0, "e", 0.1, 64),
        ev(1.8, "r", 0.1, 65),
    ];
    let state = State::new(1.0);
    let mut sink = Sink { state: &state, actions: Vec::new() };
    playback_loop(&events, &state, &mut sink, &PlayOpts {
        sustain: true, end_at: Some(1.6), ..Default::default()
    }).unwrap();
    use Key::Char;
    use KeyAction::{Down, Up};
    let keys: Vec<_> = sink.actions.iter().map(|(a, _)| *a).collect();
    assert_eq!(keys, [Down(Char('q')), Down(Char('w')), Up(Char('w')), Down(Char('e')), Up(Char('e')), Up(Char('q'))]);
    let since_change = |index: usize| sink.actions[index].1.duration_since(sink.actions[1].1).as_secs_f64();
    // Wall offsets at 4× are 0.225s and 0.300s. Allow scheduling noise but
    // reject firing immediately, or waiting out the original 0.9s / 1.2s.
    assert!((0.10..0.70).contains(&since_change(3)), "{:?}", sink.actions);
    assert!((0.18..0.90).contains(&since_change(5)), "{:?}", sink.actions);
    assert_eq!(state.played_count.load(std::sync::atomic::Ordering::Acquire), 3);
}

#[test]
fn panic_mid_song_still_releases() {
    let events = vec![ev(0.0, "a", 1.0, 60), ev(0.02, "s", 1.0, 62)];
    let state = State::new(1.0);
    let mut kb = FakeKb::default();
    *kb.panic_on_send.lock().unwrap() = Some(1);
    let r = catch_unwind(AssertUnwindSafe(|| playback_loop(&events, &state, &mut kb, &PlayOpts { sustain: true, ..Default::default() })));
    assert!(r.is_err());
    let log = kb.log();
    assert!(log.contains(&u("a")) && log.contains(&u("s")), "the drop guard lets go of both: {log:?}");
}

#[test]
fn invalid_mapping_value_errors_before_any_key() {
    let state = State::new(1.0);
    let mut kb = FakeKb::default();
    assert!(playback_loop(&[ev(0.0, "ab", 0.1, 60)], &state, &mut kb, &PlayOpts::default()).is_err());
    assert!(kb.log().is_empty());
}

fn tev(t: f64) -> NoteEvent {
    ev(t, "a", 0.2, 60)
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn chord_aim_shifts_match_python() {
    let c = 0.0016;
    assert_eq!(chord_aim_shifts(&[tev(0.0), tev(0.0)], None, false), vec![0.0, 0.0]);
    assert_eq!(chord_aim_shifts(&[tev(0.0), tev(0.0)], Some(0.0), false), vec![0.0, 0.0]);
    assert_eq!(chord_aim_shifts(&[tev(0.0), tev(0.5), tev(1.0)], Some(c), false), vec![0.0; 3], "single notes never move");

    for n in [2usize, 4, 8] {
        let group: Vec<NoteEvent> = if n <= 3 {
            (0..n).map(|k| tev(0.001 * k as f64)).collect()
        } else {
            (0..n).map(|k| tev(0.0002 * k as f64)).collect()
        };
        let s = chord_aim_shifts(&group, Some(c), false);
        let want = (n as f64 - 1.0) * 0.5 * c;
        assert!(s.iter().all(|x| close(*x, want)), "{n} {s:?} {want}");
    }

    assert_eq!(chord_aim_shifts(&[tev(0.0), tev(0.004), tev(0.008)], Some(c), false), vec![0.0; 3]);
    let rolled = [tev(0.0), tev(0.01), tev(0.02), tev(0.03)];
    assert_eq!(chord_aim_shifts(&rolled, Some(c), false), vec![0.0; 4], "a rolled chord is left alone");

    let gap = 0.004;
    let tight: Vec<NoteEvent> = [0.0, 0.0, 0.0, 0.0, gap, gap, gap, gap].iter().map(|t| tev(*t)).collect();
    let s = chord_aim_shifts(&tight, Some(c), false);
    let (first, second) = (s[0], s[4]);
    assert!(close(first, 1.5 * c), "{s:?}");
    let room = gap - ((0.0 - first) + 4.0 * c);
    assert!(close(second, room.max(0.0)), "{second} {room}");
    assert!(second >= 0.0);
    assert!((gap - second) >= (0.0 - first), "aims stay in timeline order");
    let mut distinct = s.clone();
    distinct.dedup();
    assert_eq!(distinct.len(), 2, "{s:?}");
}

#[test]
fn batched_chords_cost_one_injection() {
    let c = 0.0016;
    let chord: Vec<NoteEvent> = (0..8).map(|_| tev(0.0)).collect();
    assert_eq!(chord_aim_shifts(&chord, Some(c), true), vec![0.0; 8], "one SendInput, nothing to centre");
    let near: Vec<NoteEvent> = [0.0, 0.0, 0.001, 0.001].iter().map(|t| tev(*t)).collect();
    assert!(chord_aim_shifts(&near, Some(c), true).iter().all(|x| close(*x, 0.5 * c)), "two batches, two injections");
}

#[test]
#[ignore = "injects VK 0xFF through SendInput; run on purpose with --ignored"]
fn calibration_orders_its_costs() {
    let mut sink = midi_player::win::SendInputSink::new();
    let (aim, press, tap) = calibrate_injection(&mut sink, 8, 4, 0.01).unwrap();
    assert!(aim > 0.0, "{aim}");
    assert!(press <= tap, "{press} {tap}");
}

#[test]
fn bpm_estimate_beats_the_120_default() {
    let step = 60.0 / 174.0 / 4.0;
    let starts: Vec<f64> = (0..64).map(|i| i as f64 * step).collect();
    assert!((bpm_from_onsets(&starts, 120.0) - 174.0).abs() < 2.0);
    assert_eq!(bpm_from_onsets(&[0.0, 1.0], 120.0), 120.0, "too few onsets: keep the fallback");
}

fn engine_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("python-engine")
}

fn fixture() -> PathBuf {
    use midly::num::{u15, u24, u28, u4, u7};
    use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};
    let ev = |delta: u32, kind| TrackEvent { delta: u28::new(delta), kind };
    let note = |on: bool, key: u8| TrackEventKind::Midi {
        channel: u4::new(0),
        message: if on {
            MidiMessage::NoteOn { key: u7::new(key), vel: u7::new(80) }
        } else {
            MidiMessage::NoteOff { key: u7::new(key), vel: u7::new(64) }
        },
    };
    let chord = [48u8, 50, 52, 53, 55, 57, 59, 60];
    let mut track = vec![ev(0, TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))))];
    track.extend(chord.iter().map(|n| ev(0, note(true, *n))));
    track.extend(chord.iter().enumerate().map(|(i, n)| ev(if i == 0 { 480 } else { 0 }, note(false, *n))));
    track.push(ev(480, note(true, 72)));
    track.push(ev(5, note(false, 72)));
    track.push(ev(0, TrackEventKind::Meta(MetaMessage::EndOfTrack)));
    let smf = Smf { header: Header::new(Format::Parallel, Timing::Metrical(u15::new(480))), tracks: vec![track] };
    let p = std::env::temp_dir().join(format!("midi-studio-rs-test-{}.mid", std::process::id()));
    smf.save(&p).unwrap();
    p
}

#[test]
fn play_opts_stagger_hand_report_sheet() {
    let p = fixture();
    let ntk = load_mapping("virtualpiano", &engine_dir()).unwrap().note_to_key;

    let parsed = parse_midi(&p, &ntk, 1.0, &ParseOpts::default()).unwrap();
    let r = chord_report(&parsed.events);
    assert!(r.max_chord == 8 && r.big_chords == 1 && r.short_notes == 1, "{r:?}");
    assert!((parsed.total - 1.0052083).abs() < 1e-6, "{}", parsed.total);
    assert_eq!(parsed.bpm, 120.0);

    let rolled = parse_midi(&p, &ntk, 1.0, &ParseOpts { chord_stagger: 0.005, ..Default::default() }).unwrap().events;
    let ts: Vec<f64> = rolled[..8].iter().map(|e| (e.t * 1000.0).round() / 1000.0).collect();
    let want: Vec<f64> = (0..8).map(|i| (i as f64 * 0.005 * 1000.0).round() / 1000.0).collect();
    assert_eq!(ts, want);
    let notes: Vec<i64> = rolled[..8].iter().map(|e| e.note).collect();
    let mut sorted = notes.clone();
    sorted.sort();
    assert_eq!(notes, sorted, "roll is low to high");

    let right = parse_midi(&p, &ntk, 1.0, &ParseOpts { hand: "right".into(), ..Default::default() }).unwrap().events;
    assert_eq!(right.iter().map(|e| e.note).collect::<Vec<_>>(), vec![60, 72]);
    let left = parse_midi(&p, &ntk, 1.0, &ParseOpts { hand: "left".into(), ..Default::default() }).unwrap().events;
    assert!(left.len() == 7 && left.iter().all(|e| e.note < 60), "{left:?}");

    let sheet = events_to_sheet(&parsed.events, parsed.bpm);
    assert!(sheet.starts_with('[') && sheet.contains('\n'), "{sheet:?}");
    assert!(sheet.contains(ntk[&72].as_str()), "{sheet}");
    assert_eq!(sheet, "[890qwert] - - - s\n");

    let half = parse_midi(&p, &ntk, 2.0, &ParseOpts::default()).unwrap();
    assert_eq!(half.bpm, 240.0);
    assert!((half.events[8].t - 0.5).abs() < 1e-9 && (half.total - 0.50260417).abs() < 1e-6);
    let _ = std::fs::remove_file(p);
}

#[test]
fn mapping_presets_load() {
    for name in midi_player::mapping::PRESETS {
        let m = load_mapping(name, &engine_dir()).unwrap_or_else(|e| panic!("{name}: {e}"));
        for v in m.note_to_key.values() {
            midi_player::keys::Stroke::parse(v).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }
    let ctrl = load_mapping("roblox88ctrl", &engine_dir()).unwrap().note_to_key;
    let s = midi_player::keys::Stroke::parse(&ctrl[&21]).unwrap();
    assert_eq!((s.mods, s.base), (vec![Modifier::Ctrl], Key::Char('1')));
    assert!(load_mapping("nope-not-a-mapping", &engine_dir()).unwrap_err().starts_with("Mapping file not found"));
}
