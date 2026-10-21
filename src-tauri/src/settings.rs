// settings.rs: electron/settings.js, ported. The same JSON file in the same
// folder with the same deep-merge, so a user moving from the Electron build
// keeps every preference. Writes are coalesced the way main.js's
// installDebouncedSettings does it, and flush() forces the last one out.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

pub fn defaults() -> Value {
    json!({
        "window": { "width": 1240, "height": 880, "x": null, "y": null, "maximized": false },
        "library": { "dirs": [] },
        "performance": { "percent": 100, "whenGaming": "limit", "advanced": {} },
        "forge": {
            "pipeline": "melody",
            "skipSeparation": false,
            "advanced": {},
            "outputDir": "",
            "timing": { "enabled": false, "start": "", "end": "" }
        },
        "paths": { "forgeEnvDir": "", "forgePythonPath": "", "modelsDir": "" },
        "ui": { "lastTab": "forge", "autoCheckUpdates": true, "alwaysOnTop": true },
        "player": { "engine": "python" },
        "overlay": {
            "mode": "full", "opacity": 0.92, "clickThrough": false, "locked": false,
            "autoShow": true, "autoHide": true, "lookahead": 3,
            "showKeys": true, "showTransport": true, "bounds": {}
        },
        "libraryDir": "",
        "lastOutputDir": ""
    })
}

/// settings.js deepMerge, including its JavaScript edges: a patch object
/// merges into an object or into null (`typeof null === 'object'`), an array
/// target keeps its elements (the extra keys JS would hang on it never survive
/// JSON.stringify), and everything else, null included, replaces.
pub fn deep_merge(a: &Value, b: &Value) -> Value {
    let Some(patch) = b.as_object() else { return a.clone() };
    let Some(base) = a.as_object() else { return a.clone() };
    let mut out: Map<String, Value> = base.clone();
    for (k, v) in patch {
        let merged = match (v, out.get(k)) {
            (Value::Object(_), Some(Value::Object(_))) => deep_merge(&out[k], v),
            (Value::Object(_), Some(Value::Null)) => deep_merge(&json!({}), v),
            (Value::Object(_), Some(Value::Array(arr))) => Value::Array(arr.clone()),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    Value::Object(out)
}

struct Store {
    file: PathBuf,
    data: Value,
    dirty: bool,
}

#[derive(Clone)]
pub struct Settings {
    store: Arc<Mutex<Store>>,
    timer: Arc<AtomicBool>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Settings {
    pub fn open(file: PathBuf) -> Settings {
        let read = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_else(|| json!({}));
        let data = deep_merge(&defaults(), &read);
        Settings {
            store: Arc::new(Mutex::new(Store { file, data, dirty: false })),
            timer: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn file(&self) -> PathBuf {
        lock(&self.store).file.clone()
    }

    pub fn get_all(&self) -> Value {
        lock(&self.store).data.clone()
    }

    pub fn get(&self, dotted: &str) -> Value {
        let s = lock(&self.store);
        let mut cur = &s.data;
        for k in dotted.split('.').filter(|k| !k.is_empty()) {
            match cur.get(k) {
                Some(v) => cur = v,
                None => return Value::Null,
            }
        }
        cur.clone()
    }

    pub fn get_str(&self, dotted: &str) -> String {
        match self.get(dotted) {
            Value::String(s) => s,
            _ => String::new(),
        }
    }

    pub fn merge(&self, patch: &Value) -> Value {
        let all = {
            let mut s = lock(&self.store);
            s.data = deep_merge(&s.data, patch);
            s.dirty = true;
            s.data.clone()
        };
        self.schedule();
        all
    }

    fn schedule(&self) {
        if self.timer.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        let spawned = std::thread::Builder::new().name("settings-write".into()).spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            me.timer.store(false, Ordering::SeqCst);
            me.flush();
        });
        if spawned.is_err() {
            self.timer.store(false, Ordering::SeqCst);
            self.flush();
        }
    }

    pub fn flush(&self) {
        let mut s = lock(&self.store);
        if !s.dirty {
            return;
        }
        s.dirty = false;
        if let Some(dir) = s.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&s.data) {
            let _ = std::fs::write(&s.file, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_matches_settings_js() {
        let a = json!({"ui": {"lastTab": "forge", "alwaysOnTop": true}, "window": {"x": null}, "dirs": [1, 2], "n": 1});
        let b = json!({"ui": {"lastTab": "player"}, "window": {"x": 5}, "dirs": {"0": 9}, "n": null, "new": {"a": 1}});
        let m = deep_merge(&a, &b);
        assert_eq!(m["ui"], json!({"lastTab": "player", "alwaysOnTop": true}));
        assert_eq!(m["window"]["x"], json!(5));
        assert_eq!(m["dirs"], json!([1, 2]));
        assert_eq!(m["n"], Value::Null);
        assert_eq!(m["new"], json!({"a": 1}));
    }

    #[test]
    fn null_target_takes_a_patch_object() {
        let m = deep_merge(&json!({"bounds": null}), &json!({"bounds": {"x": 1}}));
        assert_eq!(m["bounds"], json!({"x": 1}));
    }

    #[test]
    fn existing_file_survives_round_trip() {
        let dir = std::env::temp_dir().join(format!("midi-studio-settings-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("midi-studio-settings.json");
        std::fs::write(&file, r##"{"ui":{"lastTab":"library","accent":"#ff0000"},"custom":{"keep":true}}"##).unwrap();
        let s = Settings::open(file.clone());
        assert_eq!(s.get_str("ui.lastTab"), "library");
        assert_eq!(s.get("ui.alwaysOnTop"), json!(true));
        assert_eq!(s.get("custom.keep"), json!(true));
        s.merge(&json!({"ui": {"lastTab": "player"}}));
        s.flush();
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back["ui"]["lastTab"], json!("player"));
        assert_eq!(back["ui"]["accent"], json!("#ff0000"));
        assert_eq!(back["custom"]["keep"], json!(true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
