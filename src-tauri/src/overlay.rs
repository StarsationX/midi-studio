// overlay.rs: "Perch", the always-on-top playback overlay. electron/overlay.js
// plus the glue main.js kept around it (song-name tracking, auto-show on play,
// the two global keys, overlay-state, the engine-event fan-out).
//
// It is a second webview window that receives the same engine-event stream the
// Player tab does, so there is one clock and the two cannot disagree.
//
// The window recipe is the one prototypes/overlay-proto proved against a
// foreground Notepad and a topmost borderless-fullscreen window:
//   * focusable(false): tao's WS_EX_NOACTIVATE, which survives its exstyle
//     rewrites. Taking focus off the game mid-song pauses playback, which is
//     the exact problem this window exists to explain.
//   * it is created visible, never shown later: tauri's show() is SW_SHOW,
//     which DOES activate a WS_EX_NOACTIVATE window whenever this process may
//     take the foreground (see show_inactive). The prototype only ever tested
//     with another process in front, where that cannot happen.
//   * then SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE): Electron's
//     setAlwaysOnTop(true, 'screen-saver') is that call on Windows.
//   * opacity is CSS on the page. LWA_ALPHA does not survive: tao drops
//     WS_EX_LAYERED whenever it rewrites the extended style.
//   * a WinEvent hook on EVENT_SYSTEM_FOREGROUND re-asserts topmost, because a
//     game that is itself topmost lands above the overlay when it re-activates.
//
// Saved bounds are Electron's: DIP, per mode, under overlay.bounds.<mode>.
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, IsWindowVisible, SetWindowPos, ShowWindow,
    EVENT_SYSTEM_FOREGROUND, HWND_TOPMOST, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
};

use crate::{blog, Host, MAIN};

/// Window labels are perch-1, perch-2, ...: a closed overlay is destroyed, and
/// a fresh one must never collide with a label tao has not released yet.
pub const LABEL_PREFIX: &str = "perch-";
const HTML: &str = "overlay/overlay.html";
const PAD: f64 = 24.0;

pub struct ModeSize {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

/// Per mode, so switching modes does not squeeze the roll into a strip meant
/// for the clock.
pub fn mode_size(mode: &str) -> Option<ModeSize> {
    let (width, height, min_width, min_height) = match mode {
        "full" => (460.0, 300.0, 260.0, 170.0),
        "slim" => (420.0, 96.0, 240.0, 72.0),
        "mini" => (168.0, 64.0, 120.0, 52.0),
        _ => return None,
    };
    Some(ModeSize { width, height, min_width, min_height })
}

pub fn defaults() -> Value {
    json!({
        "mode": "full", "opacity": 0.92, "clickThrough": false, "locked": false,
        "autoShow": true, "autoHide": true, "lookahead": 3,
        "showKeys": true, "showTransport": true, "bounds": {},
    })
}

/// JavaScript's Number(v): a missing value is NaN, null is 0.
fn num(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

/// `Number(v) || fallback`.
fn num_or(v: Option<&Value>, fallback: f64) -> f64 {
    let n = num(v);
    if n.is_nan() || n == 0.0 { fallback } else { n }
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn jnum(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 { json!(x as i64) } else { json!(x) }
}

/// overlay.js config(): the saved object over the defaults, clamped.
pub fn config_of(raw: &Value) -> Value {
    let mut cfg = defaults().as_object().cloned().unwrap_or_default();
    if let Some(o) = raw.as_object() {
        for (k, v) in o {
            cfg.insert(k.clone(), v.clone());
        }
    }
    if mode_size(cfg.get("mode").and_then(Value::as_str).unwrap_or("")).is_none() {
        cfg.insert("mode".into(), json!("full"));
    }
    let opacity = num_or(cfg.get("opacity"), 0.92).clamp(0.2, 1.0);
    cfg.insert("opacity".into(), jnum(opacity));
    let lookahead = num_or(cfg.get("lookahead"), 3.0).clamp(1.0, 12.0);
    cfg.insert("lookahead".into(), jnum(lookahead));
    if !cfg.get("bounds").is_some_and(Value::is_object) {
        cfg.insert("bounds".into(), json!({}));
    }
    Value::Object(cfg)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A monitor's work area in DIP, with its scale. DIP here is the monitor's own
/// physical rectangle over its own scale, which is exact for the primary
/// display and what Electron's DIP space reduces to on a single monitor.
#[derive(Clone, Copy, Debug)]
pub struct Display {
    pub work: Rect,
    pub scale: f64,
}

fn display_of(m: &Monitor) -> Display {
    let s = m.scale_factor();
    let wa = m.work_area();
    Display {
        work: Rect {
            x: f64::from(wa.position.x) / s,
            y: f64::from(wa.position.y) / s,
            w: f64::from(wa.size.width) / s,
            h: f64::from(wa.size.height) / s,
        },
        scale: s,
    }
}

fn displays(app: &AppHandle) -> (Display, Vec<Display>) {
    let all: Vec<Display> = app.available_monitors().unwrap_or_default().iter().map(display_of).collect();
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| display_of(&m))
        .or_else(|| all.first().copied())
        .unwrap_or(Display { work: Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0 }, scale: 1.0 });
    (primary, all)
}

/// overlay.js _placement(): the saved rectangle for this mode if it is still
/// on a display that exists, else the top-right of the primary work area.
pub fn placement(cfg: &Value, primary: &Display, all: &[Display]) -> Rect {
    let mode = cfg["mode"].as_str().unwrap_or("full");
    let size = mode_size(mode).unwrap_or_else(|| mode_size("full").unwrap());
    let empty = json!({});
    let saved = cfg["bounds"].get(mode).filter(|v| v.is_object()).unwrap_or(&empty);
    let w = js_round(num_or(saved.get("width"), size.width)).max(size.min_width);
    let h = js_round(num_or(saved.get("height"), size.height)).max(size.min_height);
    let corner = || {
        let a = primary.work;
        Rect { x: a.x + a.w - w - PAD, y: a.y + PAD, w, h }
    };
    let (sx, sy) = (num(saved.get("x")), num(saved.get("y")));
    if !sx.is_finite() || !sy.is_finite() {
        return corner();
    }
    let (x, y) = (js_round(sx), js_round(sy));
    // Any decent overlap counts; requiring the whole window to fit would
    // reject a deliberate hang off the edge of the screen.
    let on_screen = all.iter().any(|d| {
        let a = d.work;
        x + w > a.x + 40.0 && x < a.x + a.w - 40.0 && y + h > a.y && y < a.y + a.h - 40.0
    });
    if on_screen { Rect { x, y, w, h } } else { corner() }
}

/// overlay.js snap(): park in one of nine positions on the display the window
/// is on. Physical pixels in and out; the pad is 24 DIP.
pub fn snap_rect(where_: &str, win: (i32, i32, i32, i32), work: (i32, i32, i32, i32), scale: f64) -> (i32, i32) {
    let (_, _, bw, bh) = win;
    let (ax, ay, aw, ah) = work;
    let pad = (PAD * scale).round() as i32;
    let mut parts = where_.split('-');
    let vert = parts.next().filter(|s| !s.is_empty()).unwrap_or("top");
    let horiz = parts.next().filter(|s| !s.is_empty()).unwrap_or("right");
    let x = match horiz {
        "left" => ax + pad,
        "center" => ax + js_round(f64::from(aw - bw) / 2.0) as i32,
        _ => ax + aw - bw - pad,
    };
    let y = match vert {
        "top" => ay + pad,
        "middle" => ay + js_round(f64::from(ah - bh) / 2.0) as i32,
        _ => ay + ah - bh - pad,
    };
    (x, y)
}

// ---- Win32: topmost without activation -------------------------------------

fn raise_topmost(h: isize) {
    if h == 0 {
        return;
    }
    unsafe {
        SetWindowPos(h as HWND, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// The overlay's HWND while it is on screen; 0 otherwise. Read by the
/// foreground hook, which runs on its own thread.
static KEEP: AtomicIsize = AtomicIsize::new(0);

fn keep_on_top() {
    let h = KEEP.load(Ordering::Relaxed);
    if h != 0 && unsafe { IsWindowVisible(h as HWND) } != 0 {
        raise_topmost(h);
    }
}

/// Now, and again shortly after: the foreground event can arrive before the
/// newly active window's own thread has moved it to the top of the band, and
/// a single re-assert then loses that race.
unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    if KEEP.load(Ordering::Relaxed) == 0 {
        return;
    }
    keep_on_top();
    let _ = std::thread::Builder::new().name("perch-topmost-late".into()).spawn(|| {
        for ms in [60, 250] {
            std::thread::sleep(Duration::from_millis(ms));
            keep_on_top();
        }
    });
}

/// One hook for the life of the process. Out of context, so it costs nothing
/// in the game's process; SKIPOWNPROCESS, so the overlay's own windows do not
/// make it fire.
fn start_topmost_keeper() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = std::thread::Builder::new().name("perch-topmost".into()).spawn(|| unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.is_null() {
                blog("perch: foreground hook unavailable");
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        });
    });
}

fn hwnd_of(w: &WebviewWindow) -> isize {
    w.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

// ---- state ------------------------------------------------------------------

#[derive(Default)]
struct State {
    gen: u64,
    open: bool,
    ready: bool,
    shown: bool,
    /// Events that arrived before the page said it was ready.
    pending: Vec<(String, Value)>,
    /// What is loaded. The engine only ever sees a path on the way in and
    /// never reports it back, so it is remembered as commands go past.
    song: String,
    remember: Option<Sender<()>>,
}

pub struct Perch {
    st: Mutex<State>,
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn perch(app: &AppHandle) -> Option<Arc<Perch>> {
    app.try_state::<Arc<Perch>>().map(|s| s.inner().clone())
}

fn settings(app: &AppHandle) -> crate::settings::Settings {
    app.state::<Arc<Host>>().settings.clone()
}

pub fn config(app: &AppHandle) -> Value {
    config_of(&settings(app).get("overlay"))
}

/// overlay.js save(): a shallow patch over the current config, merged in.
fn save(app: &AppHandle, patch: Value) -> Value {
    let mut next = config(app);
    if let (Some(n), Some(p)) = (next.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            n.insert(k.clone(), v.clone());
        }
    }
    settings(app).merge(&json!({"overlay": next.clone()}));
    next
}

fn label(gen: u64) -> String {
    format!("{LABEL_PREFIX}{gen}")
}

impl Perch {
    fn window(&self, app: &AppHandle) -> Option<WebviewWindow> {
        let st = lock(&self.st);
        if !st.open {
            return None;
        }
        app.get_webview_window(&label(st.gen))
    }

    pub fn is_open(&self) -> bool {
        lock(&self.st).open
    }

    fn send(&self, app: &AppHandle, channel: &str, payload: Value) {
        let mut st = lock(&self.st);
        if !st.open {
            return;
        }
        if !st.ready {
            st.pending.push((channel.to_string(), payload));
            return;
        }
        let target = label(st.gen);
        drop(st);
        let _ = app.emit_to(target.as_str(), channel, payload);
    }
}

/// The window's bounds in DIP, as Electron's getBounds reported them.
fn bounds_dip(w: &WebviewWindow) -> Option<Value> {
    let s = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?;
    let size = w.inner_size().ok()?;
    Some(json!({
        "x": js_round(f64::from(pos.x) / s) as i64, "y": js_round(f64::from(pos.y) / s) as i64,
        "width": js_round(f64::from(size.width) / s) as i64, "height": js_round(f64::from(size.height) / s) as i64,
    }))
}

fn remember_bounds(app: &AppHandle, w: &WebviewWindow) {
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let Some(b) = bounds_dip(w) else { return };
    let c = config(app);
    let mode = c["mode"].as_str().unwrap_or("full").to_string();
    let mut bounds = c["bounds"].as_object().cloned().unwrap_or_default();
    bounds.insert(mode, b);
    save(app, json!({"bounds": Value::Object(bounds)}));
}

/// Put the window at a DIP rectangle. Position first: crossing onto a monitor
/// with another scale makes tao rescale the window, and the size has to be
/// set after that, in the target monitor's pixels.
fn apply_rect(w: &WebviewWindow, r: Rect, all: &[Display], primary: &Display) {
    let d = all
        .iter()
        .find(|d| r.x >= d.work.x - 1.0 && r.x < d.work.x + d.work.w && r.y >= d.work.y - 1.0 && r.y < d.work.y + d.work.h)
        .unwrap_or(primary);
    let s = d.scale;
    let _ = w.set_position(PhysicalPosition::new(js_round(r.x * s) as i32, js_round(r.y * s) as i32));
    let _ = w.set_size(PhysicalSize::new(js_round(r.w * s).max(1.0) as u32, js_round(r.h * s).max(1.0) as u32));
}

fn apply_opacity(w: &WebviewWindow, cfg: &Value) {
    let op = num_or(cfg.get("opacity"), 0.92).clamp(0.2, 1.0);
    let _ = w.eval(format!("document.documentElement.style.opacity='{op}'"));
}

/// Top of the topmost band, without activation, and kept there.
///
/// Perch is never shown with tauri's show(). That is tao's
/// ShowWindow(SW_SHOW), and WS_EX_NOACTIVATE does not stop SW_SHOW from
/// activating the window whenever this process may take the foreground: when
/// MIDI Studio itself is in front, or straight after Ctrl+Alt+O over a game,
/// because a hotkey grants that right (measured: tests/perch_focus.rs S11b).
/// Instead the window is created visible with focused(false), which tao shows
/// with SW_SHOWNOACTIVATE, and a closed Perch is destroyed rather than
/// hidden, so there is never a second show. The page stays transparent until
/// its config has arrived (VEIL), so the markup's defaults never flash.
fn show_inactive(w: &WebviewWindow) {
    let h = hwnd_of(w);
    if h != 0 && unsafe { IsWindowVisible(h as HWND) } == 0 {
        unsafe { ShowWindow(h as HWND, SW_SHOWNOACTIVATE) };
    }
    raise_topmost(h);
    KEEP.store(h, Ordering::Relaxed);
}

/// Runs before the page's own scripts: transparent until the host applies
/// the configured opacity in mark_ready.
const VEIL: &str = "(function(){function v(){document.documentElement.style.opacity='0';}\
if(document.documentElement){v();}else{new MutationObserver(function(_,o){if(document.documentElement){v();o.disconnect();}})\
.observe(document,{childList:true});}})();";

pub fn open(app: &AppHandle) {
    let Some(p) = perch(app) else { return };
    if let Some(w) = p.window(app) {
        show_inactive(&w);
        return;
    }
    let cfg = config(app);
    let mode = cfg["mode"].as_str().unwrap_or("full").to_string();
    let size = mode_size(&mode).unwrap_or_else(|| mode_size("full").unwrap());
    let (primary, all) = displays(app);
    let place = placement(&cfg, &primary, &all);
    let locked = cfg["locked"] == json!(true);
    let click_through = cfg["clickThrough"] == json!(true);

    let gen = {
        let mut st = lock(&p.st);
        st.gen += 1;
        st.open = true;
        st.ready = false;
        st.shown = false;
        st.pending.clear();
        st.gen
    };
    let built = WebviewWindowBuilder::new(app, label(gen), WebviewUrl::App(HTML.into()))
        .title("Perch")
        .position(place.x, place.y)
        .inner_size(place.w, place.h)
        .min_inner_size(size.min_width, size.min_height)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(!locked)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .focusable(false)
        .visible(true)
        .initialization_script(VEIL)
        // WebView2 shares one environment per user-data folder, and a second
        // webview created with different switches fails outright.
        .additional_browser_args(&crate::browser_args())
        .build();
    let w = match built {
        Ok(w) => w,
        Err(e) => {
            blog(&format!("perch: window failed: {e}"));
            let mut st = lock(&p.st);
            if st.gen == gen {
                st.open = false;
            }
            return;
        }
    };
    apply_rect(&w, place, &all, &primary);
    if click_through {
        let _ = w.set_ignore_cursor_events(true);
    }
    show_inactive(&w);

    let app2 = app.clone();
    let remember = crate::debounce(400, move || {
        let Some(p) = perch(&app2) else { return };
        if let Some(w) = p.window(&app2) {
            remember_bounds(&app2, &w);
        }
    });
    lock(&p.st).remember = Some(remember);

    let app2 = app.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(p) = perch(&app2) {
                let st = lock(&p.st);
                if st.gen == gen {
                    if let Some(tx) = st.remember.as_ref() {
                        let _ = tx.send(());
                    }
                }
            }
        }
        WindowEvent::Destroyed => {
            let Some(p) = perch(&app2) else { return };
            let was_open = {
                let mut st = lock(&p.st);
                if st.gen != gen || !st.open {
                    return;
                }
                st.open = false;
                st.ready = false;
                st.pending.clear();
                st.remember = None;
                true
            };
            KEEP.store(0, Ordering::Relaxed);
            if was_open {
                state_changed(&app2);
            }
        }
        _ => {}
    });

    // Never leave an open overlay invisible because the page did not report in.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let Some(p) = perch(&app2) else { return };
        let late = {
            let mut st = lock(&p.st);
            let late = st.gen == gen && st.open && !st.shown;
            if late {
                st.shown = true;
            }
            late
        };
        if late {
            blog("perch: page never reported ready, unveiling anyway");
            if let Some(w) = p.window(&app2) {
                apply_opacity(&w, &config(&app2));
                show_inactive(&w);
            }
        }
    });
    blog(&format!("perch: open {} mode={mode}", label(gen)));
}

pub fn close(app: &AppHandle) {
    let Some(p) = perch(app) else { return };
    let Some(w) = p.window(app) else { return };
    remember_bounds(app, &w);
    {
        let mut st = lock(&p.st);
        st.open = false;
        st.ready = false;
        st.shown = false;
        st.pending.clear();
        st.remember = None;
    }
    KEEP.store(0, Ordering::Relaxed);
    let _ = w.destroy();
    blog("perch: closed");
}

pub fn is_open(app: &AppHandle) -> bool {
    perch(app).is_some_and(|p| p.is_open())
}

/// overlay.js markReady(): its saved settings first (the page boots on the
/// markup's defaults), then whatever queued up, then onto the screen.
fn mark_ready(app: &AppHandle) {
    let Some(p) = perch(app) else { return };
    let Some(w) = p.window(app) else { return };
    let cfg = config(app);
    let (queued, target, first_show) = {
        let mut st = lock(&p.st);
        st.ready = true;
        let first = !st.shown;
        st.shown = true;
        (std::mem::take(&mut st.pending), label(st.gen), first)
    };
    let _ = app.emit_to(target.as_str(), "overlay-config", cfg.clone());
    for (channel, payload) in queued {
        let _ = app.emit_to(target.as_str(), channel.as_str(), payload);
    }
    // Lifts VEIL, after the config is in the page's queue.
    apply_opacity(&w, &cfg);
    if first_show {
        show_inactive(&w);
    }
    blog(&format!("perch: ready {target}{}", if first_show { ", unveiled" } else { "" }));
}

pub fn send(app: &AppHandle, channel: &str, payload: Value) {
    if let Some(p) = perch(app) {
        p.send(app, channel, payload);
    }
}

fn set_click_through(app: &AppHandle, on: bool) -> Value {
    let cfg = save(app, json!({"clickThrough": on}));
    if let Some(w) = perch(app).and_then(|p| p.window(app)) {
        let _ = w.set_ignore_cursor_events(on);
        raise_topmost(hwnd_of(&w));
    }
    send(app, "overlay-config", cfg.clone());
    cfg
}

fn set_opacity(app: &AppHandle, v: Option<&Value>) -> Value {
    let cfg = save(app, json!({"opacity": jnum(num_or(v, 1.0).clamp(0.2, 1.0))}));
    if let Some(w) = perch(app).and_then(|p| p.window(app)) {
        apply_opacity(&w, &cfg);
    }
    cfg
}

fn set_locked(app: &AppHandle, on: bool) -> Value {
    let cfg = save(app, json!({"locked": on}));
    if let Some(w) = perch(app).and_then(|p| p.window(app)) {
        let _ = w.set_resizable(!on);
        raise_topmost(hwnd_of(&w));
    }
    send(app, "overlay-config", cfg.clone());
    cfg
}

fn set_mode(app: &AppHandle, mode: &str) -> Value {
    let Some(size) = mode_size(mode) else { return config(app) };
    let w = perch(app).and_then(|p| p.window(app));
    // Remember the size of the mode being left before resizing, or the modes
    // slowly overwrite each other's remembered dimensions.
    if let Some(w) = &w {
        remember_bounds(app, w);
    }
    let cfg = save(app, json!({"mode": mode}));
    if let Some(w) = &w {
        let (primary, all) = displays(app);
        let place = placement(&cfg, &primary, &all);
        let _ = w.set_min_size(Some(LogicalSize::new(size.min_width, size.min_height)));
        apply_rect(w, place, &all, &primary);
        raise_topmost(hwnd_of(w));
    }
    send(app, "overlay-config", cfg.clone());
    cfg
}

fn snap(app: &AppHandle, where_: &str) -> Value {
    let Some(w) = perch(app).and_then(|p| p.window(app)) else { return config(app) };
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return config(app) };
    let mon = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = mon {
        let wa = m.work_area();
        let (x, y) = snap_rect(
            where_,
            (pos.x, pos.y, size.width as i32, size.height as i32),
            (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32),
            m.scale_factor(),
        );
        let _ = w.set_position(PhysicalPosition::new(x, y));
        raise_topmost(hwnd_of(&w));
    }
    config(app)
}

fn resize(app: &AppHandle, size: &Value) {
    let Some(w) = perch(app).and_then(|p| p.window(app)) else { return };
    if !size.is_object() {
        return;
    }
    let width = js_round(num_or(size.get("width"), 0.0));
    let height = js_round(num_or(size.get("height"), 0.0));
    if width < 100.0 || height < 40.0 {
        return;
    }
    let _ = w.set_size(LogicalSize::new(width, height));
}

/// overlay.js apply(): the four that touch the window, then the rest.
fn apply(app: &AppHandle, patch: &Value) -> Value {
    let Some(o) = patch.as_object() else { return config(app) };
    let truthy = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    };
    if let Some(v) = o.get("clickThrough") {
        set_click_through(app, truthy(v));
    }
    if o.contains_key("opacity") {
        set_opacity(app, o.get("opacity"));
    }
    if let Some(v) = o.get("locked") {
        set_locked(app, truthy(v));
    }
    if let Some(v) = o.get("mode") {
        set_mode(app, v.as_str().unwrap_or(""));
    }
    let rest: Map<String, Value> =
        o.iter().filter(|(k, _)| !["clickThrough", "opacity", "locked", "mode"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    if !rest.is_empty() {
        let cfg = save(app, Value::Object(rest));
        send(app, "overlay-config", cfg.clone());
        return cfg;
    }
    config(app)
}

fn state(app: &AppHandle) -> Value {
    let mut cfg = config(app);
    if let Some(o) = cfg.as_object_mut() {
        // open first, as main.js's { open, ...config } put it.
        let mut out = Map::new();
        out.insert("open".into(), json!(is_open(app)));
        for (k, v) in o.iter() {
            out.insert(k.clone(), v.clone());
        }
        return Value::Object(out);
    }
    cfg
}

pub fn state_changed(app: &AppHandle) {
    Host::push(app, "overlay-state", state(app));
}

/// main.js openOverlay(): it opens with an empty roll otherwise, because the
/// notes arrived on a midi_loaded long before this window existed, so the
/// Player tab is asked to say it again. `auto`: a Play opened it, so a Play
/// that fails before it starts closes it again (overlay.js).
pub fn open_overlay(app: &AppHandle, auto: bool) {
    open(app);
    Host::push(app, "overlay-wants-state", json!({}));
    let song = perch(app).map(|p| lock(&p.st).song.clone()).unwrap_or_default();
    send(app, "engine-event", json!({"event": "now_playing", "name": song, "autoShown": auto}));
    state_changed(app);
}

fn toggle(app: &AppHandle) {
    if is_open(app) {
        close(app);
    } else {
        open_overlay(app, false);
    }
    state_changed(app);
}

/// Ctrl+Alt+P / Ctrl+Alt+O. Global, because both are needed while the game has
/// focus. P undoes click-through, which is otherwise impossible: the window
/// stops taking clicks entirely. Runs off the UI thread: building a webview
/// from an event handler on the main thread deadlocks on Windows.
pub fn shortcut(app: &AppHandle, p_key: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        if p_key {
            if !is_open(&app) {
                open_overlay(&app, false);
                return;
            }
            let on = config(&app)["clickThrough"] != json!(true);
            set_click_through(&app, on);
            state_changed(&app);
        } else {
            toggle(&app);
        }
    });
}

fn basename_song(file: &str) -> String {
    let base = file.rsplit(['\\', '/']).next().unwrap_or("");
    let lower = base.to_ascii_lowercase();
    for ext in [".midi", ".mid"] {
        if lower.ends_with(ext) {
            return base[..base.len() - ext.len()].to_string();
        }
    }
    base.to_string()
}

/// engine:send passes through here first: what is loaded, and that a song is
/// starting (soon enough to open the window before the countdown, not after).
pub fn on_engine_send(app: &AppHandle, msg: &Value) {
    let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or("");
    let file = [msg.get("path"), msg.get("midi_path")]
        .into_iter()
        .flatten()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .map(str::to_string);
    if let (true, Some(file)) = (cmd == "load_midi" || cmd == "play", file) {
        let song = basename_song(&file);
        if let Some(p) = perch(app) {
            lock(&p.st).song = song.clone();
        }
        send(app, "engine-event", json!({"event": "now_playing", "name": song}));
    }
    if cmd == "play" && config(app)["autoShow"] != json!(false) && !is_open(app) {
        open_overlay(app, true);
    }
}

/// Every push to the main window passes through here; Perch is a separate
/// window, so it needs its own copy of the engine stream.
pub fn fan_out(app: &AppHandle, channel: &str, payload: &Value) {
    if channel == "engine-event" {
        send(app, channel, payload.clone());
    }
}

/// The perch.* and overlay channels. None: not one of ours.
pub fn dispatch(app: &AppHandle, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !channel.starts_with("overlay:") {
        return None;
    }
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    // ready / close / resize name the Perch window they came from. One that is
    // being torn down must not act on the window that replaced it. (Electron's
    // per-window IPC made this impossible; one shared command does not.)
    let from = match channel {
        "overlay:resize" => a0.get("from").and_then(Value::as_str).map(str::to_string),
        _ => a0.as_str().map(str::to_string),
    };
    if let Some(from) = from.filter(|f| f.starts_with(LABEL_PREFIX)) {
        let current = perch(app).map(|p| {
            let st = lock(&p.st);
            if st.open { label(st.gen) } else { String::new() }
        });
        if current.as_deref() != Some(from.as_str()) {
            blog(&format!("perch: {channel} from stale {from} ignored"));
            return Some(Ok(Value::Null));
        }
    }
    Some(Ok(match channel {
        "overlay:ready" => {
            mark_ready(app);
            Host::push(app, "overlay-wants-state", json!({}));
            Value::Null
        }
        "overlay:close" => {
            close(app);
            state_changed(app);
            Value::Null
        }
        "overlay:resize" => {
            resize(app, &a0);
            Value::Null
        }
        // Transport from the overlay is replayed as the hotkey the Player tab
        // already handles, so the queue, the playlist and the tempo stay in
        // one place.
        "overlay:command" => {
            let allowed = ["play", "stop", "pause", "next_track", "prev_track", "seek_fwd", "seek_back"];
            if let Some(name) = a0.as_str().filter(|n| allowed.contains(n)) {
                Host::push(app, "engine-event", json!({"event": "hotkey", "name": name}));
            }
            Value::Null
        }
        "overlay:apply" => {
            let cfg = apply(app, &a0);
            state_changed(app);
            cfg
        }
        "overlay:snap" => snap(app, a0.as_str().unwrap_or("")),
        "overlay:state" => state(app),
        "overlay:toggle" => {
            toggle(app);
            state(app)
        }
        // The Player tab's answer to overlay-wants-state. Only the shapes the
        // overlay reads are forwarded, so a frame cannot use this as a general
        // channel into the always-on-top window.
        "overlay:replay" => {
            let kind = a0.get("event").and_then(Value::as_str).unwrap_or("");
            if a0.is_object() && ["midi_loaded", "playback_started", "progress"].contains(&kind) {
                send(app, "engine-event", a0);
            }
            Value::Null
        }
        _ => return Some(Err(format!("unknown channel: {channel}"))),
    }))
}

/// After the main window exists. Perch goes with it: skipTaskbar and always on
/// top, left behind it would be a window the user can see and cannot reach,
/// and it would keep the app from exiting.
pub fn init(app: &AppHandle) {
    app.manage(Arc::new(Perch { st: Mutex::new(State::default()) }));
    start_topmost_keeper();
    if let Some(main) = app.get_webview_window(MAIN) {
        let app2 = app.clone();
        main.on_window_event(move |e| {
            if let WindowEvent::Destroyed = e {
                close(&app2);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disp(x: f64, y: f64, w: f64, h: f64, scale: f64) -> Display {
        Display { work: Rect { x, y, w, h }, scale }
    }

    #[test]
    fn config_clamps_like_overlay_js() {
        let c = config_of(&json!({"mode": "huge", "opacity": 5, "lookahead": 0, "bounds": [1]}));
        assert_eq!(c["mode"], json!("full"));
        assert_eq!(c["opacity"], json!(1));
        assert_eq!(c["lookahead"], json!(3));
        assert_eq!(c["bounds"], json!({}));
        let c = config_of(&json!({"opacity": 0.05, "lookahead": 40, "mode": "mini", "autoShow": false}));
        assert_eq!(c["opacity"], json!(0.2));
        assert_eq!(c["lookahead"], json!(12));
        assert_eq!(c["mode"], json!("mini"));
        assert_eq!(c["autoShow"], json!(false));
        assert_eq!(c["showKeys"], json!(true));
        // Number('') is 0, and 0 || 0.92 is the default.
        assert_eq!(config_of(&json!({"opacity": ""}))["opacity"], json!(0.92));
    }

    #[test]
    fn placement_defaults_to_top_right_and_rejects_lost_monitors() {
        let primary = disp(0.0, 0.0, 2560.0, 1392.0, 1.0);
        let all = [primary];
        let c = config_of(&json!({}));
        assert_eq!(placement(&c, &primary, &all), Rect { x: 2560.0 - 460.0 - 24.0, y: 24.0, w: 460.0, h: 300.0 });
        // Saved on a monitor that is no longer plugged in.
        let c = config_of(&json!({"bounds": {"full": {"x": 4000, "y": 100, "width": 500, "height": 320}}}));
        assert_eq!(placement(&c, &primary, &all), Rect { x: 2560.0 - 500.0 - 24.0, y: 24.0, w: 500.0, h: 320.0 });
        // A deliberate hang off the left edge is kept.
        let c = config_of(&json!({"bounds": {"full": {"x": -300, "y": 100, "width": 460, "height": 300}}}));
        assert_eq!(placement(&c, &primary, &all), Rect { x: -300.0, y: 100.0, w: 460.0, h: 300.0 });
        // Never below the mode's minimum.
        let c = config_of(&json!({"mode": "slim", "bounds": {"slim": {"x": 10, "y": 10, "width": 50, "height": 10}}}));
        assert_eq!(placement(&c, &primary, &all), Rect { x: 10.0, y: 10.0, w: 240.0, h: 72.0 });
        // The second monitor counts.
        let second = disp(2560.0, 0.0, 1280.0, 680.0, 1.5);
        let c = config_of(&json!({"bounds": {"full": {"x": 3000, "y": 100}}}));
        assert_eq!(placement(&c, &primary, &[primary, second]).x, 3000.0);
    }

    #[test]
    fn nine_snap_positions() {
        let win = (500, 500, 460, 300);
        let work = (0, 0, 2560, 1392);
        assert_eq!(snap_rect("top-left", win, work, 1.0), (24, 24));
        assert_eq!(snap_rect("top-center", win, work, 1.0), (1050, 24));
        assert_eq!(snap_rect("top-right", win, work, 1.0), (2076, 24));
        assert_eq!(snap_rect("middle-left", win, work, 1.0), (24, 546));
        assert_eq!(snap_rect("middle-center", win, work, 1.0), (1050, 546));
        assert_eq!(snap_rect("bottom-right", win, work, 1.0), (2076, 1068));
        assert_eq!(snap_rect("bottom-center", win, work, 1.0), (1050, 1068));
        // Unknown halves fall back to top / right, as overlay.js did.
        assert_eq!(snap_rect("", win, work, 1.0), (2076, 24));
        // The pad is 24 DIP.
        assert_eq!(snap_rect("top-left", (0, 0, 690, 450), (0, 0, 3840, 2088), 1.5), (36, 36));
    }

    #[test]
    fn song_name_drops_the_extension_only() {
        assert_eq!(basename_song(r"C:\Music\Clair de Lune.mid"), "Clair de Lune");
        assert_eq!(basename_song("/x/y/song.MIDI"), "song");
        assert_eq!(basename_song("a.mid.json"), "a.mid.json");
    }
}
