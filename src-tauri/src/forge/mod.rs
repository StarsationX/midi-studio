// forge/: Midi Forge on the Tauri host. electron/forge-runner.js,
// forge-provisioner.js and forge-storage.js, and the forge:* / app:forge*
// handlers of electron/main.js, with the same channels and the same
// forge:status payloads.
//
//   runner     pipeline + yt jobs, the line pump, stages, pause, priority,
//              the capability probe
//   provision  first-run setup (bootstraps its own Python: see provision.rs)
//   storage    where the env lives and the rules for moving or deleting it
//   fpaths     the forge env lookup, the child env, the installer's registry
//   winjob     Job Objects, NtSuspendProcess, SetPriorityClass
mod fpaths;
mod medley;
mod provision;
mod runner;
mod storage;
mod winjob;
mod musescore;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

use crate::{allow_dir, blog, paths, Host, MAIN};
use fpaths::ForgePaths;
use runner::{js_str, truthy, Ctx, Runner};

/// A one-way latch: main.js's forgePathsSettled / orphanReap promises.
#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn open(&self) {
        *self.open.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    fn wait(&self) {
        let mut g = self.open.lock().unwrap_or_else(|e| e.into_inner());
        let t = Instant::now();
        while !*g && t.elapsed() < Duration::from_secs(20) {
            g = self.cv.wait_timeout(g, Duration::from_millis(200)).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
        }
    }
}

pub struct Forge {
    runner: Arc<Runner>,
    musescore: Arc<musescore::MuseScore>,
    provisioner: Arc<provision::Provisioner>,
    model_import: Mutex<()>,
    settled: Gate,
    reaped: Gate,
    /// Paused because a game came up under "Pause Forge jobs entirely", so
    /// only that pause is undone when the game goes (a pause the user pressed
    /// stays).
    auto_paused: AtomicBool,
}

fn forge(app: &AppHandle) -> Option<Arc<Forge>> {
    app.try_state::<Arc<Forge>>().map(|s| s.inner().clone())
}

fn host(app: &AppHandle) -> Arc<Host> {
    app.state::<Arc<Host>>().inner().clone()
}

fn forge_paths(h: &Host) -> ForgePaths {
    ForgePaths::from_settings(&h.settings.get("paths"))
}

/// settings.forge.engine, "python" unless it says "rust".
fn forge_engine_setting(h: &Host) -> String {
    if h.settings.get_str("forge.engine") == "rust" { "rust".into() } else { "python".into() }
}

/// Settings > Engines: the Forge engine choice and whether the Rust engine
/// could take a job right now (forge-rs found and its models and runtime
/// resolved).
pub fn engine_info(h: &Host) -> Value {
    let chosen = forge_engine_setting(h);
    let exe = fpaths::forge_rs_exe();
    let probe = exe.as_ref().map(|e| runner::probe_rust(e, &fpaths::forge_child_env(&forge_paths(h))));
    let (ready, why, ep) = match &probe {
        None => (false, "This build does not include the Rust engine.".to_string(), Value::Null),
        Some(Ok(v)) => (true, String::new(), v["ep"].clone()),
        Some(Err(e)) => (false, e.clone(), Value::Null),
    };
    json!({"chosen": chosen, "rustAvailable": exe.is_some(), "ready": ready, "why": why, "ep": ep, "rustModes": runner::RUST_MODES})
}

fn output_dir(h: &Host) -> PathBuf {
    paths::program_output_dir(&h.settings.get_str("forge.outputDir"))
}

fn clear_paths_patch(dir: &str) -> Value {
    json!({"paths": {"forgeEnvDir": dir, "forgePythonPath": "", "modelsDir": ""}})
}

// ---- forge:status ------------------------------------------------------------------

/// main.js forgeEmit: setup invalidates the cached probe; a finished
/// transcription is moved into the program's output folder (with its
/// candidates and a .midstudio.json project when there are any) before the
/// renderer hears about it, and the Library is told to rescan.
fn on_status(app: &AppHandle, mut payload: Value) {
    let ev = payload.get("event").and_then(Value::as_str).unwrap_or("").to_string();
    if ev.starts_with("forge.provision.") {
        if let Some(f) = forge(app) {
            f.runner.invalidate_check();
        }
    }
    if ev == "forge.done" && payload["ok"] == json!(true) && payload["result"]["midiPath"].is_string() {
        let out = output_dir(&host(app));
        let mp = finalize_outputs(&mut payload["result"], &out);
        allow_dir(app, &out);
        Host::push(app, "library-changed", json!(Path::new(&mp).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()));
    }
    Host::push(app, "forge:status", payload);
}

/// Reserve the destination on disk so simultaneous exports cannot clobber
/// each other. A primary MIDI and its project need the same free basename.
fn move_export(src: &Path, out_dir: &Path, has_project: bool) -> std::io::Result<PathBuf> {
    let original = out_dir.join(src.file_name().unwrap_or_default());
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let ext = original.extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default();
    for index in 1..=10000 {
        let target = if index == 1 { original.clone() } else { out_dir.join(format!("{stem} ({index}){ext}")) };
        if has_project && target.with_extension("midstudio.json").exists() { continue; }
        if storage::same_path(src, &target) { return Ok(src.to_owned()); }
        let mut file = match std::fs::File::create_new(&target) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let copy = std::fs::File::open(src).and_then(|mut input| std::io::copy(&mut input, &mut file));
        drop(file);
        if let Err(e) = copy {
            let _ = std::fs::remove_file(&target);
            return Err(e);
        }
        let _ = std::fs::remove_file(src);
        return Ok(target);
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "No unused export filename"))
}

/// Move the completed files, then publish a project that points to their final paths.
fn finalize_outputs(result: &mut Value, out_dir: &Path) -> String {
    let mut mp = result["midiPath"].as_str().unwrap_or("").to_string();
    let attempt = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(out_dir)?;
        let out = std::path::absolute(out_dir)?;
        let mut moved: Vec<(String, String)> = Vec::new();
        let mut move_output = |source: &str, has_project: bool| -> std::io::Result<String> {
            if source.is_empty() {
                return Ok(String::new());
            }
            let src = std::path::absolute(source).unwrap_or(PathBuf::from(source));
            let key = src.to_string_lossy().to_lowercase();
            // Checked before existence: main.js asked "does it exist" first, so
            // a candidate that IS the main MIDI (melody's primary) kept the
            // path it had just been moved away from.
            if let Some((_, d)) = moved.iter().find(|(k, _)| *k == key) {
                return Ok(d.clone());
            }
            if !src.exists() {
                return Ok(source.to_string());
            }
            let dest = move_export(&src, &out, has_project)?.to_string_lossy().into_owned();
            moved.push((key, dest.clone()));
            Ok(dest)
        };
        mp = move_output(&mp, result.get("candidates").is_some_and(Value::is_object))?;
        if let Some(cands) = result.get("candidates").and_then(Value::as_object).cloned() {
            let mut out = Map::new();
            for (name, file) in cands {
                out.insert(name, json!(move_output(&js_str(Some(&file)), false)?));
            }
            let stem = Path::new(&mp).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let project_path = out_dir.join(format!("{stem}.midstudio.json"));
            let source = result.get("sourceAudio").cloned().filter(|v| truthy(Some(v))).unwrap_or(json!(""));
            let preview = result.get("previewAudio").cloned().filter(|v| truthy(Some(v))).unwrap_or_else(|| source.clone());
            let mut project = json!({
                "format": "midi-studio-project", "version": 1,
                "name": stem,
                "sourceAudio": source,
                "previewAudio": preview,
                "selectedCandidate": "clean", "candidates": out.clone(),
                "candidateCounts": result.get("candidateCounts").cloned().filter(|v| truthy(Some(v))).unwrap_or(json!({})),
                "pipeline": result.get("pipeline").cloned().filter(|v| truthy(Some(v))).unwrap_or(json!("melody")),
                "timing": result.get("timing").cloned().filter(|v| truthy(Some(v))).unwrap_or(json!({})),
                "createdAt": provision::iso_now(),
            });
            if let Some(names) = result.get("channelNames").filter(|v| v.is_object()) {
                project["channelNames"] = names.clone();
            }
            result["candidates"] = Value::Object(out);
            serde_json::to_writer_pretty(std::fs::File::create_new(&project_path)?, &project)?;
            result["projectPath"] = json!(project_path.to_string_lossy());
        }
        Ok(())
    })();
    if let Err(e) = attempt {
        blog(&format!("forge output move failed: {e}"));
    }
    result["midiPath"] = json!(mp);
    mp
}

// ---- startup -----------------------------------------------------------------------

/// main.js adoptInstallerForgePath: the folder the installer recorded wins
/// unless the user already chose one, or it would trade a working env for an
/// empty one.
fn adopt_installer_forge_path(h: &Host) {
    if !forge_paths(h).forge_env_dir.is_empty() {
        return;
    }
    let chosen = fpaths::query_forge_storage_dir();
    if chosen.is_empty() {
        return;
    }
    let chosen = PathBuf::from(chosen);
    let current = fpaths::forge_env_dir(&forge_paths(h));
    if storage::same_path(&chosen, &current) {
        return;
    }
    if fpaths::forge_env_ready(&ForgePaths::dir(&current)) && !fpaths::forge_env_ready(&ForgePaths::dir(&chosen)) {
        blog(&format!("ignored installer Forge storage {}: not provisioned, keeping {}", chosen.display(), current.display()));
        return;
    }
    let r = storage::assert_writable(chosen.parent().unwrap_or(&chosen)).and_then(|()| storage::mark_managed(&chosen));
    match r {
        Ok(_) => {
            let is_default = storage::same_path(&chosen, &fpaths::forge_env_dir(&ForgePaths::default()));
            let dir = if is_default { String::new() } else { chosen.to_string_lossy().into_owned() };
            h.settings.merge(&clear_paths_patch(&dir));
            blog(&format!("adopted installer Forge storage: {}", chosen.display()));
        }
        Err(e) => blog(&format!("installer Forge storage {} unusable ({e}); keeping {}", chosen.display(), current.display())),
    }
}

/// main.js recoverForgeEnv: pointed at an empty folder while a provisioned
/// env sits somewhere else (2.20.0's update could do that) -> use that one.
fn recover_forge_env(app: &AppHandle, h: &Host) {
    if fpaths::forge_env_ready(&forge_paths(h)) {
        return;
    }
    let Some(found) = fpaths::find_ready_forge_env(&forge_paths(h)) else { return };
    let current = fpaths::forge_env_dir(&forge_paths(h));
    if storage::same_path(&found, &current) {
        return;
    }
    h.settings.merge(&clear_paths_patch(&found.to_string_lossy()));
    fpaths::sync_installer_forge_path(&found);
    blog(&format!("recovered Forge env: {} was empty, using {}", current.display(), found.display()));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        Host::push(&app, "forge:status", json!({"event": "forge.log", "level": "info",
            "line": format!("Found your Forge engine at {}. It had been pointed somewhere empty, so setup is not needed.", found.display())}));
    });
}

pub fn init(app: &AppHandle) {
    let h = host(app);
    let emit_app = app.clone();
    let emit: runner::Emit = Arc::new(move |v: Value| on_status(&emit_app, v));
    let log: runner::Log = Arc::new(|m: &str| blog(m));
    let ctx_app = app.clone();
    let ctx: runner::GetCtx = Arc::new(move || {
        let h = host(&ctx_app);
        Ctx {
            paths: forge_paths(&h),
            perf: crate::ipc::performance(&h.settings.get("performance"), &h.settings.get("ui")),
            forge_engine: forge_engine_setting(&h),
        }
    });
    let f = Arc::new(Forge {
        runner: Runner::new(emit.clone(), log.clone(), ctx, fpaths::forge_jobs_file()),
        musescore: musescore::MuseScore::new(app, emit.clone()),
        provisioner: provision::Provisioner::new(emit, log),
        model_import: Mutex::new(()),
        settled: Gate::default(),
        reaped: Gate::default(),
        auto_paused: AtomicBool::new(false),
    });
    app.manage(f.clone());

    // Playback or a game up front: idle priority and smaller batches; under
    // "Pause Forge jobs entirely", suspended until the game closes.
    let hook_app = app.clone();
    crate::watch::on_step_aside(
        app,
        Box::new(move |ev: &Value| {
            let Some(f) = forge(&hook_app) else { return };
            f.runner.set_background(ev["background"] == json!(true));
            let pause = ev["pause"] == json!(true);
            if pause && f.runner.is_running() && !f.runner.is_paused() {
                if f.runner.set_paused(true)["ok"] == json!(true) {
                    f.auto_paused.store(true, Ordering::SeqCst);
                }
            } else if !pause && f.auto_paused.swap(false, Ordering::SeqCst) && f.runner.is_running() {
                f.runner.set_paused(false);
            }
        }),
    );

    // Off the boot path, as in main.js: which folder Forge lives in, then the
    // leftover-job reap once the window is up. forge:run waits for both.
    // MIDI_STUDIO_FORGE_RECOVER=0 skips the adoption and the drive scan, so
    // a test pointed at a scratch env is never redirected to the real one.
    let (a, hh, ff) = (app.clone(), h.clone(), f.clone());
    std::thread::spawn(move || {
        if std::env::var("MIDI_STUDIO_FORGE_RECOVER").as_deref() != Ok("0") {
            adopt_installer_forge_path(&hh);
            blog("t:adopt-forge-path");
            recover_forge_env(&a, &hh);
            blog("t:recover-forge-env");
        }
        ff.settled.open();
    });
    h.boot_mark(app, "jobs", "Checking background jobs");
    let (a, hh, ff) = (app.clone(), h, f);
    std::thread::spawn(move || {
        let t = Instant::now();
        while !hh.is_painted() && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(100));
        }
        let n = runner::reap_orphans(&fpaths::forge_jobs_file());
        blog("t:reap-orphans");
        ff.reaped.open();
        if n > 0 {
            blog(&format!("reaped {n} orphaned forge job(s)"));
            std::thread::sleep(Duration::from_millis(1500));
            Host::push(&a, "forge:status", json!({"event": "forge.log", "level": "info",
                "line": format!("Stopped {n} leftover Forge job{} from a previous session.", if n == 1 { "" } else { "s" })}));
        }
    });
}

/// RunEvent::Exit: the job objects would end every tree anyway when the
/// process goes; this also clears the pid file.
pub fn shutdown(app: &AppHandle) {
    if let Some(f) = forge(app) {
        f.runner.cancel_all();
        f.musescore.cancel_all();
        f.provisioner.cancel();
    }
}

// ---- app:* handlers ----------------------------------------------------------------

fn forge_info(app: &AppHandle, h: &Host) -> Value {
    let s = forge_paths(h);
    let dir = fpaths::forge_env_dir(&s);
    json!({
        "version": app.package_info().version.to_string(),
        "forgeReady": (forge_engine_setting(h) == "rust" && fpaths::forge_rs_exe().is_some_and(|exe|
            runner::probe_rust(&exe, &fpaths::forge_child_env(&s)).is_ok())) || fpaths::forge_env_ready(&s),
        "forgePython": fpaths::forge_env_python(&s).map_or(Value::Null, |p| json!(p.to_string_lossy())),
        "forgeEnvDir": dir.to_string_lossy(),
        "forgeFreeGb": fpaths::free_gb(&dir),
        "forgeDefaultDir": fpaths::forge_env_dir(&ForgePaths::default()).to_string_lossy(),
        "forgeCustom": !s.forge_env_dir.is_empty(),
        "forgeNeedGb": fpaths::forge_need_gb(),
    })
}

fn busy(f: &Forge) -> bool {
    f.runner.is_running() || f.musescore.is_running() || f.provisioner.is_running() || f.model_import.try_lock().is_err()
}

const BUSY: &str = "Wait for the current Forge job or setup to finish.";

fn ask(app: &AppHandle, title: &str, message: &str, buttons: MessageDialogButtons) -> MessageDialogResult {
    let mut d = app.dialog().message(message).title(title).kind(MessageDialogKind::Info).buttons(buttons);
    if let Some(w) = app.get_webview_window(MAIN) {
        d = d.parent(&w);
    }
    d.blocking_show_with_result()
}

fn is_choice(r: &MessageDialogResult, label: &str) -> bool {
    matches!(r, MessageDialogResult::Custom(s) if s == label) || (label == "Yes" && matches!(r, MessageDialogResult::Yes | MessageDialogResult::Ok))
}

/// main.js changeForgeStorage: pick (or be given) a folder, then move the env
/// there, use what is already there, or start fresh.
fn change_forge_storage(app: &AppHandle, h: &Host, f: &Forge, fixed: Option<PathBuf>) -> Value {
    if busy(f) {
        return json!({"ok": false, "error": BUSY});
    }
    let current = fpaths::forge_env_dir(&forge_paths(h));
    let default_dir = fpaths::forge_env_dir(&ForgePaths::default());
    let target = match fixed {
        Some(t) => t,
        None => {
            let mut d = app.dialog().file().set_title("Choose where to store the Forge engine").set_can_create_directories(true);
            if let Some(p) = current.parent() {
                d = d.set_directory(p);
            }
            if let Some(w) = app.get_webview_window(MAIN) {
                d = d.set_parent(&w);
            }
            match d.blocking_pick_folder().and_then(|p| p.into_path().ok()) {
                Some(p) => storage::target_for_selection(&p),
                None => return json!({"ok": false, "canceled": true}),
            }
        }
    };
    let target = std::path::absolute(&target).unwrap_or(target);
    let done = |moved: Option<bool>| {
        let mut v = forge_info(app, h);
        v["ok"] = json!(true);
        match moved {
            Some(m) => v["moved"] = json!(m),
            None => v["unchanged"] = json!(true),
        }
        v
    };
    if storage::same_path(&current, &target) {
        fpaths::sync_installer_forge_path(&target);
        return done(None);
    }
    if let Err(e) = storage::assert_writable(target.parent().unwrap_or(&target)) {
        return json!({"ok": false, "error": format!("That location is not writable. Choose another folder. ({e})")});
    }
    let source_exists = current.exists();
    let target_exists = target.exists() && !storage::is_empty(&target);
    let mut moved = false;
    if target_exists {
        if !storage::is_managed(&target, &default_dir) {
            return json!({"ok": false, "error": "The destination is not empty. Choose another folder."});
        }
        let r = ask(
            app,
            "Use existing Forge storage?",
            "MIDI Studio files already exist in that location.\n\nUse them instead of moving the current Forge files?",
            MessageDialogButtons::OkCancelCustom("Use existing".into(), "Cancel".into()),
        );
        if !is_choice(&r, "Use existing") {
            return json!({"ok": false, "canceled": true});
        }
    } else if source_exists {
        let r = ask(
            app,
            "Move Forge storage?",
            "Move the existing Forge engine to the new location?\n\nMoving keeps the current setup ready. Starting fresh requires downloading the Forge engine again.",
            MessageDialogButtons::YesNoCancelCustom("Move existing files".into(), "Start fresh".into(), "Cancel".into()),
        );
        if is_choice(&r, "Move existing files") {
            if let Err(e) = storage::move_managed(&current, &target, &default_dir) {
                return json!({"ok": false, "error": e.to_string()});
            }
            moved = true;
        } else if is_choice(&r, "Start fresh") {
            if let Err(e) = storage::mark_managed(&target) {
                return json!({"ok": false, "error": e.to_string()});
            }
        } else {
            return json!({"ok": false, "canceled": true});
        }
    } else if let Err(e) = storage::mark_managed(&target) {
        return json!({"ok": false, "error": e.to_string()});
    }
    let is_default = storage::same_path(&target, &default_dir);
    let dir = if is_default { String::new() } else { target.to_string_lossy().into_owned() };
    h.settings.merge(&clear_paths_patch(&dir));
    fpaths::sync_installer_forge_path(&target);
    f.runner.invalidate_check();
    done(Some(moved))
}

fn open_path(app: &AppHandle, p: &Path) -> Result<(), String> {
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Closing mid-transcription throws away the minutes spent, or a multi-GB
/// setup download, without asking. Some(()) = the user chose to keep it.
fn close_guard(app: &AppHandle, f: &Forge) -> Option<()> {
    let (job, midi, setup) = (f.runner.is_running(), f.musescore.is_running(), f.provisioner.is_running());
    let importing = f.model_import.try_lock().is_err();
    if !job && !midi && !setup && !importing {
        return None;
    }
    let visible = app.get_webview_window(MAIN).is_some_and(|w| w.is_visible().unwrap_or(false));
    if !visible {
        return None; // nobody to ask
    }
    let what = if importing { "Your local Medley model is still being imported." }
        else if job { "A transcription is still running." } else if midi { "A MIDI download is still running." } else { "Midi Forge setup is still downloading." };
    let r = ask(
        app,
        "Still working",
        &format!("{what}\n\nQuit anyway? The work in progress is lost."),
        MessageDialogButtons::OkCancelCustom("Quit anyway".into(), "Keep running".into()),
    );
    if is_choice(&r, "Quit anyway") { None } else { Some(()) }
}

pub fn dispatch(app: &AppHandle, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let f = forge(app)?;
    let h = host(app);
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    let opts = || if a0.is_object() { a0.clone() } else { json!({}) };
    let obj = |v: &Value, k: &str| v.get(k).filter(|x| x.is_object()).cloned().unwrap_or(json!({}));
    Some(Ok(match channel {
        // The shell asks before it tears its panels down, so "Keep running"
        // leaves them live; the close that follows says it already asked.
        "win:canClose" => json!(close_guard(app, &f).is_none()),
        "win:close" => {
            if truthy(a0.get("confirmed")) || close_guard(app, &f).is_none() {
                return None; // ipc.rs closes
            }
            Value::Null
        }
        "forge:check" => {
            f.settled.wait();
            let mode = a0.get("mode").and_then(Value::as_str).filter(|m| runner::RUST_MODES.contains(m));
            f.runner.check_mode(mode, truthy(a0.get("skipSeparation")), truthy(a0.get("fresh")))
        }
        "forge:importMedleyModel" => {
            f.settled.wait();
            if busy(&f) { return Some(Ok(json!({"ok":false, "error": BUSY}))); }
            let Ok(_guard) = f.model_import.try_lock() else { return Some(Ok(json!({"ok":false, "error": BUSY}))); };
            let mut picker = app.dialog().file().set_title("Import existing Medley model")
                .add_filter("Medley ONNX or original checkpoint", &["onnx", "ckpt"]);
            if let Some(window) = app.get_webview_window(MAIN) { picker = picker.set_parent(&window); }
            let Some(source) = picker.blocking_pick_file().and_then(|p| p.into_path().ok()) else {
                return Some(Ok(json!({"ok":false, "canceled":true})));
            };
            match medley::import(&source, &forge_paths(&h)) {
                Ok(path) => {
                    f.runner.invalidate_check();
                    json!({"ok":true, "path":path})
                }
                Err(error) => json!({"ok":false, "error":error}),
            }
        }
        "forge:provision" => {
            f.settled.wait();
            if f.model_import.try_lock().is_err() { return Some(Err(BUSY.into())); }
            if f.provisioner.is_running() {
                return Some(Ok(json!({"running": true})));
            }
            f.runner.invalidate_check();
            let s = forge_paths(&h);
            let (h2, h3) = (h.clone(), h.clone());
            f.provisioner.start(provision::StartReq {
                env_dir: fpaths::forge_env_dir(&s),
                fallback_dir: fpaths::legacy_default_forge_env_dir(),
                engine_dir: paths::engine_dir(),
                log_path: fpaths::forge_setup_log(),
                on_fallback: Box::new(move |d: &Path| {
                    h2.settings.merge(&json!({"paths": {"forgeEnvDir": d.to_string_lossy()}}));
                }),
                child_env: Box::new(move || fpaths::forge_child_env(&forge_paths(&h3))),
            });
            json!({"started": true})
        }
        "forge:provision:cancel" => {
            f.provisioner.cancel();
            json!(true)
        }
        "forge:run" => {
            f.reaped.wait(); // invariant 10: a leftover job is gone before a new one starts
            f.settled.wait();
            let o = opts();
            let pipeline = match js_str(o.get("pipeline")) {
                p if p.is_empty() => "melody".to_string(),
                p => p,
            };
            json!(f.runner.run(
                &js_str(o.get("inputPath")),
                &pipeline,
                truthy(o.get("skipSeparation")),
                &obj(&o, "advanced"),
                &obj(&o, "timing"),
                &js_str(o.get("outputName")),
                &output_dir(&host(app)),
            ))
        }
        "forge:yt" => {
            f.reaped.wait();
            f.settled.wait();
            let o = opts();
            let out = match js_str(o.get("outDir")) {
                d if d.is_empty() => output_dir(&h).to_string_lossy().into_owned(),
                d => d,
            };
            let url = js_str(o.get("url"));
            if musescore::is_musescore(&url) {
                json!(f.musescore.start(&url, PathBuf::from(out)))
            } else {
                json!(f.runner.yt(&url, &out))
            }
        }
        "app:setForgeEngine" => {
            let want = js_str(Some(&a0)).to_lowercase();
            if want == "rust" || want == "python" {
                h.settings.merge(&json!({"forge": {"engine": want}}));
                f.runner.invalidate_check(); // the other engine answers forge:check
            }
            engine_info(&h)
        }
        "forge:cancel" => {
            let id = js_str(Some(&a0));
            json!(f.musescore.cancel(&id) || f.runner.cancel(&id))
        }
        "forge:pause" => {
            f.auto_paused.store(false, Ordering::SeqCst);
            f.runner.set_paused(truthy(Some(&a0)))
        }
        "app:forgeInfo" => {
            f.settled.wait();
            forge_info(app, &h)
        }
        "app:changeForgeFolder" => {
            f.settled.wait();
            change_forge_storage(app, &h, &f, None)
        }
        "app:resetForgeFolder" => {
            f.settled.wait();
            change_forge_storage(app, &h, &f, Some(fpaths::forge_env_dir(&ForgePaths::default())))
        }
        "app:openSetupLog" => {
            let p = fpaths::forge_setup_log();
            if !p.exists() {
                return Some(Ok(json!({"ok": false, "error": "no setup log yet"})));
            }
            if open_path(app, &p).is_err() {
                let _ = app.opener().reveal_item_in_dir(&p);
            }
            json!({"ok": true, "path": p.to_string_lossy()})
        }
        "app:openForgeFolder" => {
            let dir = fpaths::forge_env_dir(&forge_paths(&h));
            let target = if dir.exists() {
                dir
            } else {
                match dir.parent().filter(|p| p.exists()) {
                    Some(p) => p.to_path_buf(),
                    None => fpaths::local_app_data(),
                }
            };
            json!(open_path(app, &target).err().unwrap_or_default())
        }
        "app:cleanReinstall" => {
            if busy(&f) {
                return Some(Ok(json!({"ok": false, "error": BUSY})));
            }
            // Only ever OUR managed env, never an adopted legacy midi-forge.
            let dir = fpaths::forge_env_dir(&forge_paths(&h));
            if !storage::is_managed(&dir, &fpaths::forge_env_dir(&ForgePaths::default())) {
                return Some(Ok(json!({"ok": false, "error": "refused (unsafe path)"})));
            }
            let models = dir.join("models");
            if [models.join("bs_rofo_sw").join(medley::ONNX), models.join("onnx").join(medley::ONNX),
                models.join(medley::ONNX), models.join("bs_rofo_sw/BS-Rofo-SW-Fixed.ckpt")].iter().any(|p| p.exists()) {
                return Some(Ok(json!({"ok":false,"error":format!(
                    "Move your Medley model and any original checkpoint/YAML outside {} before cleaning. Setup cannot download them again.", dir.display())})));
            }
            f.runner.invalidate_check();
            match if dir.exists() { std::fs::remove_dir_all(&dir) } else { Ok(()) } {
                Ok(()) => json!({"ok": true, "dir": dir.to_string_lossy()}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            }
        }
        _ => return None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_move_into_the_output_folder() {
        let root = std::env::temp_dir().join(format!("ms-forge-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (work, out) = (root.join("work"), root.join("out"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(work.join("song.mid"), b"m").unwrap();
        std::fs::write(out.join("song.mid"), b"old").unwrap();
        let mut r = json!({"midiPath": work.join("song.mid").to_string_lossy()});
        let mp = finalize_outputs(&mut r, &out);
        assert_eq!(PathBuf::from(&mp), out.join("song (2).mid"), "never overwrites an earlier result");
        assert_eq!(r["midiPath"], json!(mp));
        assert!(!work.join("song.mid").exists());
        assert!(r.get("projectPath").is_none());

        // A melody result: candidates move with it and a project is written.
        for n in ["lead.mid", "lead_clean.mid", "lead_alt.mid"] {
            std::fs::write(work.join(n), b"m").unwrap();
        }
        let mut r = json!({
            "midiPath": work.join("lead.mid").to_string_lossy(),
            "candidates": {"primary": work.join("lead.mid").to_string_lossy(), "clean": work.join("lead_clean.mid").to_string_lossy(), "alternate": work.join("lead_alt.mid").to_string_lossy()},
            "candidateCounts": {"clean": 10}, "sourceAudio": "C:\\a.mp3", "pipeline": "melody", "timing": {"start": null, "end": null},
        });
        let mp = finalize_outputs(&mut r, &out);
        assert_eq!(PathBuf::from(&mp), out.join("lead.mid"));
        assert_eq!(r["candidates"]["primary"], json!(mp), "the same file moves once");
        assert_eq!(PathBuf::from(r["candidates"]["clean"].as_str().unwrap()), out.join("lead_clean.mid"));
        let project: Value = serde_json::from_str(&std::fs::read_to_string(out.join("lead.midstudio.json")).unwrap()).unwrap();
        assert_eq!(project["format"], "midi-studio-project");
        assert_eq!(project["previewAudio"], "C:\\a.mp3");
        assert_eq!(project["candidateCounts"]["clean"], 10);
        assert_eq!(r["projectPath"], json!(out.join("lead.midstudio.json").to_string_lossy()));
        // A user may have moved the old MIDI but kept their edited project.
        std::fs::write(out.join("chorus.midstudio.json"), b"preserve my edits").unwrap();
        let workers: Vec<_> = (0..4).map(|worker| {
            let dir = work.join(worker.to_string());
            let out = out.clone();
            std::thread::spawn(move || {
                std::fs::create_dir_all(&dir).unwrap();
                let midi = dir.join("chorus.mid");
                std::fs::write(&midi, [worker as u8]).unwrap();
                let mut r = json!({"midiPath": midi, "candidates": {"clean": midi}});
                finalize_outputs(&mut r, &out);
                let project: Value = serde_json::from_slice(&std::fs::read(r["projectPath"].as_str().unwrap()).unwrap()).unwrap();
                assert_eq!(r["midiPath"], project["candidates"]["clean"]);
                assert_eq!(std::fs::read(r["midiPath"].as_str().unwrap()).unwrap(), [worker as u8]);
                r["midiPath"].as_str().unwrap().to_owned()
            })
        }).collect();
        let unique: std::collections::HashSet<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(unique.len(), 4);
        assert_eq!(std::fs::read(out.join("chorus.midstudio.json")).unwrap(), b"preserve my edits");
        let _ = std::fs::remove_dir_all(&root);
    }
}
