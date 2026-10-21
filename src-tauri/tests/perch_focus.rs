//! End-to-end run of the real host: Perch never takes the foreground, the
//! updater against a localhost mock, gamewatch, panel-failed.
//!
//!   cargo build
//!   set PERCH_TEST_USER_DATA=<a scratch COPY of the user-data folder>
//!   cargo test --test perch_focus -- --ignored --nocapture
//!
//! It launches its OWN Notepad (and refuses to run if one is already open, so
//! it can never touch the user's), puts it in the foreground, and drives the
//! app through the WebView2 DevTools port: toggle, the nine-position snap,
//! resize, the three modes, opacity, click-through, lock, and play with
//! auto-show. After every step GetForegroundWindow must still be that Notepad
//! and Perch must sit above it. A topmost window of this test's own then
//! stands in for a topmost game. No keystroke or mouse input is synthesized:
//! the foreground is handed over with SetForegroundWindow, as the prototype
//! did. Playback is a dry run (MIDI_PLAYER_DRY_RUN=1), so no key is ever sent.
//!
//! Optional: PERCH_TEST_OUT (report file), PERCH_TEST_SHOTS (screenshot dir),
//! PERCH_TEST_MIDI (the .mid to play).
#![cfg(windows)]

use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

type H = isize;

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

// ---- Win32 --------------------------------------------------------------------

fn fg() -> H {
    unsafe { GetForegroundWindow() as H }
}
fn rect(h: H) -> RECT {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(h as HWND, &mut r) };
    r
}
fn exstyle(h: H) -> u32 {
    unsafe { GetWindowLongPtrW(h as HWND, GWL_EXSTYLE) as u32 }
}
fn visible(h: H) -> bool {
    h != 0 && unsafe { IsWindowVisible(h as HWND) } != 0
}
fn alive(h: H) -> bool {
    h != 0 && unsafe { IsWindow(h as HWND) } != 0
}
/// Is `a` above `b` in the z-order? Walks top-level windows top-down.
fn above(a: H, b: H) -> bool {
    unsafe {
        let mut h = GetTopWindow(std::ptr::null_mut());
        while !h.is_null() {
            if h as H == a {
                return true;
            }
            if h as H == b {
                return false;
            }
            h = GetWindow(h, GW_HWNDNEXT);
        }
    }
    false
}

struct Win {
    h: H,
    pid: u32,
    class: String,
    title: String,
}

unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> i32 {
    let v = &mut *(lp as *mut Vec<Win>);
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, &mut pid);
    let mut buf = [0u16; 256];
    let n = GetClassNameW(h, buf.as_mut_ptr(), 256);
    let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    let n = GetWindowTextW(h, buf.as_mut_ptr(), 256);
    let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    v.push(Win { h: h as H, pid, class, title });
    1
}
/// Top-level windows by class, title and pid only. No process is opened, so
/// a game that happens to be running is never touched.
fn windows() -> Vec<Win> {
    let mut v: Vec<Win> = vec![];
    unsafe { EnumWindows(Some(enum_cb), &mut v as *mut _ as LPARAM) };
    v
}
fn notepads() -> Vec<H> {
    windows().into_iter().filter(|w| w.class == "Notepad" && visible(w.h)).map(|w| w.h).collect()
}
fn perch_windows(pid: u32) -> Vec<H> {
    windows().into_iter().filter(|w| w.pid == pid && w.title == "Perch").map(|w| w.h).collect()
}
/// The visible Perch if there is one (a window being destroyed can linger
/// for a moment), else any.
fn perch_window(pid: u32) -> H {
    let all = perch_windows(pid);
    all.iter().copied().find(|h| visible(*h)).or(all.first().copied()).unwrap_or(0)
}
fn move_raw(h: H, x: i32, y: i32, w: i32, ht: i32) {
    unsafe { SetWindowPos(h as HWND, std::ptr::null_mut(), x, y, w, ht, SWP_NOZORDER | SWP_NOACTIVATE) };
}
/// Processes this test started (its own, the app, its Notepad). The
/// AttachThreadInput fallback is only ever used against one of these.
static OURS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Hand the foreground to a window this test created. No input is
/// synthesized: SetForegroundWindow, then the AttachThreadInput route if the
/// foreground lock refused it, and that only when the current foreground is
/// one of ours (never a game's or another app's thread).
fn bring_fg(h: H) -> bool {
    unsafe {
        if fg() == h {
            return true;
        }
        SetForegroundWindow(h as HWND);
        sleep(150);
        if fg() == h {
            return true;
        }
        let cur = fg();
        let mut cur_pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(cur as HWND, &mut cur_pid);
        if !OURS.lock().unwrap().contains(&cur_pid) {
            return false;
        }
        let me = GetCurrentThreadId();
        AttachThreadInput(me, fg_thread, 1);
        BringWindowToTop(h as HWND);
        SetForegroundWindow(h as HWND);
        AttachThreadInput(me, fg_thread, 0);
        sleep(200);
        fg() == h
    }
}
fn close_window(h: H) -> bool {
    unsafe { PostMessageW(h as HWND, WM_CLOSE, 0, 0) };
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) {
        if !alive(h) {
            return true;
        }
        sleep(50);
    }
    false
}
/// Did WebView2 actually paint? Perch's card is dark and sits over our white
/// Notepad, so a blank (transparent) webview reads as white here.
fn painted(ov: H) -> (bool, (u8, u8, u8)) {
    use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    let r = rect(ov);
    let (x, y) = (r.left + (r.right - r.left) / 2, r.top + (r.bottom - r.top) / 2);
    let c = unsafe {
        let dc = GetDC(std::ptr::null_mut());
        let c = GetPixel(dc, x, y);
        ReleaseDC(std::ptr::null_mut(), dc);
        c
    };
    let rgb = (c as u8, (c >> 8) as u8, (c >> 16) as u8);
    (rgb.0.max(rgb.1).max(rgb.2) < 120, rgb)
}

fn work_area() -> RECT {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut _ as *mut c_void, 0) };
    r
}

// A topmost window of our own: the stand-in for a game that is itself topmost.
unsafe extern "system" fn dummy_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if m == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }
    DefWindowProcW(h, m, w, l)
}
fn spawn_topmost_dummy(x: i32, y: i32, w: i32, h: i32) -> H {
    let out = Arc::new(AtomicUsize::new(0));
    let o2 = out.clone();
    std::thread::spawn(move || unsafe {
        let inst = GetModuleHandleW(std::ptr::null());
        let class: Vec<u16> = "PerchFocusTopmostDummy\0".encode_utf16().collect();
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(dummy_proc);
        wc.hInstance = inst;
        wc.hbrBackground = CreateSolidBrush(0x0080_3010);
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
        let title: Vec<u16> = "topmost game stand-in\0".encode_utf16().collect();
        let hwnd = CreateWindowExW(WS_EX_TOPMOST, class.as_ptr(), title.as_ptr(), WS_POPUP | WS_VISIBLE, x, y, w, h,
            std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null::<c_void>());
        o2.store(hwnd as usize, Ordering::SeqCst);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
    let t = Instant::now();
    while out.load(Ordering::SeqCst) == 0 && t.elapsed() < Duration::from_secs(3) {
        sleep(20);
    }
    out.load(Ordering::SeqCst) as H
}

// ---- DevTools ---------------------------------------------------------------------

/// The DevTools HTTP endpoint keeps the connection open, so read by
/// Content-Length rather than to EOF.
fn http_get(port: u16, path: &str) -> Option<String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let text = String::from_utf8_lossy(&buf).to_string();
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let len = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)));
            if len.is_some_and(|n| body.len() >= n) {
                return Some(body.to_string());
            }
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    String::from_utf8_lossy(&buf).split_once("\r\n\r\n").map(|(_, b)| b.to_string())
}

/// Whatever happens, the app and the Notepad this test started do not outlive it.
struct Cleanup {
    pid: u32,
    np: Arc<AtomicUsize>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let np = self.np.load(Ordering::SeqCst) as H;
        if alive(np) {
            close_window(np);
        }
        let _ = Command::new("taskkill").args(["/pid", &self.pid.to_string(), "/f"]).output();
    }
}

fn targets(port: u16) -> Vec<Value> {
    http_get(port, "/json").and_then(|b| serde_json::from_str::<Value>(&b).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn find_target(port: u16, pred: impl Fn(&str) -> bool, timeout: Duration) -> Option<String> {
    let t = Instant::now();
    while t.elapsed() < timeout {
        for x in targets(port) {
            let url = x["url"].as_str().unwrap_or("");
            if x["type"] == json!("page") && pred(url) {
                if let Some(ws) = x["webSocketDebuggerUrl"].as_str() {
                    return Some(ws.to_string());
                }
            }
        }
        sleep(150);
    }
    None
}

struct Cdp {
    ws: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    id: u64,
}

impl Cdp {
    fn connect(url: &str) -> Cdp {
        let (ws, _) = tungstenite::connect(url).expect("devtools websocket");
        Cdp { ws, id: 0 }
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        let id = self.id;
        self.ws.send(tungstenite::Message::Text(json!({"id": id, "method": method, "params": params}).to_string().into())).unwrap();
        loop {
            let m = self.ws.read().expect("devtools read");
            if let tungstenite::Message::Text(t) = m {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                if v["id"] == json!(id) {
                    return v;
                }
            }
        }
    }
    fn eval(&mut self, expr: &str) -> Value {
        let r = self.call("Runtime.evaluate", json!({"expression": expr, "awaitPromise": true, "returnByValue": true}));
        if let Some(ex) = r["result"].get("exceptionDetails") {
            return json!({"__error": ex["exception"]["description"].clone()});
        }
        r["result"]["result"]["value"].clone()
    }
    fn screenshot(&mut self, file: &Path) -> bool {
        let r = self.call("Page.captureScreenshot", json!({"format": "png"}));
        let Some(b64) = r["result"]["data"].as_str() else { return false };
        std::fs::write(file, b64_decode(b64)).is_ok()
    }
}

fn b64_decode(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter_map(val) {
        acc = (acc << 6) | c;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

// ---- the localhost update mock -------------------------------------------------------

const PAYLOAD: &[u8] = b"MZ not an installer: a test payload for the MIDI Studio updater, never run";

fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// /latest answers per `mode`: "same" (3.0.1), "good" (3.1.0 + right
/// digest), "bad" (3.1.0 + wrong digest). /asset 302s to /cdn/file.
fn update_mock(mode: Arc<Mutex<String>>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let b2 = base.clone();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let (base, mode) = (b2.clone(), mode.lock().unwrap().clone());
            std::thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                let _ = r.read_line(&mut line);
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                }
                let mut s = s;
                let mut send = |status: &str, extra: &str, body: &[u8]| {
                    let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len());
                    let _ = s.write_all(body);
                };
                match path.as_str() {
                    "/latest" => {
                        let tag = if mode == "same" { "v3.0.1" } else { "v3.1.0" };
                        let digest = if mode == "bad" { sha256_hex(b"tampered") } else { sha256_hex(PAYLOAD) };
                        let body = json!({"tag_name": tag, "body": "mock release", "html_url": format!("{base}/release"),
                            "assets": [{"name": "MIDI-Studio-3.1.0-Setup.exe", "browser_download_url": format!("{base}/asset"),
                                "size": PAYLOAD.len(), "digest": format!("sha256:{digest}")}]});
                        send("200 OK", "Content-Type: application/json\r\n", body.to_string().as_bytes());
                    }
                    "/asset" => send("302 Found", &format!("Location: {base}/cdn/file\r\n"), b""),
                    "/cdn/file" => send("200 OK", "", PAYLOAD),
                    _ => send("404 Not Found", "", b""),
                }
            });
        }
    });
    base
}

// ---- the report ---------------------------------------------------------------------

struct Report {
    lines: Vec<String>,
    pass: u32,
    fail: u32,
}

impl Report {
    fn line(&mut self, s: String) {
        println!("{s}");
        self.lines.push(s);
    }
    fn result(&mut self, ok: bool, step: &str, detail: String) {
        if ok { self.pass += 1 } else { self.fail += 1 }
        self.line(format!("[{}] {step}{}", if ok { "PASS" } else { "FAIL" }, if detail.is_empty() { String::new() } else { format!("\n       {detail}") }));
    }
}

struct Ctx {
    pid: u32,
    target: H,
}

/// The focus contract after one step: the foreground is still `target`, and
/// Perch (when it should be up) is visible and above it.
fn check(rep: &mut Report, c: &Ctx, step: &str, perch_up: bool, extra: Option<(bool, String)>) -> H {
    sleep(450);
    let f = fg();
    let ov = perch_window(c.pid);
    let mut why = vec![];
    if f != c.target {
        let who = windows().into_iter().find(|w| w.h == f).map_or("?".to_string(), |w| {
            format!("class={:?} title={:?} {}", w.class, w.title, if w.pid == c.pid { "(OUR APP)" } else if OURS.lock().unwrap().contains(&w.pid) { "(ours)" } else { "(another process)" })
        });
        why.push(format!("FOREGROUND STOLEN -> {f:#x}{} {who}", if f == ov { " (PERCH)" } else { "" }));
    }
    if perch_up {
        if !visible(ov) {
            why.push("perch not visible".into());
        } else if !above(ov, c.target) {
            why.push("perch NOT above the foreground window".into());
        }
    } else if visible(ov) {
        why.push("perch still visible".into());
    }
    let mut detail = String::new();
    if visible(ov) {
        let r = rect(ov);
        let ex = exstyle(ov);
        detail = format!(
            "fg={} perch=({},{} {}x{}) topmost={} noactivate={} transparent={} above={}",
            if f == c.target { "target" } else { "OTHER" },
            r.left, r.top, r.right - r.left, r.bottom - r.top,
            ex & WS_EX_TOPMOST != 0, ex & WS_EX_NOACTIVATE != 0, ex & WS_EX_TRANSPARENT != 0, above(ov, c.target)
        );
    } else {
        detail.push_str(&format!("fg={} perch=hidden", if f == c.target { "target" } else { "OTHER" }));
    }
    let n = perch_windows(c.pid).len();
    if n > 1 {
        detail.push_str(&format!(" perch-windows={n}"));
    }
    if let Some((ok, d)) = extra {
        if !ok {
            why.push(d.clone());
        }
        detail.push_str(&format!(" | {d}"));
    }
    if !why.is_empty() {
        detail.push_str(&format!("\n       !! {}", why.join("; ")));
    }
    rep.result(why.is_empty(), step, detail);
    ov
}

fn wait_for(timeout_ms: u64, mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(timeout_ms) {
        if f() {
            return true;
        }
        sleep(100);
    }
    false
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[test]
#[ignore = "launches the app and a Notepad; run by hand on a desktop session"]
fn perch_never_takes_the_foreground() {
    let user_data = PathBuf::from(std::env::var("PERCH_TEST_USER_DATA").expect("PERCH_TEST_USER_DATA: a scratch COPY of the user-data folder"));
    assert!(user_data.is_dir(), "{} is not a folder", user_data.display());
    let out = std::env::var("PERCH_TEST_OUT").map(PathBuf::from).unwrap_or_else(|_| user_data.join("perch-focus.txt"));
    let shots = std::env::var("PERCH_TEST_SHOTS").map(PathBuf::from).unwrap_or_else(|_| repo().join("tauri-shots"));
    let midi = std::env::var("PERCH_TEST_MIDI").map(PathBuf::from).unwrap_or_else(|_| repo().join("benchmarks").join("fixtures").join("normal.mid"));
    let midi = std::path::absolute(&midi).unwrap();
    assert!(midi.is_file(), "{} missing", midi.display());
    assert!(notepads().is_empty(), "a Notepad is already open; not touching it. Close it and run again.");
    // Every Tauri build shares the app identifier, so single-instance would
    // swallow this launch (or route another build's launch into ours), and a
    // second instance also holds Ctrl+Alt+P/O. Refuse rather than measure that.
    let running = Command::new("tasklist").args(["/FI", "IMAGENAME eq midi-studio.exe", "/NH"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase()).unwrap_or_default();
    assert!(!running.contains("midi-studio.exe"), "another midi-studio.exe is running; its single-instance lock would swallow or hijack this run");
    let boot_log = user_data.join("boot.log");
    let _ = std::fs::remove_file(&boot_log);
    // Perch's remembered per-mode bounds would make the expected sizes depend
    // on the copied profile. The store deep-merges, so they cannot be cleared
    // through the app; drop them from the scratch copy's file instead.
    let sfile = user_data.join("midi-studio-settings.json");
    if let Ok(text) = std::fs::read_to_string(&sfile) {
        if let Ok(mut v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
            if let Some(o) = v.get_mut("overlay").and_then(Value::as_object_mut) {
                o.insert("bounds".into(), json!({}));
                std::fs::write(&sfile, serde_json::to_string_pretty(&v).unwrap()).unwrap();
            }
        }
    }

    let mode = Arc::new(Mutex::new("same".to_string()));
    let mock = update_mock(mode.clone());
    let port: u16 = 9420 + (std::process::id() % 400) as u16;
    let mut rep = Report { lines: vec![], pass: 0, fail: 0 };

    let mut app: Child = Command::new(env!("CARGO_BIN_EXE_midi-studio"))
        .env("MIDI_STUDIO_USER_DATA", &user_data)
        .env("MIDI_STUDIO_BOOT_LOG", &boot_log)
        .env("MIDI_PLAYER_DRY_RUN", "1")
        .env("MIDI_STUDIO_BACKGROUND", "1")
        .env("MIDI_STUDIO_CDP_PORT", port.to_string())
        .env("MIDI_STUDIO_UPDATE_URL", format!("{mock}/latest"))
        .env("MIDI_STUDIO_UPDATE_NO_LAUNCH", "1")
        .env("MIDI_STUDIO_GAMEWATCH_NAMES", "notepad.exe")
        .env("MIDI_STUDIO_GAMEWATCH_FIRST_MS", "500")
        .env("MIDI_STUDIO_GAMEWATCH_POLL_MS", "1000")
        .spawn()
        .expect("launch midi-studio");
    let pid = app.id();
    OURS.lock().unwrap().extend([std::process::id(), pid]);
    let np_cell = Arc::new(AtomicUsize::new(0));
    let _cleanup = Cleanup { pid, np: np_cell.clone() };
    rep.line(format!("app pid={pid} devtools=:{port} user-data={} mock={mock}", user_data.display()));

    let main_ws = find_target(port, |u| u.ends_with("/index.html") || u.ends_with("localhost/"), Duration::from_secs(25)).expect("main page on devtools");
    let mut main = Cdp::connect(&main_ws);
    assert!(wait_for(15000, || main.eval("!!(window.studio && document.readyState === 'complete')") == json!(true)), "shell never came up");
    // Collect what the host pushes, from here on.
    main.eval(r#"(() => { window.__t = { update: [], game: [], failed: [], overlay: [] };
        studio.onUpdateStatus((s) => window.__t.update.push(s));
        studio.onGameActive((g) => window.__t.game.push(g));
        studio.onPanelFailed((p) => window.__t.failed.push(p));
        studio.onOverlayState((s) => window.__t.overlay.push(s.open));
        return true; })()"#);
    // Start from the defaults, wherever the copied profile left Perch.
    main.eval("studio.setOverlay({mode:'full', opacity:0.92, clickThrough:false, locked:false, autoShow:true, autoHide:true})");
    main.eval("studio.overlayState().then(s => s.open ? studio.toggleOverlay() : null)");
    sleep(500);

    // ---- our Notepad, in the foreground -------------------------------------------
    let _stub = Command::new("notepad.exe").spawn().expect("notepad");
    let mut np = 0;
    wait_for(8000, || {
        np = notepads().into_iter().next().unwrap_or(0);
        np != 0
    });
    assert!(np != 0, "notepad window never appeared");
    np_cell.store(np as usize, Ordering::SeqCst);
    let mut np_pid = 0u32;
    unsafe { GetWindowThreadProcessId(np as HWND, &mut np_pid) };
    OURS.lock().unwrap().push(np_pid);
    let wa = work_area();
    // Small, in the top-right corner where Perch opens: enough to sit under
    // it, without covering the user's desktop.
    move_raw(np, wa.right - 760, wa.top + 8, 750, 480);
    let got = bring_fg(np);
    rep.line(format!("notepad hwnd={np:#x}, foreground: {got}"));
    let c = Ctx { pid, target: np };
    check(&mut rep, &c, "S0 baseline: app up, our Notepad in front", false, None);

    // ---- toggle / snap / resize / modes -----------------------------------------------
    main.eval("studio.toggleOverlay()");
    wait_for(6000, || visible(perch_window(pid)));
    sleep(400);
    let (ok, px) = painted(perch_window(pid));
    let ov = check(&mut rep, &c, "S1 toggle open (studio.toggleOverlay), and WebView2 painted", true, Some((ok, format!("centre pixel {px:?} (dark = painted over white Notepad)"))));
    let perch_ws = find_target(port, |u| u.contains("overlay/overlay.html"), Duration::from_secs(5)).expect("perch on devtools");
    let mut perch = Cdp::connect(&perch_ws);
    let ready = wait_for(4000, || perch.eval("document.documentElement.dataset.mode") == json!("full"));
    let shown = perch.eval("[document.getElementById('song').textContent, getComputedStyle(document.documentElement).opacity, !!window.perch]");
    check(&mut rep, &c, "S1b page booted with its config (mode, opacity) and its bridge", true,
        Some((ready && shown[1] == json!("0.92") && shown[2] == json!(true), format!("page={shown}"))));

    let scale = {
        let r = rect(ov);
        f64::from(r.right - r.left) / 460.0
    };
    for (i, (spot, ex, ey)) in [
        ("bottom-left", Some(wa.left), None),
        ("middle-center", None, None),
        ("top-left", Some(wa.left), Some(wa.top)),
        ("top-right", None, Some(wa.top)),
    ]
    .into_iter()
    .enumerate()
    {
        main.eval(&format!("studio.snapOverlay('{spot}')"));
        sleep(150);
        let r = rect(ov);
        let pad = (24.0 * scale).round() as i32;
        let ok_x = ex.is_none_or(|x| (r.left - (x + pad)).abs() <= 2);
        let ok_y = ey.is_none_or(|y| (r.top - (y + pad)).abs() <= 2);
        let ok_b = spot != "bottom-left" || (r.bottom - (wa.bottom - pad)).abs() <= 2;
        check(&mut rep, &c, &format!("S2.{} snap {spot}", i + 1), true,
            Some((ok_x && ok_y && ok_b, format!("at ({},{})-({},{})", r.left, r.top, r.right, r.bottom))));
    }

    perch.eval("perch.resize(520, 330)");
    sleep(300);
    let r = rect(ov);
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    let want = ((520.0 * scale).round() as i32, (330.0 * scale).round() as i32);
    check(&mut rep, &c, "S3 resize from the page (perch.resize 520x330)", true,
        Some(((w - want.0).abs() <= 2 && (h - want.1).abs() <= 2, format!("size {w}x{h} want {want:?}"))));

    for (i, m) in ["slim", "mini", "full"].into_iter().enumerate() {
        main.eval(&format!("studio.setOverlay({{mode:'{m}'}})"));
        let page = wait_for(2000, || perch.eval("document.documentElement.dataset.mode") == json!(m));
        let r = rect(ov);
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let size_ok = match m {
            "slim" => (h - (96.0 * scale).round() as i32).abs() <= 2,
            "mini" => (h - (64.0 * scale).round() as i32).abs() <= 2,
            // Full comes back at the size it was left at.
            _ => (w - want.0).abs() <= 2 && (h - want.1).abs() <= 2,
        };
        check(&mut rep, &c, &format!("S4.{} mode {m}", i + 1), true, Some((page && size_ok, format!("page mode ok={page} size {w}x{h}"))));
    }

    main.eval("studio.setOverlay({opacity:0.5})");
    let op = wait_for(2000, || perch.eval("getComputedStyle(document.documentElement).opacity") == json!("0.5"));
    check(&mut rep, &c, "S5 opacity 0.5 (CSS on the page, not LWA)", true, Some((op, format!("css opacity 0.5: {op}"))));
    main.eval("studio.setOverlay({opacity:0.92})");

    main.eval("studio.setOverlay({clickThrough:true})");
    sleep(200);
    let t_on = exstyle(ov) & WS_EX_TRANSPARENT != 0;
    check(&mut rep, &c, "S6 click-through on", true, Some((t_on, format!("WS_EX_TRANSPARENT={t_on}"))));
    main.eval("studio.setOverlay({clickThrough:false})");
    sleep(200);
    let t_off = exstyle(ov) & WS_EX_TRANSPARENT == 0;
    check(&mut rep, &c, "S7 click-through off", true, Some((t_off, format!("WS_EX_TRANSPARENT cleared={t_off}"))));

    main.eval("studio.setOverlay({locked:true})");
    let locked = wait_for(2000, || perch.eval("document.getElementById('head').getAttribute('data-tauri-drag-region')") == json!("false"));
    check(&mut rep, &c, "S8 lock (no drag region, not resizable)", true, Some((locked, format!("drag region off={locked}"))));
    main.eval("studio.setOverlay({locked:false})");
    let unlocked = wait_for(2000, || perch.eval("document.getElementById('head').getAttribute('data-tauri-drag-region')") == json!("deep"));
    check(&mut rep, &c, "S9 unlock", true, Some((unlocked, format!("drag region back={unlocked}"))));

    // The menu sheet, for the screenshot set.
    perch.eval("document.getElementById('btn-menu').click()");
    sleep(300);
    let _ = std::fs::create_dir_all(&shots);
    let s1 = perch.screenshot(&shots.join("perch-menu.png"));
    perch.eval("document.getElementById('btn-menu').click()");
    check(&mut rep, &c, "S10 settings sheet opened from the page (clicked in-page, no OS input)", true, Some((s1, format!("screenshot={s1}"))));

    main.eval("studio.toggleOverlay()");
    wait_for(3000, || !visible(perch_window(pid)));
    check(&mut rep, &c, "S11 toggle closed", false, None);
    drop(perch);

    // MIDI Studio itself in front: the case where SW_SHOW activates a
    // WS_EX_NOACTIVATE window (this process may take the foreground, as it
    // also may straight after its global hotkey fires over a game).
    let main_h = windows().into_iter().find(|w| w.pid == pid && w.title == "MIDI Studio" && visible(w.h)).map_or(0, |w| w.h);
    let got_main = bring_fg(main_h);
    let cm = Ctx { pid, target: main_h };
    main.eval("studio.toggleOverlay()");
    wait_for(6000, || visible(perch_window(pid)));
    check(&mut rep, &cm, &format!("S11b open while MIDI Studio's own window is in front (fg={got_main})"), true, None);
    main.eval("studio.toggleOverlay()");
    wait_for(3000, || !visible(perch_window(pid)));
    bring_fg(np);
    check(&mut rep, &c, "S11c closed again, our Notepad back in front", false, None);

    // ---- play with auto-show ----------------------------------------------------------------
    let mp = midi.to_string_lossy().replace('\\', "\\\\");
    let sent = main.eval(&format!(
        "Promise.all([api.send({{cmd:'load_midi', path:'{mp}'}}), api.send({{cmd:'play', midi_path:'{mp}', target_hwnd:{np}, mapping:'virtualpiano', tempo:1, countdown:0, start_at:0, end_at:6}})])"
    ));
    let opened = wait_for(6000, || visible(perch_window(pid)));
    sleep(400);
    let (ok, px) = painted(perch_window(pid));
    check(&mut rep, &c, "S12 play -> Perch opens by itself (autoShow), painted", true,
        Some((opened && ok, format!("sent={sent} centre pixel {px:?}"))));
    let perch_ws = find_target(port, |u| u.contains("overlay/overlay.html"), Duration::from_secs(5)).expect("perch on devtools");
    let mut perch = Cdp::connect(&perch_ws);
    let named = wait_for(4000, || perch.eval("document.getElementById('song').textContent") == json!("normal"));
    let playing = wait_for(4000, || perch.eval("document.getElementById('card').dataset.state") == json!("playing"));
    sleep(1200);
    let s2 = perch.screenshot(&shots.join("perch.png"));
    check(&mut rep, &c, "S13 Perch shows the song (now_playing) and the live engine stream", true,
        Some((named && playing && s2, format!("name={named} state=playing:{playing} screenshot={s2}"))));
    for m in ["slim", "mini"] {
        main.eval(&format!("studio.setOverlay({{mode:'{m}'}})"));
        wait_for(2000, || perch.eval("document.documentElement.dataset.mode") == json!(m));
        sleep(500);
        perch.screenshot(&shots.join(format!("perch-{m}.png")));
    }
    main.eval("studio.setOverlay({mode:'full'})");
    check(&mut rep, &c, "S14 mode switches during playback", true, None);
    let hid = wait_for(15000, || !visible(perch_window(pid)));
    let f = fg();
    rep.result(hid && f == np, "S15 playback_done -> Perch steps aside (autoHide)", format!("hidden={hid} fg=target:{}", f == np));
    drop(perch);
    // The Player panel advances its own queue on a natural end (it did not
    // start this song; its queue is whatever the profile left), and that
    // play auto-shows Perch again, as it would under Electron. Stop it and
    // put Perch away before the next phase.
    sleep(1500);
    let again = main.eval("studio.overlayState().then(s => s.open)");
    // From here on Perch only moves when this test says so.
    main.eval("studio.setOverlay({autoShow:false, autoHide:false})");
    for _ in 0..8 {
        main.eval("api.send({cmd:'stop'})");
        sleep(250);
    }
    main.eval("studio.overlayState().then(s => s.open ? studio.toggleOverlay() : null)");
    let settled = wait_for(5000, || !visible(perch_window(pid)));
    check(&mut rep, &c, "S16 Player's queue advance (re-shown by it: see detail) put away", false,
        Some((settled, format!("re-shown by the Player's own queue: {again}; hidden={settled}"))));

    // ---- a topmost "game" re-activating -------------------------------------------------------
    // Small (640x400) and only for the three checks below.
    let dummy = spawn_topmost_dummy(wa.right - 660, wa.top + 8, 640, 400);
    let d_fg = bring_fg(dummy);
    let cd = Ctx { pid, target: dummy };
    main.eval("studio.overlayState().then(s => s.open ? s : studio.toggleOverlay())");
    wait_for(6000, || visible(perch_window(pid)));
    check(&mut rep, &cd, &format!("T1 over a TOPMOST window (fg={d_fg})"), true, None);
    bring_fg(np);
    let back = bring_fg(dummy);
    check(&mut rep, &cd, &format!("T2 topmost window re-activated (via SetForegroundWindow: {back}); foreground hook re-asserts"), true, None);
    main.eval("studio.snapOverlay('top-right')");
    check(&mut rep, &cd, "T3 snap while the topmost window has the foreground", true, None);
    main.eval("studio.overlayState().then(s => s.open ? studio.toggleOverlay() : null)");
    wait_for(3000, || !visible(perch_window(pid)));
    close_window(dummy);
    bring_fg(np);

    // ---- gamewatch / step-aside ---------------------------------------------------------------
    let game_seen = wait_for(5000, || main.eval("window.__t.game.some(g => g.game === 'notepad.exe')") == json!(true));
    let log = std::fs::read_to_string(&boot_log).unwrap_or_default();
    let stepped = log.contains("forge:step-aside") && log.contains("\"background\":true");
    rep.result(game_seen && stepped, "G1 gamewatch: our Notepad (watched as a test name) -> game-active push + step-aside event",
        format!("game-active={} step-aside logged={stepped}", main.eval("JSON.stringify(window.__t.game)")));

    // ---- panel-failed -------------------------------------------------------------------------
    main.eval("(() => { const f = document.createElement('iframe'); f.id = '__nope'; f.style.display = 'none'; f.src = './nope-panel/index.html'; document.body.appendChild(f); return true; })()");
    let failed = wait_for(5000, || main.eval("window.__t.failed.some(p => /nope-panel/.test(p.url))") == json!(true));
    let nested = main.eval("(() => { const d = document.getElementById('__nope').contentDocument; return d ? d.querySelectorAll('script').length : -1; })()");
    main.eval("document.getElementById('__nope').remove()");
    rep.result(failed && nested == json!(0), "P1 a missing panel page -> panel-failed, and the fallback shell inside it is stopped",
        format!("events={} nested scripts left={nested}", main.eval("JSON.stringify(window.__t.failed)")));

    // ---- updater against the mock -------------------------------------------------------------
    let states = |m: &mut Cdp| m.eval("window.__t.update.map(s => s.state).join(',')");
    main.eval("window.__t.update = []");
    main.eval("studio.checkForUpdates()");
    let none = wait_for(5000, || states(&mut main).as_str().unwrap_or("").ends_with("none"));
    rep.result(none, "U1 up to date (mock tag v3.0.1)", format!("states={}", states(&mut main)));

    *mode.lock().unwrap() = "good".into();
    main.eval("window.__t.update = []");
    main.eval("studio.checkForUpdates()");
    let avail = wait_for(5000, || states(&mut main).as_str().unwrap_or("").ends_with("available"));
    let v = main.eval("JSON.stringify(window.__t.update[window.__t.update.length-1])");
    rep.result(avail, "U2 update available (mock tag v3.1.0)", format!("states={} last={v}", states(&mut main)));

    main.eval("window.__t.update = []");
    main.eval("studio.applyUpdate()");
    let ready = wait_for(8000, || main.eval("window.__t.update.some(s => s.state === 'ready' && s.launch)") == json!(true));
    let launch = main.eval("JSON.stringify((window.__t.update.find(s => s.launch) || {}).launch)");
    let staged = user_data.join("updates").join("MIDI-Studio-3.1.0-Setup.exe");
    let file = staged.to_string_lossy().replace('\'', "''");
    let cmd_ok = launch.as_str().is_some_and(|l| {
        let v: Value = serde_json::from_str(l).unwrap_or(Value::Null);
        let script = v["args"][3].as_str().unwrap_or("");
        v["program"] == json!("powershell.exe")
            && v["args"].as_array().is_some_and(|a| a.len() == 4 && a[..3] == [json!("-NoProfile"), json!("-NonInteractive"), json!("-Command")])
            && (script == format!("Start-Process -FilePath '{file}'") || script == format!("Start-Process -FilePath '{file}' -Verb RunAs"))
    });
    let bytes_ok = std::fs::read(&staged).is_ok_and(|b| b == PAYLOAD);
    rep.result(ready && cmd_ok && bytes_ok, "U3 download + SHA-256 pass, stopped before launch with the exact command line",
        format!("states={} launch={launch} staged-bytes-match={bytes_ok}", states(&mut main)));
    let alive_after = app.try_wait().ok().flatten().is_none();
    rep.result(alive_after, "U3b the app did not quit (no-launch run)", String::new());

    *mode.lock().unwrap() = "bad".into();
    main.eval("window.__t.update = []");
    main.eval("studio.checkForUpdates().then(() => studio.applyUpdate())");
    let mismatch = wait_for(8000, || main.eval("window.__t.update.some(s => s.state === 'error' && /Checksum mismatch/.test(s.message))") == json!(true));
    let no_ready = main.eval("!window.__t.update.some(s => s.state === 'ready')") == json!(true);
    rep.result(mismatch && no_ready, "U4 checksum mismatch -> error, never ready, never launched",
        format!("states={} last={}", states(&mut main), main.eval("JSON.stringify(window.__t.update[window.__t.update.length-1])")));

    // ---- teardown: our Notepad, then the app ------------------------------------------------------
    let np_closed = close_window(np);
    rep.line(format!("closed our Notepad: {np_closed}"));
    let game_gone = wait_for(5000, || main.eval("window.__t.game.length > 0 && window.__t.game[window.__t.game.length-1].game === ''") == json!(true));
    rep.result(game_gone, "G2 gamewatch: Notepad closed -> game-active cleared", String::new());
    main.eval("studio.window.close()");
    let exited = wait_for(8000, || app.try_wait().ok().flatten().is_some());
    if !exited {
        let _ = app.kill();
        let _ = app.wait();
    }
    rep.line(format!("app exited by itself: {exited}"));
    let log = std::fs::read_to_string(&boot_log).unwrap_or_default();
    let clean = !log.contains("second-instance") && !log.contains("unavailable") && log.matches("--- boot ---").count() == 1;
    rep.result(clean, "Z1 run was not contaminated (no second-instance routed in, hotkeys were ours, one boot)", String::new());
    rep.line(format!("\nTOTAL: {} pass, {} fail", rep.pass, rep.fail));
    let _ = std::fs::write(&out, rep.lines.join("\n"));
    assert_eq!(rep.fail, 0, "see {}", out.display());
}
