// MIDI Studio, Tauri 2 host. The successor to electron/main.js: one frameless
// window running the existing renderer/, the Player engine (player-rs) in
// process, and the app's IPC surface behind a single `ipc` command whose
// channel names are electron/preload.js's (see ipc.rs and
// renderer/shared/bridge.js).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod forge;
mod ipc;
mod library;
mod midi_doc;
mod migrate;
mod overlay;
mod paths;
mod review;
mod settings;
mod updater;
mod vp_sheet;
mod watch;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use engine::Engine;
use settings::Settings;

pub const MAIN: &str = "main";

// Tauri's own WebView2 defaults have to be restated once any argument is set,
// then the switches that keep Self MIDI and the Editor playing while the window
// is in the background (Electron: backgroundThrottling:false plus the two
// appendSwitch calls at the top of main.js).
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";

const BOOT_LOG_MAX: u64 = 64 * 1024;

// Register before the single-instance plugin: a second launch can arrive
// before setup() creates Host or its first webview.
struct ForgeSetupRequest(AtomicBool);

pub struct Host {
    pub settings: Settings,
    pub engine: Engine,
    pub post_update: bool,
    // MIDI_STUDIO_BACKGROUND=1: a test run that must not take the foreground
    // from whatever the user is doing.
    background: bool,
    boot_steps: Mutex<Vec<Value>>,
    painted: AtomicBool,
    closing: AtomicBool,
    close_acked: AtomicBool,
    open_path: Mutex<String>,
    last_window_state: Mutex<Value>,
    persist_bounds: Mutex<Option<Sender<()>>>,
    // The Electron build's localStorage, injected this launch (migrate.rs);
    // marked done once the page has painted with it.
    migration: Mutex<Option<migrate::Pending>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// main.js blog(): synchronous, so the line that explains a silent exit is
/// never the one that is lost.
pub fn blog(m: &str) {
    static WRITE: Mutex<()> = Mutex::new(());
    let line = format!("{} {}\n", now_ms(), m);
    let _guard = lock(&WRITE);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(paths::boot_log()) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn trim_boot_log() {
    let file = paths::boot_log();
    let Ok(meta) = std::fs::metadata(&file) else { return };
    if meta.len() <= BOOT_LOG_MAX {
        return;
    }
    if let Ok(text) = std::fs::read(&file) {
        let tail = &text[text.len() - BOOT_LOG_MAX as usize..];
        let start = tail.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
        let _ = std::fs::write(&file, &tail[start..]);
    }
}

/// Every webview gets the same switches: WebView2 shares one environment per
/// user-data folder, and a second webview asking for different ones fails.
pub fn browser_args() -> String {
    let mut args = BROWSER_ARGS.to_string();
    if let Ok(port) = std::env::var("MIDI_STUDIO_CDP_PORT") {
        if port.parse::<u16>().is_ok() {
            args.push_str(&format!(" --remote-debugging-port={port}"));
        }
    }
    args
}

/// Trailing-edge debounce on its own thread: f runs `ms` after the last poke.
pub fn debounce(ms: u64, f: impl Fn() + Send + 'static) -> Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    let _ = std::thread::Builder::new().name("debounce".into()).spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(Duration::from_millis(ms)) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        f();
                        return;
                    }
                }
            }
            f();
        }
    });
    tx
}

pub fn midi_path_from_argv(argv: &[String]) -> Option<PathBuf> {
    argv.iter().skip(1).map(|a| PathBuf::from(a.trim())).find(|p| paths::is_midi(p) && p.is_file()).map(|p| std::path::absolute(&p).unwrap_or(p))
}

/// Paths the renderer reads straight off the disk (audio previews, the
/// Editor's MIDI fetch) go through the asset protocol, whose scope starts
/// empty. A path is let in at the moment the host hands it over.
pub fn allow_file(app: &AppHandle, p: &Path) {
    let _ = app.asset_protocol_scope().allow_file(p);
}

pub fn allow_dir(app: &AppHandle, p: &Path) {
    if !p.as_os_str().is_empty() {
        let _ = app.asset_protocol_scope().allow_directory(p, true);
    }
}

impl Host {
    pub fn push(app: &AppHandle, channel: &str, payload: Value) {
        // Every write site broadcasts library-changed, so this is the one place
        // the cached scan is dropped and a new one can never forget to.
        if channel == "library-changed" {
            library::invalidate();
        }
        let _ = app.emit_to(MAIN, channel, payload);
    }

    pub fn boot_mark(&self, app: &AppHandle, step: &str, label: &str) {
        {
            let mut steps = lock(&self.boot_steps);
            if steps.iter().any(|s| s["step"] == step) {
                return;
            }
            steps.push(json!({"step": step, "label": label, "t": now_ms() as u64}));
        }
        blog(&format!("boot:{step}"));
        Host::push(app, "boot-milestone", json!({"step": step, "label": label}));
    }

    pub fn boot_state(&self) -> Value {
        json!({"steps": lock(&self.boot_steps).clone(), "ready": self.painted.load(Ordering::SeqCst)})
    }

    pub fn is_painted(&self) -> bool {
        self.painted.load(Ordering::SeqCst)
    }

    pub fn take_open_path(&self) -> String {
        std::mem::take(&mut *lock(&self.open_path))
    }

    pub fn window_state(w: &WebviewWindow) -> Value {
        json!({
            "maximized": w.is_maximized().unwrap_or(false),
            "minimized": w.is_minimized().unwrap_or(false),
            "fullScreen": w.is_fullscreen().unwrap_or(false),
            "focused": w.is_focused().unwrap_or(false),
        })
    }

    fn send_window_state(&self, app: &AppHandle, w: &WebviewWindow) {
        let s = Host::window_state(w);
        {
            let mut last = lock(&self.last_window_state);
            if *last == s {
                return;
            }
            *last = s.clone();
        }
        Host::push(app, "window-state", s);
    }

    /// main.js's persist(): logical (DIP) bounds like Electron's getBounds, and
    /// nothing while minimised, when Windows reports the window at -32000.
    /// The size is the INNER size, the one create_window restores: the outer
    /// size of an undecorated window includes its resize border, and saving
    /// that grew the window on every launch.
    pub fn persist_bounds(&self, w: &WebviewWindow) {
        if w.is_minimized().unwrap_or(false) {
            return;
        }
        let maximized = w.is_maximized().unwrap_or(false);
        let mut patch = json!({"window": {"maximized": maximized}});
        if !maximized {
            let scale = w.scale_factor().unwrap_or(1.0);
            if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
                let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
                patch["window"]["x"] = json!(pos.x.round() as i64);
                patch["window"]["y"] = json!(pos.y.round() as i64);
                patch["window"]["width"] = json!(size.width.round() as i64);
                patch["window"]["height"] = json!(size.height.round() as i64);
            }
        }
        self.settings.merge(&patch);
    }

    /// The shell asked to close and every guard it owns has agreed.
    pub fn close_now(&self, w: &WebviewWindow) {
        self.closing.store(true, Ordering::SeqCst);
        self.persist_bounds(w);
        self.settings.flush();
        library::flush();
        let _ = w.close();
    }

    pub fn ack_close(&self) {
        self.close_acked.store(true, Ordering::SeqCst);
    }

    fn cleanup(&self) {
        blog("cleanup");
        self.settings.flush();
        library::flush();
        self.engine.shutdown();
    }
}

fn host(app: &AppHandle) -> Arc<Host> {
    app.state::<Arc<Host>>().inner().clone()
}

fn on_painted(app: &AppHandle) {
    let h = host(app);
    if h.painted.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(w) = app.get_webview_window(MAIN) else { return };
    // show() and maximize() both activate; a background run was created
    // visible and unfocused instead.
    if !h.background {
        if h.settings.get("window.maximized") == json!(true) {
            let _ = w.maximize();
        }
        let _ = w.show();
    }
    h.boot_mark(app, "painted", "Ready");
    h.send_window_state(app, &w);
}

/// A real page load, not on_painted's 3 s fallback: the document that ran the
/// migration script has finished loading.
fn commit_migration(app: &AppHandle) {
    let Some(h) = app.try_state::<Arc<Host>>() else { return };
    let pending = lock(&h.migration).take();
    if let Some(m) = pending {
        m.commit();
        blog(&format!("migrate: offered {} Electron localStorage keys (only missing ones are filled, once)", m.key_count()));
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let h = host(app);
    let wb = h.settings.get("window");
    let num = |k: &str| wb.get(k).and_then(Value::as_f64);
    let args = browser_args();
    let mut b = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("MIDI Studio")
        .decorations(false)
        .inner_size(num("width").filter(|v| *v > 0.0).unwrap_or(1240.0), num("height").filter(|v| *v > 0.0).unwrap_or(880.0))
        .min_inner_size(1040.0, 700.0)
        .visible(h.background)
        .focused(!h.background)
        .always_on_top(h.settings.get("ui.alwaysOnTop") != json!(false))
        .background_color(tauri::window::Color(0x11, 0x15, 0x16, 0xff))
        .additional_browser_args(&args);
    if let (Some(x), Some(y)) = (num("x"), num("y")) {
        b = b.position(x, y);
    }
    // Main frame only: the panels are same-origin iframes the page creates
    // after this has run, so they see the carried-over keys.
    if let Some(m) = lock(&h.migration).as_ref() {
        b = b.initialization_script(m.script.clone());
    }
    let w = b.build()?;
    blog("t:window");

    let app2 = app.clone();
    let persist = debounce(400, move || {
        if let Some(w) = app2.get_webview_window(MAIN) {
            host(&app2).persist_bounds(&w);
        }
    });
    *lock(&h.persist_bounds) = Some(persist);

    let app2 = app.clone();
    w.on_window_event(move |e| on_window_event(&app2, e));

    // Never leave the window hidden because a load event went missing.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let a = app2.clone();
        let _ = app2.run_on_main_thread(move || on_painted(&a));
    });
    Ok(w)
}

fn on_window_event(app: &AppHandle, e: &WindowEvent) {
    let h = host(app);
    let Some(w) = app.get_webview_window(MAIN) else { return };
    match e {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            h.send_window_state(app, &w);
            if let Some(tx) = lock(&h.persist_bounds).as_ref() {
                let _ = tx.send(());
            }
        }
        WindowEvent::Focused(_) | WindowEvent::ScaleFactorChanged { .. } => h.send_window_state(app, &w),
        WindowEvent::CloseRequested { api, .. } => {
            if h.closing.load(Ordering::SeqCst) {
                return;
            }
            // The renderer owns the guards (the Editor's unsaved edits), so
            // Alt+F4 and the taskbar go through the same path as the shell's
            // own close button. If the page cannot answer, close anyway: a
            // window that refuses to close is the bug main.js's
            // will-prevent-unload handler exists to prevent.
            api.prevent_close();
            h.close_acked.store(false, Ordering::SeqCst);
            Host::push(app, "close-requested", json!({}));
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let h = host(&app2);
                if !h.close_acked.load(Ordering::SeqCst) && !h.closing.load(Ordering::SeqCst) {
                    blog("close-requested unanswered, closing");
                    if let Some(w) = app2.get_webview_window(MAIN) {
                        h.close_now(&w);
                    }
                }
            });
        }
        WindowEvent::DragDrop(d) => on_drag_drop(app, d),
        _ => {}
    }
}

/// Tauri takes the OS drop (which suppresses HTML5 file drops on Windows), so
/// the bridge replays it as DOM drag events inside whichever panel is under
/// the cursor. Dropped paths are let into the asset scope first.
fn on_drag_drop(app: &AppHandle, d: &DragDropEvent) {
    let strs = |ps: &[PathBuf]| -> Vec<String> {
        ps.iter()
            .map(|p| {
                allow_file(app, p);
                p.to_string_lossy().into_owned()
            })
            .collect()
    };
    let payload = match d {
        DragDropEvent::Enter { paths, position } => json!({"type": "enter", "paths": strs(paths), "x": position.x, "y": position.y}),
        DragDropEvent::Over { position } => json!({"type": "over", "x": position.x, "y": position.y}),
        DragDropEvent::Drop { paths, position } => json!({"type": "drop", "paths": strs(paths), "x": position.x, "y": position.y}),
        DragDropEvent::Leave => json!({"type": "leave"}),
        _ => return,
    };
    Host::push(app, "studio-drag", payload);
}

/// Ctrl+Alt+P / Ctrl+Alt+O. Global because they are needed while the game
/// has focus. See overlay::shortcut.
fn on_overlay_shortcut(app: &AppHandle, shortcut: &Shortcut) {
    let p_key = shortcut.key == Code::KeyP;
    blog(&format!("shortcut {}", if p_key { "Ctrl+Alt+P" } else { "Ctrl+Alt+O" }));
    overlay::shortcut(app, p_key);
}

fn register_overlay_shortcuts(app: &AppHandle) {
    for code in [Code::KeyP, Code::KeyO] {
        let s = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code);
        if let Err(e) = app.global_shortcut().register(s) {
            blog(&format!("shortcut {code:?} unavailable: {e}"));
        }
    }
}

fn grant_known_dirs(app: &AppHandle, s: &Settings) {
    let out = paths::program_output_dir(&s.get_str("forge.outputDir"));
    allow_dir(app, &out);
    allow_dir(app, &paths::home_dir().join("Documents").join("MIDI Studio"));
    for k in ["libraryDir", "lastOutputDir"] {
        allow_dir(app, Path::new(&s.get_str(k)));
    }
    if let Some(dirs) = s.get("library.dirs").as_array() {
        for d in dirs.iter().filter_map(Value::as_str) {
            allow_dir(app, Path::new(d));
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    trim_boot_log();
    blog(&format!("--- boot --- tauri argv={}", argv.iter().skip(1).cloned().collect::<Vec<_>>().join(" ")));

    let app = tauri::Builder::default()
        .manage(ForgeSetupRequest(AtomicBool::new(argv.iter().any(|a| a == "--setup-forge"))))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Launching again must always end with the window on screen, and a
            // .mid double-clicked in Explorer goes to the Player.
            blog("second-instance");
            if argv.iter().any(|a| a == "--setup-forge") {
                app.state::<ForgeSetupRequest>().0.store(true, Ordering::SeqCst);
                Host::push(app, "setup-forge-requested", json!({}));
            }
            let Some(h) = app.try_state::<Arc<Host>>() else { return };
            if let Some(p) = midi_path_from_argv(&argv) {
                allow_file(app, &p);
                let p = p.to_string_lossy().into_owned();
                if h.is_painted() {
                    Host::push(app, "open-midi", json!({"midiPath": p}));
                } else {
                    *lock(&h.open_path) = p;
                }
            }
            if let Some(w) = app.get_webview_window(MAIN).filter(|_| !h.background) {
                let _ = w.unminimize();
                if h.is_painted() {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_overlay_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![ipc::ipc, ipc::asset_allow])
        .on_page_load(|webview, payload| {
            if webview.label() == MAIN && payload.event() == PageLoadEvent::Finished {
                commit_migration(webview.app_handle());
                on_painted(webview.app_handle());
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = Settings::open(paths::settings_file());
            blog(&format!("t:settings {}", settings.file().display()));
            let mappings = paths::ensure_user_mappings();
            blog(&format!("user mappings dir={}", mappings.display()));

            let push_app = handle.clone();
            let push: engine::Push = Arc::new(move |channel: &str, v: Value| {
                overlay::fan_out(&push_app, channel, &v);
                watch::on_engine_event(&push_app, channel, &v);
                Host::push(&push_app, channel, v)
            });
            let engine = Engine::new(push, paths::engine_dir(), Some(mappings), engine::dry_run_requested());
            blog(&format!("engine dir={} dry_run={}", paths::engine_dir().display(), engine.dry_run()));

            let open_path = midi_path_from_argv(&argv);
            if let Some(p) = &open_path {
                allow_file(&handle, p);
            }
            grant_known_dirs(&handle, &settings);
            app.manage(Arc::new(Host {
                settings,
                engine,
                post_update: argv.iter().any(|a| a == "--post-update"),
                background: std::env::var("MIDI_STUDIO_BACKGROUND").is_ok_and(|v| v == "1"),
                boot_steps: Mutex::new(Vec::new()),
                painted: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                close_acked: AtomicBool::new(false),
                open_path: Mutex::new(open_path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
                last_window_state: Mutex::new(Value::Null),
                persist_bounds: Mutex::new(None),
                migration: Mutex::new(migrate::prepare()),
            }));
            let h = host(&handle);
            h.boot_mark(&handle, "session", "Restoring session");
            register_overlay_shortcuts(&handle);
            h.boot_mark(&handle, "window", "Loading interface");
            create_window(&handle)?;
            overlay::init(&handle);
            updater::init(&handle);
            watch::init(&handle);
            forge::init(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build MIDI Studio");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            forge::shutdown(app);
            if let Some(h) = app.try_state::<Arc<Host>>() {
                h.cleanup();
            }
        }
    });
}
