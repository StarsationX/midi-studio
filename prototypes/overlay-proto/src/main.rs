// Go/no-go prototype: can Tauri 2 host MIDI Studio's always-on-top "Perch"
// overlay without ever taking focus from the game?
//
//   overlay-proto.exe --selftest <out.txt>   automated focus / z-order / opacity test
//   overlay-proto.exe --idle <secs>          main + overlay shown, idle (memory probe)
//   overlay-proto.exe --fsdummy [topmost]    borderless-fullscreen stand-in for a game
use std::{
    ffi::c_void,
    io::Write,
    process::{Child, Command},
    sync::atomic::{AtomicIsize, Ordering},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        CreateSolidBrush, GetDC, GetMonitorInfoW, GetPixel, MonitorFromWindow, ReleaseDC,
        MONITORINFO, MONITOR_DEFAULTTONEAREST,
    },
    System::{
        LibraryLoader::GetModuleHandleW,
        Threading::{
            AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
            PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
    UI::{
        Accessibility::{SetWinEventHook, HWINEVENTHOOK},
        HiDpi::*,
        WindowsAndMessaging::*,
    },
};

type H = isize;
fn hw(h: H) -> HWND {
    h as HWND
}
fn sleep(ms: u64) {
    thread::sleep(Duration::from_millis(ms))
}

// ---------------------------------------------------------------- Win32 helpers

fn exstyle(h: H) -> u32 {
    unsafe { GetWindowLongPtrW(hw(h), GWL_EXSTYLE) as u32 }
}
fn set_exstyle(h: H, add: u32, remove: u32) {
    let v = (exstyle(h) | add) & !remove;
    unsafe {
        SetWindowLongPtrW(hw(h), GWL_EXSTYLE, v as isize);
        SetWindowPos(
            hw(h),
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}
fn rect(h: H) -> RECT {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(hw(h), &mut r) };
    r
}
fn fg() -> H {
    unsafe { GetForegroundWindow() as H }
}
fn visible(h: H) -> bool {
    unsafe { IsWindowVisible(hw(h)) != 0 }
}

// The calls that make "show without activating" work. SW_SHOWNOACTIVATE shows
// it, then HWND_TOPMOST + SWP_NOACTIVATE puts it at the top of the topmost band
// (Electron's setAlwaysOnTop(true, 'screen-saver') is this same call on Windows).
fn show_noact(h: H) {
    unsafe {
        ShowWindow(hw(h), SW_SHOWNOACTIVATE);
        raise_topmost(h);
    }
}
fn raise_topmost(h: H) {
    unsafe {
        SetWindowPos(
            hw(h),
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}
fn hide_raw(h: H) {
    unsafe { ShowWindow(hw(h), SW_HIDE) };
}
fn move_raw(h: H, x: i32, y: i32, w: i32, ht: i32) {
    unsafe {
        SetWindowPos(hw(h), std::ptr::null_mut(), x, y, w, ht, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}
// Per-window opacity: WS_EX_LAYERED + SetLayeredWindowAttributes(LWA_ALPHA).
fn set_alpha(h: H, a: f64) {
    set_exstyle(h, WS_EX_LAYERED, 0);
    unsafe { SetLayeredWindowAttributes(hw(h), 0, (a * 255.0).round() as u8, LWA_ALPHA) };
}
fn layered_alpha(h: H) -> Option<u8> {
    let (mut key, mut a, mut flags) = (0u32, 0u8, 0u32);
    let ok = unsafe { GetLayeredWindowAttributes(hw(h), &mut key, &mut a, &mut flags) } != 0;
    (ok && flags & LWA_ALPHA != 0).then_some(a)
}

// Is `a` above `b` in the global z-order? Walks top-level windows top-down.
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
fn root_at(x: i32, y: i32) -> H {
    unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) as H }
}
fn pixel(x: i32, y: i32) -> (u8, u8, u8) {
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        let c = GetPixel(dc, x, y);
        ReleaseDC(std::ptr::null_mut(), dc);
        (c as u8, (c >> 8) as u8, (c >> 16) as u8)
    }
}

// Visible, unowned top-level windows as (hwnd, pid, class).
unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> i32 {
    let v = &mut *(lp as *mut Vec<(H, u32, String)>);
    if IsWindowVisible(h) != 0 && GetWindow(h, GW_OWNER).is_null() {
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        let mut buf = [0u16; 128];
        let n = GetClassNameW(h, buf.as_mut_ptr(), 128);
        v.push((h as H, pid, String::from_utf16_lossy(&buf[..n.max(0) as usize])));
    }
    1
}
fn top_windows() -> Vec<(H, u32, String)> {
    let mut v: Vec<(H, u32, String)> = vec![];
    unsafe { EnumWindows(Some(enum_cb), &mut v as *mut _ as LPARAM) };
    v
}
fn image_name(pid: u32) -> String {
    unsafe {
        let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if p.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 520];
        let mut n = buf.len() as u32;
        QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut n);
        CloseHandle(p);
        String::from_utf16_lossy(&buf[..n as usize]).to_lowercase()
    }
}
fn find_window(pid: u32, class: &str, timeout_ms: u64) -> Option<H> {
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(timeout_ms) {
        if let Some(w) = top_windows().into_iter().find(|w| w.1 == pid && w.2 == class) {
            return Some(w.0);
        }
        sleep(50);
    }
    None
}
fn notepad_windows() -> Vec<(H, u32)> {
    top_windows()
        .into_iter()
        .filter(|w| image_name(w.1).ends_with("\\notepad.exe"))
        .map(|w| (w.0, w.1))
        .collect()
}
// Win11's System32\notepad.exe is a stub that hands off to the packaged
// Notepad, so the window belongs to a different pid than the one spawned.
// Take only a Notepad window that did not exist before the launch.
fn launch_notepad(timeout_ms: u64) -> Result<(H, u32), String> {
    let before = notepad_windows();
    if !before.is_empty() {
        return Err(format!("a Notepad is already open ({} windows); not touching it", before.len()));
    }
    let mut stub = Command::new("notepad.exe").spawn().map_err(|e| e.to_string())?;
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(timeout_ms) {
        if let Some(w) = notepad_windows().into_iter().next() {
            let _ = stub.try_wait();
            return Ok(w);
        }
        sleep(50);
    }
    Err("notepad window never appeared".into())
}
fn close_window(h: H) -> bool {
    unsafe { PostMessageW(hw(h), WM_CLOSE, 0, 0) };
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(4) {
        if unsafe { IsWindow(hw(h)) } == 0 {
            return true;
        }
        sleep(50);
    }
    false
}

// Hand the foreground to a window we launched. No input is synthesized: plain
// SetForegroundWindow first, then the AttachThreadInput route if the
// foreground lock refused it.
fn bring_fg(h: H) -> &'static str {
    unsafe {
        if fg() == h {
            return "already foreground";
        }
        SetForegroundWindow(hw(h));
        sleep(150);
        if fg() == h {
            return "SetForegroundWindow";
        }
        let cur = fg();
        let fg_thread = GetWindowThreadProcessId(hw(cur), std::ptr::null_mut());
        let me = GetCurrentThreadId();
        AttachThreadInput(me, fg_thread, 1);
        BringWindowToTop(hw(h));
        SetForegroundWindow(hw(h));
        AttachThreadInput(me, fg_thread, 0);
        sleep(200);
        if fg() == h {
            "AttachThreadInput+SetForegroundWindow"
        } else {
            "FAILED"
        }
    }
}

fn close_child(mut child: Child, h: Option<H>) {
    if let Some(h) = h {
        unsafe { PostMessageW(hw(h), WM_CLOSE, 0, 0) };
    }
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        sleep(50);
    }
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------- the report

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
}

#[derive(Default)]
struct Expect {
    visible: Option<bool>,
    above: Option<H>,
    wfp_overlay: Option<bool>, // hit-test at the red bar lands on the overlay?
    alpha: Option<f64>,        // measured alpha of the red bar
}

struct Ctx {
    overlay: H,
    main: H,
    scale: f64,
}

fn name_of(c: &Ctx, h: H, target: H) -> String {
    if h == target {
        "target".into()
    } else if h == c.overlay {
        "OVERLAY".into()
    } else if h == c.main {
        "MAIN".into()
    } else {
        format!("other:{h:#x}")
    }
}

// Alpha of the red bar from the pixel actually composited on screen, against
// a reference pixel of whatever is underneath.
fn measure_alpha(px: (u8, u8, u8), refp: (u8, u8, u8)) -> Option<f64> {
    let red = (255.0, 0.0, 0.0);
    let p = (px.0 as f64, px.1 as f64, px.2 as f64);
    let r = (refp.0 as f64, refp.1 as f64, refp.2 as f64);
    let ch = [(p.0, r.0, red.0), (p.1, r.1, red.1), (p.2, r.2, red.2)];
    let (pp, rr, ss) = ch
        .iter()
        .copied()
        .max_by(|a, b| (a.2 - a.1).abs().partial_cmp(&(b.2 - b.1).abs()).unwrap())?;
    if (ss - rr).abs() < 60.0 {
        return None;
    }
    Some(((pp - rr) / (ss - rr)).clamp(-0.2, 1.2))
}

fn check(rep: &mut Report, c: &Ctx, step: &str, target: H, e: Expect) {
    sleep(350);
    let f = fg();
    let r = rect(c.overlay);
    let vis = visible(c.overlay);
    let ex = exstyle(c.overlay);
    let bar = (r.left + (r.right - r.left) / 2, r.top + (20.0 * c.scale) as i32);
    let clear = (r.left + (r.right - r.left) / 2, r.bottom - (10.0 * c.scale) as i32);
    let outside = (r.left - (30.0 * c.scale) as i32, r.top + (20.0 * c.scale) as i32);
    let px = pixel(bar.0, bar.1);
    let pclear = pixel(clear.0, clear.1);
    let pref = pixel(outside.0, outside.1);
    let alpha = measure_alpha(px, pref);
    let wfp = root_at(bar.0, bar.1);
    let ab = e.above.map(|b| above(c.overlay, b));

    let mut ok = f == target;
    let mut why = vec![];
    if f != target {
        why.push(format!("FOREGROUND STOLEN -> {}", name_of(c, f, target)));
    }
    if let Some(v) = e.visible {
        if v != vis {
            ok = false;
            why.push(format!("visible={vis} expected {v}"));
        }
    }
    if let (Some(true), Some(false)) = (e.above.map(|_| true), ab) {
        ok = false;
        why.push("overlay NOT above target".into());
    }
    if let Some(w) = e.wfp_overlay {
        if (wfp == c.overlay) != w {
            ok = false;
            why.push(format!("hit-test landed on {}", name_of(c, wfp, target)));
        }
    }
    if let Some(a) = e.alpha {
        match alpha {
            Some(m) if (m - a).abs() <= 0.08 => {}
            _ => {
                ok = false;
                why.push(format!("alpha {alpha:?} expected {a}"));
            }
        }
    }
    if ok {
        rep.pass += 1
    } else {
        rep.fail += 1
    }
    rep.line(format!(
        "[{}] {step}\n       fg={} vis={vis} above={} topmost={} noact={} transp={} layered={} toolwin={} lwa={:?}\n       rect=({},{} {}x{}) bar_px={px:?} under_px={pref:?} clear_px={pclear:?} alpha={} hit={} {}",
        if ok { "PASS" } else { "FAIL" },
        name_of(c, f, target),
        ab.map(|b| b.to_string()).unwrap_or("-".into()),
        ex & WS_EX_TOPMOST != 0,
        ex & WS_EX_NOACTIVATE != 0,
        ex & WS_EX_TRANSPARENT != 0,
        ex & WS_EX_LAYERED != 0,
        ex & WS_EX_TOOLWINDOW != 0,
        layered_alpha(c.overlay),
        r.left,
        r.top,
        r.right - r.left,
        r.bottom - r.top,
        alpha.map(|a| format!("{a:.2}")).unwrap_or("n/a".into()),
        name_of(c, wfp, target),
        if why.is_empty() { String::new() } else { format!("\n       !! {}", why.join("; ")) },
    ));
}

// ---------------------------------------------------------------- self-test

fn selftest(app: AppHandle, main_w: WebviewWindow, ov: WebviewWindow, out: String) {
    let mut rep = Report { lines: vec![], pass: 0, fail: 0 };
    sleep(2500); // let both webviews finish loading
    let overlay = ov.hwnd().unwrap().0 as H;
    let main = main_w.hwnd().unwrap().0 as H;
    let mon = ov.primary_monitor().unwrap().unwrap();
    let scale = mon.scale_factor();
    let c = Ctx { overlay, main, scale };

    // --- DPI
    let wa = mon.work_area();
    let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    unsafe { GetMonitorInfoW(MonitorFromWindow(hw(overlay), MONITOR_DEFAULTTONEAREST), &mut mi) };
    let dpi = unsafe { GetDpiForWindow(hw(overlay)) };
    let ctx = unsafe { GetThreadDpiAwarenessContext() };
    let pm2 = unsafe { AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } != 0;
    rep.line(format!(
        "DPI: tauri scale_factor={scale} GetDpiForWindow={dpi} ({:.2}x) per-monitor-v2={pm2}\n     tauri work_area (physical) = ({},{} {}x{})  Win32 rcWork = ({},{} {}x{})",
        dpi as f64 / 96.0,
        wa.position.x, wa.position.y, wa.size.width, wa.size.height,
        mi.rcWork.left, mi.rcWork.top, mi.rcWork.right - mi.rcWork.left, mi.rcWork.bottom - mi.rcWork.top,
    ));
    // Electron's _placement() in DIP: top-right of the work area, 24 DIP in.
    let dip_wa = (
        wa.position.x as f64 / scale,
        wa.position.y as f64 / scale,
        wa.size.width as f64 / scale,
        wa.size.height as f64 / scale,
    );
    let (dw, dh) = (460.0, 300.0);
    let (dx, dy) = (dip_wa.0 + dip_wa.2 - dw - 24.0, dip_wa.1 + 24.0);
    ov.set_size(LogicalSize::new(dw, dh)).unwrap();
    ov.set_position(LogicalPosition::new(dx, dy)).unwrap();
    sleep(300);
    let r = rect(overlay);
    let exp = (
        (dx * scale).round() as i32,
        (dy * scale).round() as i32,
        (dw * scale).round() as i32,
        (dh * scale).round() as i32,
    );
    let got = (r.left, r.top, r.right - r.left, r.bottom - r.top);
    let dpi_ok = (exp.0 - got.0).abs() <= 1
        && (exp.1 - got.1).abs() <= 1
        && (exp.2 - got.2).abs() <= 1
        && (exp.3 - got.3).abs() <= 1;
    if dpi_ok { rep.pass += 1 } else { rep.fail += 1 }
    rep.line(format!(
        "[{}] DPI placement: Electron DIP rect ({dx:.0},{dy:.0} {dw}x{dh}) via LogicalPosition/LogicalSize -> GetWindowRect {got:?}, expected physical {exp:?}",
        if dpi_ok { "PASS" } else { "FAIL" }
    ));

    // --- Phase A: notepad in the foreground
    let (np_h, np_pid) = match launch_notepad(8000) {
        Ok(v) => v,
        Err(e) => {
            rep.line(format!("FAIL: {e}"));
            finish(&app, &rep, &out);
            return;
        }
    };
    // Put notepad's white edit area under the overlay so the pixel probe and
    // hit-test have something known underneath.
    let o = rect(overlay);
    move_raw(np_h, o.left - 400, o.top - 150, (o.right - o.left) + 600, (o.bottom - o.top) + 450);
    let how = bring_fg(np_h);
    rep.line(format!("\nPhase A: notepad pid={np_pid} hwnd={np_h:#x}, foreground via {how}; fg is notepad: {}", fg() == np_h));
    let t = np_h;

    show_noact(overlay);
    check(&mut rep, &c, "A1 raw show: ShowWindow(SW_SHOWNOACTIVATE)+SetWindowPos(HWND_TOPMOST,SWP_NOACTIVATE)", t,
        Expect { visible: Some(true), above: Some(t), wfp_overlay: Some(true), alpha: Some(1.0) });
    ov.set_ignore_cursor_events(false).unwrap();
    check(&mut rep, &c, "A1b desync probe: tauri set_ignore_cursor_events(false) right after a raw show (tao thinks hidden)", t,
        Expect::default());
    hide_raw(overlay);
    check(&mut rep, &c, "A2 raw hide: ShowWindow(SW_HIDE)", t, Expect { visible: Some(false), ..Default::default() });
    ov.show().unwrap();
    check(&mut rep, &c, "A3 tauri show() (tao SW_SHOW on a focusable(false)=WS_EX_NOACTIVATE window)", t,
        Expect { visible: Some(true), above: Some(t), wfp_overlay: Some(true), alpha: Some(1.0) });
    ov.hide().unwrap();
    check(&mut rep, &c, "A4 tauri hide()", t, Expect { visible: Some(false), ..Default::default() });
    ov.show().unwrap();
    check(&mut rep, &c, "A5 tauri show() again", t, Expect { visible: Some(true), above: Some(t), ..Default::default() });
    let o = rect(overlay);
    ov.set_position(PhysicalPosition::new(o.left - 60, o.top + 40)).unwrap();
    check(&mut rep, &c, "A6 tauri set_position (physical)", t, Expect { visible: Some(true), above: Some(t), ..Default::default() });
    ov.set_size(PhysicalSize::new((o.right - o.left + 80) as u32, (o.bottom - o.top + 40) as u32)).unwrap();
    check(&mut rep, &c, "A7 tauri set_size (physical)", t, Expect { visible: Some(true), above: Some(t), ..Default::default() });
    let o = rect(overlay);
    move_raw(overlay, o.left + 30, o.top - 20, o.right - o.left - 40, o.bottom - o.top - 20);
    check(&mut rep, &c, "A8 raw SetWindowPos move+resize (SWP_NOZORDER|SWP_NOACTIVATE)", t,
        Expect { visible: Some(true), above: Some(t), wfp_overlay: Some(true), alpha: Some(1.0) });
    ov.set_always_on_top(true).unwrap();
    check(&mut rep, &c, "A9 tauri set_always_on_top(true) re-assert", t, Expect { visible: Some(true), above: Some(t), ..Default::default() });
    set_alpha(overlay, 0.5);
    check(&mut rep, &c, "A10 opacity 0.5 via WS_EX_LAYERED+SetLayeredWindowAttributes(LWA_ALPHA)", t,
        Expect { visible: Some(true), above: Some(t), alpha: Some(0.5), ..Default::default() });
    set_alpha(overlay, 0.92);
    check(&mut rep, &c, "A11 opacity 0.92 (Perch default) via LWA_ALPHA", t,
        Expect { visible: Some(true), alpha: Some(0.92), ..Default::default() });
    ov.set_ignore_cursor_events(true).unwrap();
    check(&mut rep, &c, "A12 click-through ON via tauri set_ignore_cursor_events(true)", t,
        Expect { visible: Some(true), above: Some(t), wfp_overlay: Some(false), ..Default::default() });
    ov.set_ignore_cursor_events(false).unwrap();
    check(&mut rep, &c, "A13 click-through OFF via tauri set_ignore_cursor_events(false)", t,
        Expect { visible: Some(true), wfp_overlay: Some(true), ..Default::default() });
    // Opacity again, now re-applied after tao rewrote the exstyle.
    set_alpha(overlay, 0.6);
    ov.set_ignore_cursor_events(true).unwrap();
    check(&mut rep, &c, "A14 LWA alpha 0.6 then tauri click-through ON (does tao's exstyle rewrite keep the alpha?)", t,
        Expect { visible: Some(true), wfp_overlay: Some(false), alpha: Some(0.6), ..Default::default() });
    ov.set_ignore_cursor_events(false).unwrap();
    check(&mut rep, &c, "A15 tauri click-through OFF after LWA alpha (tao drops WS_EX_LAYERED?)", t,
        Expect { visible: Some(true), wfp_overlay: Some(true), ..Default::default() });
    ov.eval("document.documentElement.style.opacity='0.5'").unwrap();
    check(&mut rep, &c, "A16 opacity 0.5 via CSS (documentElement.style.opacity) on the transparent webview", t,
        Expect { visible: Some(true), alpha: Some(0.5), ..Default::default() });
    ov.eval("document.documentElement.style.opacity='1'").unwrap();
    check(&mut rep, &c, "A17 CSS opacity back to 1", t, Expect { visible: Some(true), alpha: Some(1.0), ..Default::default() });
    set_exstyle(overlay, WS_EX_TRANSPARENT | WS_EX_LAYERED, 0);
    unsafe { SetLayeredWindowAttributes(hw(overlay), 0, 255, LWA_ALPHA) };
    check(&mut rep, &c, "A18 click-through ON via raw WS_EX_TRANSPARENT|WS_EX_LAYERED (+LWA 255)", t,
        Expect { visible: Some(true), wfp_overlay: Some(false), alpha: Some(1.0), ..Default::default() });
    set_exstyle(overlay, 0, WS_EX_TRANSPARENT | WS_EX_LAYERED);
    check(&mut rep, &c, "A19 click-through OFF via raw exstyle", t,
        Expect { visible: Some(true), wfp_overlay: Some(true), alpha: Some(1.0), ..Default::default() });
    set_exstyle(overlay, WS_EX_TOOLWINDOW, 0);
    check(&mut rep, &c, "A20 raw add WS_EX_TOOLWINDOW", t, Expect { visible: Some(true), ..Default::default() });
    ov.set_ignore_cursor_events(true).unwrap();
    ov.set_ignore_cursor_events(false).unwrap();
    check(&mut rep, &c, "A21 after a tauri flag change: did WS_EX_TOOLWINDOW survive? (see toolwin=)", t,
        Expect { visible: Some(true), ..Default::default() });
    for i in 0..6 {
        let o = rect(overlay);
        ov.set_position(PhysicalPosition::new(o.left + if i % 2 == 0 { 25 } else { -25 }, o.top)).unwrap();
        ov.hide().unwrap();
        sleep(80);
        ov.show().unwrap();
        set_alpha(overlay, if i % 2 == 0 { 0.4 } else { 1.0 });
    }
    check(&mut rep, &c, "A22 burst: 6x (move, hide, show, opacity) back-to-back", t,
        Expect { visible: Some(true), above: Some(t), alpha: Some(1.0), ..Default::default() });
    let _ = main_w.set_title("main window retitled while notepad is foreground");
    check(&mut rep, &c, "A23 main-window op (set_title) does not pull focus either", t, Expect::default());
    let closed = close_window(np_h);
    rep.line(format!("Phase A: WM_CLOSE to notepad pid={np_pid}: closed={closed}"));

    // --- Phase B/C: borderless fullscreen stand-in in the foreground
    for topmost in [false, true] {
        ov.hide().unwrap();
        set_alpha(overlay, 1.0);
        let exe = std::env::current_exe().unwrap();
        let mut cmd = Command::new(exe);
        cmd.arg("--fsdummy");
        if topmost {
            cmd.arg("topmost");
        }
        let child = cmd.spawn().unwrap();
        let pid = child.id();
        let Some(d) = find_window(pid, "ProtoFsDummy", 6000) else {
            rep.line("FAIL: fullscreen dummy window never appeared".into());
            close_child(child, None);
            continue;
        };
        let how = bring_fg(d);
        let ph = if topmost { "C" } else { "B" };
        let dr = rect(d);
        rep.line(format!(
            "\nPhase {ph}: borderless fullscreen WS_POPUP{} pid={pid} rect=({},{} {}x{}), foreground via {how}; fg is dummy: {}",
            if topmost { "+WS_EX_TOPMOST (game that is itself topmost)" } else { "" },
            dr.left, dr.top, dr.right - dr.left, dr.bottom - dr.top, fg() == d
        ));
        ov.show().unwrap();
        check(&mut rep, &c, &format!("{ph}1 tauri show() over fullscreen window"), d,
            Expect { visible: Some(true), above: Some(d), wfp_overlay: Some(true), alpha: Some(1.0) });
        raise_topmost(overlay);
        check(&mut rep, &c, &format!("{ph}2 re-assert SetWindowPos(HWND_TOPMOST,SWP_NOACTIVATE)"), d,
            Expect { visible: Some(true), above: Some(d), wfp_overlay: Some(true), alpha: Some(1.0) });
        hide_raw(overlay);
        show_noact(overlay);
        check(&mut rep, &c, &format!("{ph}3 raw hide + SW_SHOWNOACTIVATE + HWND_TOPMOST"), d,
            Expect { visible: Some(true), above: Some(d), alpha: Some(1.0), ..Default::default() });
        let o = rect(overlay);
        ov.set_position(PhysicalPosition::new(o.left - 100, o.top + 100)).unwrap();
        ov.set_size(PhysicalSize::new((o.right - o.left) as u32, (o.bottom - o.top - 60) as u32)).unwrap();
        check(&mut rep, &c, &format!("{ph}4 tauri move + resize"), d, Expect { visible: Some(true), above: Some(d), ..Default::default() });
        set_alpha(overlay, 0.5);
        check(&mut rep, &c, &format!("{ph}5 LWA opacity 0.5 over fullscreen"), d,
            Expect { visible: Some(true), above: Some(d), alpha: Some(0.5), ..Default::default() });
        ov.set_ignore_cursor_events(true).unwrap();
        check(&mut rep, &c, &format!("{ph}6 tauri click-through ON"), d,
            Expect { visible: Some(true), above: Some(d), wfp_overlay: Some(false), ..Default::default() });
        ov.set_ignore_cursor_events(false).unwrap();
        check(&mut rep, &c, &format!("{ph}7 tauri click-through OFF"), d,
            Expect { visible: Some(true), above: Some(d), wfp_overlay: Some(true), ..Default::default() });
        // The game re-activating itself (alt-tab back, a cutscene) re-sorts
        // the topmost band; the overlay has to be able to climb back.
        bring_fg(main);
        let back = bring_fg(d);
        check(&mut rep, &c, &format!("{ph}8 game re-activated (via {back}); is overlay still above?"), d,
            Expect { visible: Some(true), ..Default::default() });
        ov.set_always_on_top(true).unwrap();
        check(&mut rep, &c, &format!("{ph}8b after re-activation: tauri set_always_on_top(true) (no-op if tao thinks it is already set?)"), d,
            Expect { visible: Some(true), ..Default::default() });
        raise_topmost(overlay);
        check(&mut rep, &c, &format!("{ph}9 after re-activation: re-assert HWND_TOPMOST|SWP_NOACTIVATE"), d,
            Expect { visible: Some(true), above: Some(d), ..Default::default() });
        if topmost {
            start_topmost_keeper(overlay);
            sleep(200);
            bring_fg(main);
            let back = bring_fg(d);
            check(&mut rep, &c, &format!("{ph}10 keeper on (SetWinEventHook EVENT_SYSTEM_FOREGROUND -> re-assert), game re-activated via {back}"), d,
                Expect { visible: Some(true), above: Some(d), wfp_overlay: Some(true), ..Default::default() });
        }
        close_child(child, Some(d));
        rep.line(format!("Phase {ph}: closed dummy pid={pid}"));
    }

    rep.line(format!("\nTOTAL: {} pass, {} fail", rep.pass, rep.fail));
    finish(&app, &rep, &out);
}

// A topmost game that re-activates lands above the overlay in the topmost
// band. Re-assert HWND_TOPMOST (no activation) whenever the foreground changes.
static KEEP: AtomicIsize = AtomicIsize::new(0);
unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    let h = KEEP.load(Ordering::Relaxed);
    if h != 0 && visible(h) {
        raise_topmost(h);
    }
}
fn start_topmost_keeper(overlay: H) {
    KEEP.store(overlay, Ordering::Relaxed);
    thread::spawn(|| unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(),
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            DispatchMessageW(&msg);
        }
    });
}

fn finish(app: &AppHandle, rep: &Report, out: &str) {
    if let Ok(mut f) = std::fs::File::create(out) {
        let _ = f.write_all(rep.lines.join("\n").as_bytes());
    }
    app.exit(0);
}

// ---------------------------------------------------------------- fullscreen dummy

unsafe extern "system" fn dummy_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if m == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }
    DefWindowProcW(h, m, w, l)
}

fn fsdummy(topmost: bool) {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let inst = GetModuleHandleW(std::ptr::null());
        let class: Vec<u16> = "ProtoFsDummy\0".encode_utf16().collect();
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(dummy_proc);
        wc.hInstance = inst;
        wc.hbrBackground = CreateSolidBrush(0x00FF0000); // COLORREF is 0x00BBGGRR: pure blue
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
        let (w, h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let title: Vec<u16> = "fullscreen dummy\0".encode_utf16().collect();
        CreateWindowExW(
            if topmost { WS_EX_TOPMOST } else { 0 },
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP | WS_VISIBLE,
            0,
            0,
            w,
            h,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            inst,
            std::ptr::null::<c_void>(),
        );
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ---------------------------------------------------------------- app

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("--fsdummy") {
        fsdummy(args.get(2).map(|s| s.as_str()) == Some("topmost"));
        return;
    }
    let mode = args.get(1).cloned().unwrap_or_default();
    let arg2 = args.get(2).cloned().unwrap_or_default();

    tauri::Builder::default()
        .setup(move |app| {
            let main_w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("MIDI Studio proto")
                .inner_size(720.0, 480.0)
                .build()?;
            // Perch: same option set as electron/overlay.js.
            let ov = WebviewWindowBuilder::new(app, "perch", WebviewUrl::App("overlay.html".into()))
                .title("Perch")
                .inner_size(460.0, 300.0)
                .min_inner_size(260.0, 170.0)
                .position(200.0, 200.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .resizable(true)
                .focused(false)
                .focusable(false) // tao: WS_EX_NOACTIVATE, kept across its exstyle rewrites
                .visible(false)
                .build()?;
            let handle = app.handle().clone();
            match mode.as_str() {
                "--selftest" => {
                    let out = if arg2.is_empty() { "selftest.txt".to_string() } else { arg2.clone() };
                    thread::spawn(move || selftest(handle, main_w, ov, out));
                }
                "--idle" => {
                    let secs: u64 = arg2.parse().unwrap_or(30);
                    let h = ov.hwnd().unwrap().0 as H;
                    thread::spawn(move || {
                        sleep(1500);
                        ov.show().unwrap();
                        raise_topmost(h);
                        set_alpha(h, 0.92);
                        start_topmost_keeper(h);
                        sleep(secs * 1000);
                        handle.exit(0);
                    });
                }
                _ => {
                    let h = ov.hwnd().unwrap().0 as H;
                    thread::spawn(move || {
                        sleep(1500);
                        ov.show().unwrap();
                        raise_topmost(h);
                        start_topmost_keeper(h);
                    });
                }
            }
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
