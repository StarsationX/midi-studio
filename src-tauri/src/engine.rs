// engine.rs: the Player engine, in-process. electron/sidecar.js spawned
// player-rs (or ipc_main.py) and spoke NDJSON over its stdio; here the same
// midi_player::Bridge runs inside the host and its emit callback becomes the
// engine-event push.
//
// Commands go through ONE thread, in order, exactly as lines on the child's
// stdin did: load_midi then play must never be able to overtake each other.
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use midi_player::{Bridge, Config, Flow};
use serde_json::Value;

pub type Push = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct Engine {
    push: Push,
    cfg: Config,
    state: Mutex<Option<(Bridge, Sender<Value>)>>,
    last_ready: Arc<Mutex<Option<Value>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn dry_run_requested() -> bool {
    std::env::args().any(|a| a == "--dry-run")
        || std::env::var("MIDI_PLAYER_DRY_RUN").is_ok_and(|v| !v.is_empty() && v != "0")
}

impl Engine {
    pub fn new(push: Push, script_dir: PathBuf, user_mappings_dir: Option<PathBuf>, dry_run: bool) -> Engine {
        Engine {
            push,
            cfg: Config { script_dir, user_mappings_dir, dry_run },
            state: Mutex::new(None),
            last_ready: Arc::new(Mutex::new(None)),
        }
    }

    pub fn dry_run(&self) -> bool {
        self.cfg.dry_run
    }

    /// Start the engine if it is not running yet. Idempotent.
    pub fn start(&self) {
        let mut state = lock(&self.state);
        if state.is_some() {
            return;
        }
        let push = self.push.clone();
        let last_ready = self.last_ready.clone();
        let emit = Arc::new(move |v: Value| {
            if v.get("event").and_then(Value::as_str) == Some("ready") {
                *lock(&last_ready) = Some(v.clone());
            }
            push("engine-event", v);
        });
        let bridge = Bridge::new(emit, self.cfg.clone());
        let (tx, rx) = mpsc::channel::<Value>();
        let worker = bridge.clone();
        let push = self.push.clone();
        let spawned = std::thread::Builder::new().name("player-engine".into()).spawn(move || {
            for msg in rx {
                if worker.handle(&msg) == Flow::Shutdown {
                    break;
                }
            }
        });
        if let Err(e) = spawned {
            push("engine-error", Value::String(format!("Player engine failed to start: {e}")));
            return;
        }
        push("engine-event", serde_json::json!({
            "event": "log", "level": "info",
            "message": format!("Player engine via: in-process player-rs{}", if self.cfg.dry_run { " (dry run)" } else { "" }),
        }));
        bridge.ready();
        *state = Some((bridge, tx));
    }

    pub fn last_ready(&self) -> Option<Value> {
        lock(&self.last_ready).clone()
    }

    /// api.send: queue one command. false (and an engine-error) when the
    /// engine is not there to take it, which is what sidecar.send reported.
    pub fn send(&self, msg: Value) -> bool {
        self.start();
        let state = lock(&self.state);
        match state.as_ref() {
            Some((_, tx)) if tx.send(msg).is_ok() => true,
            _ => {
                (self.push)("engine-error", Value::String("Player engine is not running. Check the log, or restart MIDI Studio.".into()));
                false
            }
        }
    }

    /// Stop playback, release anything held down, and let the command thread
    /// finish. Called on the way out.
    pub fn shutdown(&self) {
        if let Some((bridge, tx)) = lock(&self.state).take() {
            bridge.panic_release(Duration::from_millis(1500));
            let _ = tx.send(serde_json::json!({"cmd": "shutdown"}));
        }
    }
}
