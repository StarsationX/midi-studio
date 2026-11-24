use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::hotkeys::{parse_combo, Combo, HotkeyListener};
use crate::keys::{Key, KeyAction, KeySink, PANIC_MODIFIERS};
use crate::mapping::{load_mapping, resolve_mapping, Mapping};
use crate::midi::{best_transpose, chord_report, events_to_sheet, parse_midi, py_round, ParseOpts, Parsed};
use crate::player::{calibrate_injection, playback_loop, PlayOpts, State};
use crate::py;
use crate::win::{focus_window, focused_hwnd, list_windows, window_alive, LogSink, SendInputSink, Window};

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct Config {
    pub script_dir: PathBuf,
    pub user_mappings_dir: Option<PathBuf>,
    pub dry_run: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Shutdown,
}

const FALLBACK_INJECT: f64 = 0.0015;

/// (field in set_hotkeys, default when the field is absent). The hotkey event
/// name is the field name.
const HOTKEY_SLOTS: [(&str, &str); 10] = [
    ("play", "<f6>"),
    ("stop", "<f7>"),
    ("pause", "<f8>"),
    ("tempo_up", ""),
    ("tempo_down", ""),
    ("tempo_set", ""),
    ("seek_fwd", ""),
    ("next_track", ""),
    ("prev_track", ""),
    ("seek_back", ""),
];

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}

struct Hotkeys {
    combos: [String; 10],
    listener: Option<HotkeyListener>,
}

struct Inner {
    emit: Emit,
    cfg: Config,
    state: Mutex<Option<Arc<State>>>,
    target: Mutex<Option<Window>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    last_play: Mutex<Option<Value>>,
    inject: Mutex<Option<(f64, f64, f64)>>,
    hotkeys: Mutex<Hotkeys>,
}

/// The engine behind ipc_main.py's protocol. `handle` takes one inbound
/// command object; everything outbound goes through `emit`.
#[derive(Clone)]
pub struct Bridge {
    inner: Arc<Inner>,
}

impl Inner {
    fn emit(&self, v: Value) {
        (self.emit)(v)
    }

    fn log(&self, level: &str, message: impl Into<String>) {
        self.emit(json!({"event": "log", "level": level, "message": message.into()}));
    }

    fn error(&self, message: impl Into<String>) {
        self.emit(json!({"event": "error", "message": message.into()}));
    }

    fn sink(&self) -> Box<dyn KeySink> {
        if self.cfg.dry_run { Box::new(LogSink::new()) } else { Box::new(SendInputSink::new()) }
    }

    fn mapping(&self, arg: &str) -> Result<Mapping, String> {
        load_mapping(&resolve_mapping(arg, self.cfg.user_mappings_dir.as_deref()), &self.cfg.script_dir)
    }

    fn focus(&self, w: &Window) -> bool {
        self.cfg.dry_run || focus_window(w.hwnd)
    }
}

fn resolve_window(hwnd: i64) -> Option<Window> {
    list_windows().into_iter().find(|w| w.hwnd as i64 == hwnd)
}

/// `_play_opts`: shared by load/play/export so the visualizer, the keys sent
/// and the sheet all agree on which notes exist and when.
fn play_opts(msg: &Value, transpose: i64) -> ParseOpts {
    let stagger = py::get_truthy(msg, "chord_stagger_ms").map_or(Ok(0.0), py::float).unwrap_or(0.0) / 1000.0;
    let split = py::int_or_falsy(msg, "hand_split", 60).unwrap_or(60);
    let hand = py::get_truthy(msg, "hand").and_then(Value::as_str).unwrap_or("both").to_string();
    ParseOpts { transpose, fold: true, hand, hand_split: split, chord_stagger: stagger }
}

fn event_rows(p: &Parsed) -> Value {
    Value::Array(
        p.events
            .iter()
            .map(|e| json!([py_round(e.t, 6), e.key, py_round(e.dur, 6), e.note, e.ch]))
            .collect(),
    )
}

fn stats_payload(errors: &[f64]) -> Value {
    if errors.is_empty() {
        return Value::Null;
    }
    let ms: Vec<f64> = errors.iter().map(|e| e * 1000.0).collect();
    let n = ms.len() as f64;
    let mean = ms.iter().sum::<f64>() / n;
    let mut sorted = ms.clone();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    let median = if sorted.len() % 2 == 1 { sorted[mid] } else { (sorted[mid - 1] + sorted[mid]) / 2.0 };
    let stdev = if ms.len() > 1 {
        (ms.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
    } else {
        0.0
    };
    json!({
        "notes": ms.len(),
        "mean_ms": mean,
        "median_ms": median,
        "stdev_ms": stdev,
        "min_ms": sorted[0],
        "max_ms": sorted[sorted.len() - 1],
        "over_5ms": ms.iter().filter(|e| e.abs() > 5.0).count(),
    })
}

impl Bridge {
    pub fn new(emit: Emit, cfg: Config) -> Bridge {
        let combos: [String; 10] = HOTKEY_SLOTS.map(|(_, d)| d.to_string());
        let bridge = Bridge {
            inner: Arc::new(Inner {
                emit,
                cfg,
                state: Mutex::new(None),
                target: Mutex::new(None),
                thread: Mutex::new(None),
                last_play: Mutex::new(None),
                inject: Mutex::new(None),
                hotkeys: Mutex::new(Hotkeys { combos, listener: None }),
            }),
        };
        bridge.restart_hotkeys();
        bridge
    }

    /// The `ready` handshake, then the injection calibration on a background
    /// thread so the first Play finds it already measured.
    pub fn ready(&self) {
        self.inner.emit(json!({"event": "ready"}));
        if self.inner.cfg.dry_run {
            self.inner.log("info", "Dry run: keystrokes go to stderr, nothing is sent and no window is focused.");
        }
        let b = self.clone();
        let _ = std::thread::Builder::new().name("calibrate-injection".into()).spawn(move || {
            let _ = catch_unwind(AssertUnwindSafe(|| b.injection_cost()));
        });
    }

    pub fn handle_line(&self, line: &str) -> Flow {
        let line = line.trim();
        if line.is_empty() {
            return Flow::Continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(msg) => self.handle(&msg),
            Err(e) => {
                self.inner.error(format!("bad JSON: {e}"));
                Flow::Continue
            }
        }
    }

    pub fn handle(&self, msg: &Value) -> Flow {
        let cmd = msg.get("cmd").cloned().unwrap_or(Value::Null);
        let name = cmd.as_str().unwrap_or("");
        let run = |f: &dyn Fn(&Bridge, &Value)| -> Flow {
            if let Err(p) = catch_unwind(AssertUnwindSafe(|| f(self, msg))) {
                self.inner.error(panic_text(p));
            }
            Flow::Continue
        };
        match name {
            "list_windows" => run(&|b, _| b.cmd_list_windows()),
            "load_midi" => run(&Bridge::cmd_load_midi),
            "play" => run(&Bridge::cmd_play),
            "stop" => run(&|b, _| b.cmd_stop()),
            "pause" => run(&|b, _| b.cmd_pause()),
            "resume" => run(&|b, _| b.cmd_resume()),
            "toggle_pause" => run(&|b, _| b.cmd_toggle_pause()),
            "seek" => run(&Bridge::cmd_seek),
            "set_tempo" => run(&Bridge::cmd_set_tempo),
            "refocus" => run(&|b, _| b.cmd_refocus()),
            "set_hotkeys" => run(&Bridge::cmd_set_hotkeys),
            "export_sheet" => run(&Bridge::cmd_export_sheet),
            "shutdown" => {
                self.cmd_shutdown();
                Flow::Shutdown
            }
            _ => {
                self.inner.error(format!("unknown cmd: {}", py::text(&cmd)));
                Flow::Continue
            }
        }
    }

    fn cmd_list_windows(&self) {
        let mut wins: Vec<Window> = list_windows().into_iter().filter(|w| !w.title.is_empty()).collect();
        wins.sort_by_cached_key(|w| (w.process.to_lowercase(), w.title.to_lowercase()));
        let rows: Vec<Value> = wins
            .iter()
            .map(|w| json!({"hwnd": w.hwnd as i64, "pid": w.pid, "process": w.process, "title": w.title}))
            .collect();
        self.inner.emit(json!({"event": "windows", "windows": rows}));
    }

    fn cmd_load_midi(&self, msg: &Value) {
        if let Err(e) = self.load_midi(msg) {
            self.inner.error(format!("load_midi failed: {e}"));
        }
    }

    fn load_midi(&self, msg: &Value) -> Result<(), String> {
        let mapping_arg = py::req(msg, "mapping")?;
        let mapping = self.inner.mapping(mapping_arg.as_str().ok_or("'mapping' must be a string")?)?;
        let ntk = &mapping.note_to_key;
        let tempo = py::float_or(msg, "tempo", 1.0)?;
        let mut transpose = py::int_or_falsy(msg, "transpose", 0)?;
        let path = py::req_str(msg, "path")?;
        if py::get_truthy(msg, "auto_transpose").is_some() {
            transpose = best_transpose(path, ntk, 12).0;
        }
        let p = parse_midi(path, ntk, tempo, &play_opts(msg, transpose))?;
        let collapsed = p
            .events
            .iter()
            .filter(|e| {
                let m = e.note + transpose;
                [1, 3, 6, 8, 10].contains(&m.rem_euclid(12)) && ntk.get(&m).is_some() && ntk.get(&m) == ntk.get(&(m - 1))
            })
            .count();
        let r = chord_report(&p.events);
        let note_to_key: Map<String, Value> = ntk.iter().map(|(k, v)| (k.to_string(), Value::String(v.clone()))).collect();
        self.inner.emit(json!({
            "event": "midi_loaded",
            "path": path,
            "events": event_rows(&p),
            "collapsed_sharps": collapsed,
            "report": {"max_chord": r.max_chord, "big_chords": r.big_chords,
                       "ghost_limit": r.ghost_limit, "short_notes": r.short_notes},
            "mapping_description": mapping.get("description").cloned().unwrap_or(json!("")),
            "duration": py_round(p.total, 3),
            "bpm": py_round(p.bpm, 2),
            "bpm_estimate": py_round(p.bpm_estimate, 2),
            "note_to_key": note_to_key,
            "mapping_name": mapping.get("name").cloned().unwrap_or_else(|| mapping_arg.clone()),
            "unmapped": p.unmapped,
            "transpose": transpose,
        }));
        Ok(())
    }

    fn cmd_export_sheet(&self, msg: &Value) {
        if let Err(e) = self.export_sheet(msg) {
            self.inner.error(format!("export_sheet failed: {e}"));
        }
    }

    fn export_sheet(&self, msg: &Value) -> Result<(), String> {
        let path = py::req_str(msg, "path")?;
        let arg = py::get_truthy(msg, "mapping").and_then(Value::as_str).unwrap_or("virtualpiano");
        let mapping = self.inner.mapping(arg)?;
        let transpose = py::int_or_falsy(msg, "transpose", 0)?;
        let p = parse_midi(path, &mapping.note_to_key, 1.0, &play_opts(msg, transpose))?;
        let asked = py::get_truthy(msg, "bpm").map_or(Ok(0.0), py::float)?;
        let use_bpm = if asked != 0.0 { asked } else { p.bpm };
        let text = events_to_sheet(&p.events, use_bpm);
        let out = Path::new(path).with_extension("vp.txt").to_string_lossy().into_owned();
        let base = Path::new(path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let name = mapping.get("name").map(py::text).unwrap_or_default();
        let mut header = format!("# {base} | {name} | {use_bpm:.0} BPM | {} notes", p.events.len());
        if !p.unmapped.is_empty() {
            header.push_str(&format!(" | {} out of range skipped", p.unmapped.len()));
        }
        header.push_str("\n\n");
        std::fs::write(&out, (header + &text).replace('\n', "\r\n")).map_err(|e| e.to_string())?;
        self.inner.emit(json!({"event": "sheet_exported", "path": out, "text": text,
                               "notes": p.events.len(), "unmapped": p.unmapped.len()}));
        Ok(())
    }

    fn cmd_play(&self, msg: &Value) {
        let inner = &self.inner;
        let mut slot = lock(&inner.thread);
        if let Some(h) = slot.as_ref() {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !h.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if !h.is_finished() {
                inner.log("warn", "Play requested but a session is already running.");
                return;
            }
        }
        let tempo = match py::float_or(msg, "tempo", 1.0) {
            Ok(v) if v.is_finite() && v > 0.0 => v,
            _ => {
                inner.error("Play tempo must be positive and finite.");
                return;
            }
        };
        // Install controls before the worker parses/focuses/counts in: an
        // immediate follow-up command belongs to this play, not the next one.
        let state = Arc::new(State::new(tempo));
        *lock(&inner.state) = Some(state.clone());
        *lock(&inner.last_play) = Some(msg.clone());
        let b = self.clone();
        let msg = msg.clone();
        match std::thread::Builder::new().name("session".into()).spawn(move || b.run_session(&msg, &state, tempo)) {
            Ok(h) => *slot = Some(h),
            Err(e) => {
                lock(&inner.state).take();
                inner.error(e.to_string());
            }
        }
    }

    fn cmd_stop(&self) {
        if let Some(s) = lock(&self.inner.state).as_ref() {
            s.halt();
        }
        self.inner.log("info", "Stop requested.");
    }

    fn session_state(&self) -> Option<Arc<State>> {
        lock(&self.inner.state).clone()
    }

    fn cmd_pause(&self) {
        if let Some(s) = self.session_state() {
            if !s.user_paused() {
                s.set_user_paused(true);
                self.inner.log("info", "Paused.");
            }
        }
    }

    fn cmd_resume(&self) {
        if let Some(s) = self.session_state() {
            if s.user_paused() {
                s.set_user_paused(false);
                self.inner.log("info", if s.focus_lost() { "Resumed (still waiting on target focus)." } else { "Resumed." });
            }
        }
    }

    fn cmd_toggle_pause(&self) {
        if let Some(s) = self.session_state() {
            if s.user_paused() { self.cmd_resume() } else { self.cmd_pause() }
        }
    }

    fn cmd_seek(&self, msg: &Value) {
        let Some(s) = self.session_state() else { return };
        let Ok(t) = py::float_or(msg, "time", 0.0) else { return };
        s.seek(t);
    }

    fn cmd_set_tempo(&self, msg: &Value) {
        if let (Some(s), Some(tempo)) = (self.session_state(), msg.get("tempo").and_then(Value::as_f64)) {
            s.set_tempo(tempo);
        }
    }

    fn cmd_refocus(&self) {
        let inner = &self.inner;
        let mut target = lock(&inner.target).clone();
        if target.is_none() {
            let hwnd = lock(&inner.last_play).as_ref().and_then(|m| m.get("target_hwnd").and_then(|v| py::int(v).ok()));
            target = hwnd.and_then(resolve_window);
        }
        match target {
            None => inner.log("warn", "Target window is no longer available. Refresh the target list."),
            Some(w) if inner.focus(&w) => inner.log("info", "Target focused. Playback will resume."),
            Some(_) => inner.log("warn", "Windows blocked target focus. Click the target window once to resume."),
        }
    }

    fn cmd_set_hotkeys(&self, msg: &Value) {
        {
            let mut hk = lock(&self.inner.hotkeys);
            for (i, (field, default)) in HOTKEY_SLOTS.iter().enumerate() {
                hk.combos[i] = match msg.get(*field) {
                    None => default.to_string(),
                    Some(v) if !py::truthy(v) => String::new(),
                    Some(v) => py::text(v),
                };
            }
        }
        self.restart_hotkeys();
    }

    fn restart_hotkeys(&self) {
        let inner = &self.inner;
        let mut hk = lock(&inner.hotkeys);
        if let Some(l) = hk.listener.take() {
            l.stop();
        }
        let mut bindings: IndexMap<String, &str> = IndexMap::new();
        for (i, (name, _)) in HOTKEY_SLOTS.iter().enumerate() {
            if !hk.combos[i].is_empty() {
                bindings.insert(hk.combos[i].clone(), name);
            }
        }
        if bindings.is_empty() {
            return;
        }
        let combos: Result<Vec<Combo>, String> =
            bindings.iter().map(|(c, name)| parse_combo(c).map(|keys| Combo::new(name, keys))).collect();
        let emit = inner.emit.clone();
        let fire = Arc::new(move |name: &str| emit(json!({"event": "hotkey", "name": name})));
        match combos.and_then(|c| HotkeyListener::start(c, fire)) {
            Ok(l) => {
                hk.listener = Some(l);
                let c = &hk.combos;
                let mut line = format!("Hotkeys: play={} stop={} pause={}", c[0], c[1], c[2]);
                if !c[3].is_empty() {
                    line.push_str(&format!(" tempo+={}", c[3]));
                }
                if !c[4].is_empty() {
                    line.push_str(&format!(" tempo-={}", c[4]));
                }
                if !c[5].is_empty() {
                    line.push_str(&format!(" tempo=set:{}", c[5]));
                }
                inner.log("info", line);
            }
            Err(e) => inner.log("error", format!("Failed to bind hotkeys: {e}")),
        }
    }

    fn cmd_shutdown(&self) {
        if let Some(s) = self.session_state() {
            s.halt();
        }
        if let Some(l) = lock(&self.inner.hotkeys).listener.take() {
            l.stop();
        }
        self.inner.emit(json!({"event": "shutdown_ack"}));
        std::thread::sleep(Duration::from_millis(50));
    }

    /// Stop playback and make sure nothing is left physically held down: wait
    /// for the session to unwind (its keyboard releases what it holds), then
    /// release the modifiers as a backstop.
    pub fn panic_release(&self, timeout: Duration) {
        if let Some(s) = self.session_state() {
            s.halt();
        }
        if let Some(h) = lock(&self.inner.thread).as_ref() {
            let deadline = Instant::now() + timeout;
            while !h.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let ups: Vec<KeyAction> = PANIC_MODIFIERS.iter().map(|m| KeyAction::Up(Key::Mod(*m))).collect();
        self.inner.sink().send(&ups);
    }

    /// (aim, chord_press, chord_tap), measured once per process and cached.
    /// The lock is held across the measurement, so a Play arriving mid-way
    /// waits for the result instead of starting a second, interleaved one.
    fn injection_cost(&self) -> (f64, f64, f64) {
        let inner = &self.inner;
        let mut slot = lock(&inner.inject);
        if let Some(c) = *slot {
            return c;
        }
        let fb = (FALLBACK_INJECT, FALLBACK_INJECT, FALLBACK_INJECT);
        let measured = if inner.cfg.dry_run {
            None
        } else {
            calibrate_injection(&mut SendInputSink::new(), 24, 10, 0.015)
        };
        let cost = match measured {
            Some((aim, press, tap)) if aim > 0.0 && aim <= 0.006 && press > 0.0 && press <= 0.012 && press <= tap && tap <= 0.020 => {
                (aim, press, tap)
            }
            _ => {
                if !inner.cfg.dry_run {
                    inner.log("warn", "Keypress calibration out of range, using the fixed 1.5 ms offset.");
                }
                fb
            }
        };
        *slot = Some(cost);
        cost
    }

    fn run_session(&self, msg: &Value, state: &Arc<State>, initial_tempo: f64) {
        let result = catch_unwind(AssertUnwindSafe(|| self.session(msg, state, initial_tempo)));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => self.inner.error(e),
            Err(p) => self.inner.error(panic_text(p)),
        }
        if let Some(s) = lock(&self.inner.state).take() {
            s.halt();
        }
        lock(&self.inner.target).take();
    }

    fn session(&self, msg: &Value, state: &Arc<State>, initial_tempo: f64) -> Result<(), String> {
        let inner = &self.inner;
        let target_hwnd = py::int(py::req(msg, "target_hwnd")?)?;
        let mapping_arg = py::req_str(msg, "mapping")?;
        let countdown = py::int_or(msg, "countdown", 3)?;
        let collect_stats = msg.get("stats").is_some_and(py::truthy);
        let sustain = msg.get("sustain").is_some_and(py::truthy);
        let midi_path = py::req_str(msg, "midi_path")?;
        let start_at = py::float_or(msg, "start_at", 0.0).unwrap_or(0.0);
        let start_at = start_at.max(0.0) * initial_tempo;
        let mut end_at = match msg.get("end_at") {
            None | Some(Value::Null) => None,
            Some(v) => py::float(v).ok().map(|e| e * initial_tempo),
        };

        let Some(target) = resolve_window(target_hwnd) else {
            return Err("Target window no longer exists.".into());
        };
        *lock(&inner.target) = Some(target.clone());

        let mapping = inner.mapping(mapping_arg)?;
        let transpose = py::int_or_falsy(msg, "transpose", 0)?;
        let p = parse_midi(midi_path, &mapping.note_to_key, 1.0, &play_opts(msg, transpose))?;
        if p.events.is_empty() {
            return Err("MIDI has no playable events.".into());
        }
        if let Some(e) = end_at {
            let e = e.min(p.total).max(0.0);
            if e <= start_at {
                return Err("Playback range stop must be after start.".into());
            }
            end_at = Some(e);
        }
        state.prepare(p.total, start_at);

        let name = mapping.get("name").map(py::text).unwrap_or_else(|| mapping_arg.to_string());
        inner.log("info", format!("Mapping {name} ({} notes)", mapping.note_to_key.len()));
        inner.log("info", format!("{} events, {:.1}s, ~{:.1} BPM", p.events.len(), p.total / initial_tempo, p.bpm * initial_tempo));
        if !p.unmapped.is_empty() {
            let list: Vec<String> = p.unmapped.iter().map(|n| n.to_string()).collect();
            inner.log("warn", format!("Skipped {} unmapped notes: [{}]", p.unmapped.len(), list.join(", ")));
        }

        let (aim, chord_press, chord_tap) = self.injection_cost();
        let inject_cost = if sustain { chord_press } else { chord_tap };
        inner.log("info", format!("Injection cost {:.2} ms isolated, {:.2} ms back-to-back", aim * 1000.0, chord_tap * 1000.0));

        inner.log("info", format!("Focusing target: {} | {}", target.process, target.title));
        let mut focused = false;
        for _ in 0..3 {
            if inner.focus(&target) {
                focused = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        if !focused {
            inner.log("warn", "Windows could not switch windows automatically. Playback will wait until you focus the target.");
        }
        std::thread::sleep(Duration::from_millis(150));

        for i in (1..=countdown.max(0)).rev() {
            if state.stopped() {
                inner.log("info", "Cancelled before playback.");
                return Ok(());
            }
            inner.emit(json!({"event": "countdown", "i": i}));
            std::thread::sleep(Duration::from_secs(1));
        }
        if state.stopped() {
            inner.log("info", "Cancelled before playback.");
            return Ok(());
        }

        let total = p.events.len();
        let timing = state.progress();
        inner.emit(json!({
            "event": "playback_started",
            "total_notes": total,
            "tempo": timing.tempo,
            "duration": py_round(p.total / timing.tempo, 3),
            "bpm": py_round(p.bpm * timing.tempo, 2),
            "start_elapsed": py_round(timing.elapsed, 4),
        }));

        let monitor = {
            let (b, s, hwnd) = (self.clone(), state.clone(), target.hwnd);
            std::thread::Builder::new().name("focus-monitor".into()).spawn(move || b.focus_monitor(&s, hwnd))
        };
        let progress = {
            let (b, s) = (self.clone(), state.clone());
            std::thread::Builder::new().name("progress".into()).spawn(move || b.progress_loop(&s))
        };
        if let Err(e) = monitor.and(progress) {
            state.halt();
            return Err(e.to_string());
        }

        let opts = PlayOpts { latency: aim, collect_stats, sustain, end_at, inject_cost: Some(inject_cost), batch: true };
        let mut sink = inner.sink();
        let errors = playback_loop(&p.events, state, sink.as_mut(), &opts)?;

        let stats = if collect_stats { stats_payload(&errors) } else { Value::Null };
        inner.emit(json!({
            "event": "playback_done",
            "stats": stats,
            "sent": state.played_count.load(Ordering::Acquire),
            "total": total,
        }));
        Ok(())
    }

    fn progress_loop(&self, state: &State) {
        while !state.stopped() {
            let p = state.progress();
            let elapsed = py_round(p.elapsed, 4);
            self.inner.emit(json!({
                "event": "progress",
                "tempo": p.tempo,
                "elapsed": elapsed,
                "played": state.played_count.load(Ordering::Acquire),
                "focus_lost": p.focus_lost,
                "user_paused": p.user_paused,
                "frozen_elapsed": (p.user_paused || p.focus_lost).then_some(elapsed),
                "base_time_perf": py_round(p.base_time, 6),
            }));
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn focus_monitor(&self, state: &State, target: isize) {
        let inner = &self.inner;
        while !state.stopped() {
            if !window_alive(target) {
                inner.log("info", "[!] Target window closed, stopping playback.");
                state.halt();
                return;
            }
            let cur = if inner.cfg.dry_run { target } else { focused_hwnd() };
            if cur != target {
                if !state.focus_lost() {
                    state.set_focus_lost(true);
                    inner.log("info", "[!] Focus lost, playback paused. Re-focus the target window to resume.");
                }
            } else if state.focus_lost() {
                state.set_focus_lost(false);
                if !state.user_paused() {
                    inner.log("info", "[+] Focus regained, resuming.");
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
