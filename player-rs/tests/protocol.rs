use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use midi_player::{Bridge, Config, Flow};
use serde_json::{json, Value};

fn fixture(dir: &Path) -> String {
    use midly::num::{u15, u24, u28, u4, u7};
    use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};
    let ev = |delta: u32, kind| TrackEvent { delta: u28::new(delta), kind };
    let note = |on: bool, key: u8| TrackEventKind::Midi {
        channel: u4::new(0),
        message: if on {
            MidiMessage::NoteOn { key: u7::new(key), vel: u7::new(90) }
        } else {
            MidiMessage::NoteOff { key: u7::new(key), vel: u7::new(0) }
        },
    };
    let mut track = vec![ev(0, TrackEventKind::Meta(MetaMessage::Tempo(u24::new(400_000))))];
    for (i, n) in [60u8, 64, 67, 61, 20, 109].iter().enumerate() {
        track.push(ev(if i == 0 { 0 } else { 96 }, note(true, *n)));
        track.push(ev(48, note(false, *n)));
    }
    track.push(ev(0, TrackEventKind::Meta(MetaMessage::EndOfTrack)));
    let smf = Smf { header: Header::new(Format::SingleTrack, Timing::Metrical(u15::new(96))), tracks: vec![track] };
    let p = dir.join("proto.mid");
    smf.save(&p).unwrap();
    p.to_string_lossy().into_owned()
}

struct Harness {
    bridge: Bridge,
    events: Arc<Mutex<Vec<Value>>>,
}

impl Harness {
    fn new() -> Harness {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit = Arc::new(move |v: Value| sink.lock().unwrap().push(v));
        let script_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("python-engine");
        let bridge = Bridge::new(emit, Config { script_dir, user_mappings_dir: None, dry_run: true });
        Harness { bridge, events }
    }

    fn mark(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    fn since(&self, at: usize) -> Vec<Value> {
        self.events.lock().unwrap()[at..].to_vec()
    }

    fn send(&self, msg: Value) -> Flow {
        self.bridge.handle(&msg)
    }

    fn wait(&self, at: usize, kind: &str) -> Value {
        let end = Instant::now() + Duration::from_secs(20);
        while Instant::now() < end {
            if let Some(e) = self.since(at).into_iter().find(|e| e["event"] == kind) {
                return e;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("no {kind} event; got {:?}", self.since(at));
    }
}

#[test]
fn bridge_speaks_ipc_main() {
    let h = Harness::new();
    let first = h.since(0);
    assert_eq!(first[0]["message"], "Hotkeys: play=<f6> stop=<f7> pause=<f8>", "logged before ready, as ipc_main");
    h.bridge.ready();
    assert_eq!(h.since(1)[0], json!({"event": "ready"}));

    let at = h.mark();
    h.send(json!({"cmd": "set_hotkeys", "play": "<bogus>"}));
    assert_eq!(h.since(at)[0]["message"], "Failed to bind hotkeys: <bogus>");
    let at = h.mark();
    h.send(json!({"cmd": "set_hotkeys", "play": "", "stop": "", "pause": ""}));
    assert!(h.since(at).is_empty(), "nothing bound, nothing logged");

    let at = h.mark();
    h.send(json!({"cmd": "warp"}));
    h.send(json!({}));
    assert_eq!(h.bridge.handle_line("{nope"), Flow::Continue);
    let errs = h.since(at);
    assert_eq!(errs[0]["message"], "unknown cmd: warp");
    assert_eq!(errs[1]["message"], "unknown cmd: None");
    assert!(errs[2]["message"].as_str().unwrap().starts_with("bad JSON: "));

    let at = h.mark();
    for cmd in ["stop", "pause", "resume", "toggle_pause", "seek"] {
        h.send(json!({"cmd": cmd, "time": 3}));
    }
    assert_eq!(h.since(at), vec![json!({"event": "log", "level": "info", "message": "Stop requested."})]);

    let dir = std::env::temp_dir().join(format!("midi-player-proto-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let midi = fixture(&dir);

    let at = h.mark();
    h.send(json!({"cmd": "load_midi", "path": midi, "mapping": "roblox", "tempo": 1.0}));
    let loaded = h.wait(at, "midi_loaded");
    let keys: Vec<&str> = loaded.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["event", "events", "collapsed_sharps", "report", "mapping_description", "duration", "bpm",
                      "bpm_estimate", "note_to_key", "mapping_name", "unmapped", "transpose"]);
    assert_eq!(loaded["bpm"], json!(150.0));
    assert_eq!(loaded["mapping_name"], "roblox");
    assert_eq!(loaded["events"][0], json!([0.0, "t", 0.2, 60, 0]));
    assert_eq!(loaded["events"].as_array().unwrap().len(), 6, "20 and 109 fold into range instead of dropping");
    assert_eq!(loaded["unmapped"], json!([]));

    let at = h.mark();
    h.send(json!({"cmd": "load_midi", "path": midi, "mapping": "no-such-map"}));
    assert!(h.wait(at, "error")["message"].as_str().unwrap().starts_with("load_midi failed: Mapping file not found"));

    let at = h.mark();
    h.send(json!({"cmd": "export_sheet", "path": midi}));
    let sheet = h.wait(at, "sheet_exported");
    assert_eq!(sheet["notes"], 6);
    let written = std::fs::read_to_string(dir.join("proto.vp.txt")).unwrap();
    assert!(written.starts_with("# proto.mid | virtualpiano | 150 BPM | 6 notes\r\n\r\n"), "{written:?}");

    let at = h.mark();
    h.send(json!({"cmd": "list_windows"}));
    let wins = h.wait(at, "windows")["windows"].as_array().unwrap().clone();
    let Some(target) = wins.first().map(|w| w["hwnd"].clone()) else { return };

    let at = h.mark();
    h.send(json!({"cmd": "play", "midi_path": midi, "target_hwnd": target, "mapping": "roblox",
                  "countdown": 0, "stats": true, "sustain": true}));
    let started = h.wait(at, "playback_started");
    assert_eq!(started, json!({"event": "playback_started", "total_notes": 6, "duration": 3.2,
                               "bpm": 150.0, "start_elapsed": 0.0}));
    let done = h.wait(at, "playback_done");
    assert_eq!(done["sent"], 6);
    assert_eq!(done["stats"]["notes"], 6);
    let kinds: Vec<String> = h.since(at).iter().map(|e| e["event"].as_str().unwrap().to_string()).collect();
    assert!(kinds.contains(&"progress".to_string()));

    let at = h.mark();
    h.send(json!({"cmd": "play", "midi_path": midi, "target_hwnd": target, "mapping": "roblox", "countdown": 2}));
    h.wait(at, "countdown");
    h.send(json!({"cmd": "stop"}));
    std::thread::sleep(Duration::from_millis(2300));
    let after: Vec<Value> = h.since(at);
    assert!(after.iter().all(|e| e["event"] != "playback_started"), "a stop during the count-in is final");
    assert!(after.iter().any(|e| e["message"] == "Cancelled before playback."));

    assert_eq!(h.send(json!({"cmd": "shutdown"})), Flow::Shutdown);
    assert_eq!(*h.since(0).last().unwrap(), json!({"event": "shutdown_ack"}));
    let _ = std::fs::remove_dir_all(dir);
}
