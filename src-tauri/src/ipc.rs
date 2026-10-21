// ipc.rs: electron/main.js's ipcMain table behind one command. The channel
// names are preload.js's, unchanged, so renderer/shared/bridge.js can mirror
// the preload line for line and the two hosts stay comparable.
//
// Everything in STUBBED is registered but not ported yet: it answers with an
// error that says so, which every caller in the renderer already handles.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{allow_dir, allow_file, blog, paths, Host, MAIN};

const RELEASES_URL: &str = "https://github.com/StarsationX/midi-studio/releases";
const PACKAGE_JSON: &str = include_str!("../../package.json");
const CHANGELOG: &str = include_str!("../../CHANGELOG.md");
const FORGE_SETTINGS_KEYS: [&str; 5] = ["pipeline", "skipSeparation", "advanced", "outputDir", "timing"];

/// Registered, not ported yet. Empty since milestone 3 (Forge, in forge/).
pub const STUBBED: &[&str] = &[];

fn release_name() -> String {
    serde_json::from_str::<Value>(PACKAGE_JSON)
        .ok()
        .and_then(|v| v.get("releaseName").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

fn is_obj(v: &Value) -> bool {
    v.is_object()
}

fn s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// JavaScript's Number(v), for the handful of places main.js leans on it.
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(t)) => {
            let t = t.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// main.js performanceSettings(): one "how much of this machine" number and
/// everything derived from it.
pub fn performance(p: &Value, legacy_ui: &Value) -> Value {
    let mut percent = js_number(p.get("percent"));
    if !percent.is_finite() {
        let level = p.get("level").and_then(Value::as_str).unwrap_or("");
        let perf_mode = legacy_ui.get("perfMode").is_some_and(|v| v.as_bool().unwrap_or(!v.is_null()));
        percent = if level == "easy" || perf_mode { 35.0 } else if level == "balanced" { 65.0 } else { 100.0 };
    }
    let percent = (js_round(percent / 5.0) * 5.0).clamp(10.0, 100.0);
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()).max(1) as f64;
    let empty = json!({});
    let advanced = p.get("advanced").filter(|v| v.is_object()).unwrap_or(&empty);
    let hand = |k: &str| {
        let v = advanced.get(k);
        let n = js_number(v);
        (v.is_some_and(|v| !v.is_null()) && n.is_finite() && n > 0.0).then_some(n)
    };
    let threads = match hand("threads") {
        Some(t) => js_round(t).clamp(1.0, 64.0),
        None => js_round(cores * percent / 100.0).min(cores).max(1.0),
    };
    let batch = match hand("batch") {
        Some(b) => js_round(b).clamp(1.0, 8.0),
        None => js_round(percent / 50.0).max(1.0),
    };
    let draw_ms = js_round(1000.0 / (60.0 * percent / 100.0).max(4.0));
    let when = p.get("whenGaming").and_then(Value::as_str).filter(|w| ["nothing", "limit", "pause"].contains(w)).unwrap_or("limit");
    let num = |x: f64| json!(x as i64);
    let opt = |x: Option<f64>| x.map_or(Value::Null, |v| if v.fract() == 0.0 { json!(v as i64) } else { json!(v) });
    json!({
        "percent": num(percent), "cores": num(cores), "threads": num(threads), "batch": num(batch),
        "drawMs": num(draw_ms), "lowPriority": percent <= 50.0, "whenGaming": when,
        "custom": {"threads": opt(hand("threads")), "batch": opt(hand("batch"))},
    })
}

fn set_performance_patch(patch: &Value) -> Value {
    let mut clean = Map::new();
    if is_obj(patch) {
        let percent = js_number(patch.get("percent"));
        if percent.is_finite() {
            clean.insert("percent".into(), json!(js_round(percent).clamp(10.0, 100.0) as i64));
            // Explicit nulls: the store deep-merges, so {} would keep a hand-set value.
            clean.insert("advanced".into(), json!({"threads": null, "batch": null}));
        }
        if let Some(w) = patch.get("whenGaming").and_then(Value::as_str).filter(|w| ["nothing", "limit", "pause"].contains(w)) {
            clean.insert("whenGaming".into(), json!(w));
        }
        if let Some(adv) = patch.get("advanced").filter(|v| v.is_object()) {
            let mut a = Map::new();
            let t = js_number(adv.get("threads"));
            if t.is_finite() {
                a.insert("threads".into(), json!(js_round(t).clamp(1.0, 64.0) as i64));
            }
            let b = js_number(adv.get("batch"));
            if b.is_finite() {
                a.insert("batch".into(), json!(js_round(b).clamp(1.0, 8.0) as i64));
            }
            clean.insert("advanced".into(), Value::Object(a));
        }
    }
    json!({"performance": clean})
}

fn file_dialog(app: &AppHandle, title: &str) -> FileDialogBuilder<tauri::Wry> {
    let mut d = app.dialog().file().set_title(title);
    if let Some(w) = app.get_webview_window(MAIN) {
        d = d.set_parent(&w);
    }
    d
}

fn into_paths(v: Option<Vec<tauri_plugin_dialog::FilePath>>) -> Vec<PathBuf> {
    v.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
}

fn path_str(p: &Path) -> Value {
    json!(p.to_string_lossy())
}

fn pick_files(app: &AppHandle, title: &str, filters: &[(&str, &[&str])], multi: bool, dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut d = file_dialog(app, title);
    for (name, exts) in filters {
        d = d.add_filter(*name, exts);
    }
    if let Some(dir) = dir {
        d = d.set_directory(dir);
    }
    let picked = if multi { into_paths(d.blocking_pick_files()) } else { into_paths(d.blocking_pick_file().map(|p| vec![p])) };
    for p in &picked {
        allow_file(app, p);
    }
    picked
}

fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    let p = file_dialog(app, title).set_can_create_directories(true).blocking_pick_folder()?.into_path().ok()?;
    allow_dir(app, &p);
    Some(p)
}

fn first_or_null(v: Vec<PathBuf>) -> Value {
    v.first().map_or(Value::Null, |p| path_str(p))
}

fn open_path(app: &AppHandle, p: &Path) -> Result<(), String> {
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

fn reveal(app: &AppHandle, p: &Path) -> Result<(), String> {
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

fn whats_new(app: &AppHandle, h: &Host) -> Value {
    let version = app.package_info().version.to_string();
    let shown_for = h.settings.get_str("ui.notesShownFor");
    json!({
        "version": version, "name": release_name(), "postUpdate": h.post_update,
        "autoShow": h.post_update && shown_for != version, "shownFor": shown_for, "releasesUrl": RELEASES_URL,
    })
}

/// Settings > Engines: the Player engine is player-rs, in-process, always.
/// The shape is electron/main.js playerEngineInfo()'s.
fn player_engine(h: &Host) -> Value {
    json!({
        "builtIn": true, "chosen": "rust", "override": "", "rustAvailable": true,
        "running": "rust", "dryRun": h.engine.dry_run(), "pending": false,
    })
}

/// Settings > About: this host and the WebView2 runtime under it.
fn runtime(h: &Host) -> Value {
    json!({
        "host": "tauri",
        "versions": {"tauri": tauri::VERSION, "webview2": tauri::webview_version().unwrap_or_default()},
        "player": player_engine(h),
    })
}

fn dispatch(app: &AppHandle, channel: &str, args: &[Value]) -> Result<Value, String> {
    let h: Arc<Host> = app.state::<Arc<Host>>().inner().clone();
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    let win = || app.get_webview_window(MAIN).ok_or_else(|| "the main window is gone".to_string());
    let output_dir = || paths::program_output_dir(&h.settings.get_str("forge.outputDir"));

    if STUBBED.contains(&channel) {
        return Err(format!("{channel} is not yet ported to the Tauri build"));
    }
    // Channels that live in their own modules: Forge (which also guards
    // win:close while a job runs), Perch, the updater, the watchers.
    if let Some(r) = crate::forge::dispatch(app, channel, args)
        .or_else(|| crate::overlay::dispatch(app, channel, args))
        .or_else(|| crate::updater::dispatch(app, channel, args))
        .or_else(|| crate::watch::dispatch(app, channel, args))
    {
        return r;
    }
    Ok(match channel {
        // ---- bridge internals ------------------------------------------------
        // The shell's bridge has subscribed to every push channel by now, so the
        // engine can start and its `ready` cannot be missed; the cached copy is
        // returned as well for a page that reloaded after the engine came up.
        "bridge:attach" => {
            let fresh = h.engine.last_ready().is_none();
            if fresh {
                h.boot_mark(app, "engine", "Starting MIDI engine");
            }
            h.engine.start();
            json!({"ready": h.engine.last_ready(), "openMidi": h.take_open_path(), "dryRun": h.engine.dry_run()})
        }

        // ---- Player engine ---------------------------------------------------
        "engine:send" => {
            if !is_obj(&a0) {
                return Ok(json!(false));
            }
            crate::overlay::on_engine_send(app, &a0);
            json!(h.engine.send(a0))
        }

        // ---- dialogs -----------------------------------------------------------
        "dialog:openMidi" => {
            let v = pick_files(app, "Select MIDI file(s)", &[("MIDI", &["mid", "midi"]), ("All files", &["*"])], true, None);
            Value::Array(v.iter().map(|p| path_str(p)).collect())
        }
        "dialog:openMapping" => first_or_null(pick_files(app, "Select mapping JSON", &[("JSON", &["json"]), ("All files", &["*"])], false, Some(paths::user_mappings_dir()))),
        "review:pick" => first_or_null(pick_files(app, "Open MIDI Studio project or MIDI", &[("MIDI Studio", &["json", "mid", "midi"]), ("All files", &["*"])], false, None)),
        "forge:pickInput" => {
            let exts: &[&str] = &["mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "wma"];
            let v = pick_files(app, "Select song / audio file(s)", &[("Audio", exts), ("All files", &["*"])], true, None);
            Value::Array(v.iter().map(|p| path_str(p)).collect())
        }
        "forge:pickOutDir" => pick_folder(app, "Output folder").map_or(Value::Null, |p| path_str(&p)),
        "app:pickFolder" => pick_folder(app, "Choose a folder of MIDI files").map_or(Value::Null, |p| path_str(&p)),
        // The Editor's unsaved-edits guard (main.js will-prevent-unload). true = close.
        "dialog:confirmClose" => {
            let mut d = app
                .dialog()
                .message("The Midi Editor has unsaved note edits.\n\nClose anyway and lose them?")
                .title("Unsaved changes")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Discard and close".into(), "Keep editing".into()));
            if let Ok(w) = win() {
                d = d.parent(&w);
            }
            json!(d.blocking_show())
        }

        // ---- opener ------------------------------------------------------------
        "app:openExternal" => {
            let url = s(&a0);
            if url.starts_with("http://") || url.starts_with("https://") {
                app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            }
            Value::Null
        }
        "shell:openPath" => {
            let p = PathBuf::from(s(&a0));
            if p.as_os_str().is_empty() || !p.exists() {
                return Ok(json!({"ok": false, "error": "not found"}));
            }
            match open_path(app, &p) {
                Ok(()) => json!({"ok": true}),
                Err(e) => json!({"ok": false, "error": e}),
            }
        }
        "shell:showItem" => {
            let p = PathBuf::from(s(&a0));
            if p.as_os_str().is_empty() || !p.exists() {
                return Ok(json!({"ok": false, "error": "not found"}));
            }
            reveal(app, &p)?;
            json!({"ok": true})
        }
        "library:reveal" => {
            let _ = reveal(app, Path::new(&s(&a0)));
            Value::Null
        }
        "app:openMappingsDir" => json!(open_path(app, &paths::ensure_user_mappings()).err().unwrap_or_default()),
        "app:openBootLog" => {
            let p = paths::boot_log();
            if !p.exists() {
                return Ok(json!({"ok": false, "error": "no boot log yet"}));
            }
            if open_path(app, &p).is_err() {
                let _ = reveal(app, &p);
            }
            json!({"ok": true, "path": p.to_string_lossy()})
        }

        // ---- app info ----------------------------------------------------------
        "app:version" => json!(app.package_info().version.to_string()),
        "app:release" => json!(release_name()),
        "app:runtime" => runtime(&h),
        // There is nothing to switch to here; answer with the engine there is.
        "app:setPlayerEngine" => player_engine(&h),
        "app:changelog" => json!({"ok": true, "file": "CHANGELOG.md (embedded)", "text": CHANGELOG}),
        "app:whatsNew" => whats_new(app, &h),
        "app:notesShown" => {
            let v = match s(&a0) {
                v if v.is_empty() => app.package_info().version.to_string(),
                v => v,
            };
            h.settings.merge(&json!({"ui": {"notesShownFor": v}}));
            json!(v)
        }
        "app:bootState" => h.boot_state(),
        "app:bootMark" => {
            let step: String = a0.get("step").map(s).unwrap_or_default().chars().take(40).collect();
            if !step.is_empty() {
                let ms = js_number(a0.get("ms"));
                blog(&if ms.is_finite() { format!("ui:{step} +{}ms", js_round(ms)) } else { format!("ui:{step}") });
            }
            Value::Null
        }

        // ---- settings ----------------------------------------------------------
        "app:getUi" => match h.settings.get("ui") {
            Value::Null => json!({}),
            ui => ui,
        },
        "app:setUi" => {
            let patch = if is_obj(&a0) { a0.clone() } else { json!({}) };
            let ui = h.settings.merge(&json!({"ui": patch}))["ui"].clone();
            if a0.get("alwaysOnTop").is_some() {
                win()?.set_always_on_top(ui.get("alwaysOnTop") != Some(&json!(false))).map_err(|e| e.to_string())?;
            }
            ui
        }
        "app:performance" => performance(&h.settings.get("performance"), &h.settings.get("ui")),
        "app:setPerformance" => {
            h.settings.merge(&set_performance_patch(&a0));
            performance(&h.settings.get("performance"), &h.settings.get("ui"))
        }
        "forge:getSettings" => h.settings.get("forge"),
        "forge:setSettings" => {
            let mut clean = Map::new();
            if let Some(o) = a0.as_object() {
                for k in FORGE_SETTINGS_KEYS {
                    if let Some(v) = o.get(k) {
                        clean.insert(k.into(), v.clone());
                    }
                }
            }
            h.settings.merge(&json!({"forge": clean}))["forge"].clone()
        }
        "app:getOutputDir" => path_str(&output_dir()),
        "app:getLibraryDir" => {
            let manual = h.settings.get_str("libraryDir");
            if !manual.is_empty() {
                json!(manual)
            } else {
                let d = output_dir();
                let _ = std::fs::create_dir_all(&d);
                path_str(&d)
            }
        }
        "app:setLibraryDir" => {
            let dir = s(&a0);
            allow_dir(app, Path::new(&dir));
            h.settings.merge(&json!({"libraryDir": dir}))["libraryDir"].clone()
        }
        "app:listMidis" => {
            let dir = PathBuf::from(s(&a0));
            allow_dir(app, &dir);
            json!(paths::list_midis(&dir))
        }

        // ---- window --------------------------------------------------------------
        "win:state" => match app.get_webview_window(MAIN) {
            Some(w) => Host::window_state(&w),
            None => json!({"maximized": false, "minimized": false, "fullScreen": false, "focused": false}),
        },
        "win:minimize" => {
            let _ = win()?.minimize();
            Value::Null
        }
        "win:maximize" => {
            let _ = win()?.maximize();
            Value::Null
        }
        "win:unmaximize" => {
            let _ = win()?.unmaximize();
            Value::Null
        }
        "win:toggleMaximize" => {
            let w = win()?;
            let _ = if w.is_maximized().unwrap_or(false) { w.unmaximize() } else { w.maximize() };
            Value::Null
        }
        "win:closeAck" => {
            h.ack_close();
            Value::Null
        }
        "win:close" => {
            h.close_now(&win()?);
            Value::Null
        }

        _ => return Err(format!("unknown channel: {channel}")),
    })
}

/// The whole IPC surface. Runs on the blocking pool: the dialogs block until
/// the user answers, and nothing here may hold up the UI thread. `progress`
/// is a channel the calling frame opened for itself (library:scan/index), so
/// a stream reaches the frame that asked and no other (Electron's senderFrame).
#[tauri::command]
pub async fn ipc(
    app: AppHandle,
    webview: tauri::Webview,
    channel: String,
    args: Option<Vec<Value>>,
    progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value, String> {
    let args = args.unwrap_or_default();
    let progress = progress.map(|id| id.channel_on::<_, Value>(webview));
    let ch = channel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::handle(&app, &channel, &args, progress)
            .or_else(|| crate::review::handle(&app, &channel, &args))
            .unwrap_or_else(|| dispatch(&app, &channel, &args))
    })
    .await
    .map_err(|e| format!("{ch} failed: {e}"))?
}

/// fileUrl() for a path the host never handed over itself (a recent file from
/// localStorage, say). Synchronous on purpose: a sync command runs on the main
/// thread as the request arrives, ahead of the asset request that follows it.
#[tauri::command]
pub fn asset_allow(app: AppHandle, path: String) {
    let p = PathBuf::from(&path);
    if p.is_file() {
        allow_file(&app, &p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn performance_defaults_and_clamps() {
        let p = performance(&json!({"percent": 100, "whenGaming": "limit", "advanced": {}}), &json!({}));
        assert_eq!(p["percent"], json!(100));
        assert_eq!(p["batch"], json!(2));
        assert_eq!(p["drawMs"], json!(17));
        assert_eq!(p["lowPriority"], json!(false));
        assert_eq!(p["custom"], json!({"threads": null, "batch": null}));
        let p = performance(&json!({"percent": 3, "whenGaming": "bogus", "advanced": {"threads": 200, "batch": null}}), &json!({}));
        assert_eq!(p["percent"], json!(10));
        assert_eq!(p["threads"], json!(64));
        assert_eq!(p["whenGaming"], json!("limit"));
        assert_eq!(p["lowPriority"], json!(true));
        let legacy = performance(&json!({}), &json!({"perfMode": true}));
        assert_eq!(legacy["percent"], json!(35));
    }

    #[test]
    fn set_performance_clears_overrides_with_nulls() {
        let p = set_performance_patch(&json!({"percent": 52}));
        assert_eq!(p, json!({"performance": {"percent": 52, "advanced": {"threads": null, "batch": null}}}));
        let p = set_performance_patch(&json!({"advanced": {"threads": "4"}, "whenGaming": "pause"}));
        assert_eq!(p, json!({"performance": {"whenGaming": "pause", "advanced": {"threads": 4}}}));
    }

    #[test]
    fn release_name_comes_from_package_json() {
        assert_eq!(release_name(), "Graphite");
    }

    #[test]
    fn stub_list_has_no_duplicates() {
        let mut v = STUBBED.to_vec();
        v.sort_unstable();
        v.dedup();
        assert_eq!(v.len(), STUBBED.len());
    }
}
