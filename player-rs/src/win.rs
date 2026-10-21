use std::collections::HashMap;
use std::io::Write;
use std::sync::OnceLock;

use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{
    AttachThreadInput, CreateWaitableTimerExW, GetCurrentThread, GetCurrentThreadId, GetThreadPriority,
    SetThreadPriority, SetWaitableTimer, WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE,
    THREAD_PRIORITY, THREAD_PRIORITY_HIGHEST, TIMER_ALL_ACCESS,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, SetFocus, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_CONTROL, VK_LSHIFT,
    VK_LWIN, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

use crate::keys::{Key, KeyAction, KeySink, Modifier};

fn qpc_freq() -> f64 {
    static FREQ: OnceLock<f64> = OnceLock::new();
    *FREQ.get_or_init(|| {
        let mut f = 0i64;
        unsafe {
            let _ = QueryPerformanceFrequency(&mut f);
        }
        f.max(1) as f64
    })
}

/// time.perf_counter(): QPC seconds, the same clock Python reports.
pub fn perf() -> f64 {
    let mut c = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
    }
    c as f64 / qpc_freq()
}

pub fn spin_until(target: f64) {
    while perf() < target {
        std::hint::spin_loop();
    }
}

/// timeBeginPeriod(1) for the guard's lifetime.
pub struct HiResTimer(());

impl HiResTimer {
    pub fn begin() -> Self {
        unsafe {
            timeBeginPeriod(1);
        }
        HiResTimer(())
    }
}

impl Drop for HiResTimer {
    fn drop(&mut self) {
        unsafe {
            timeEndPeriod(1);
        }
    }
}

/// Raises the calling thread to THREAD_PRIORITY_HIGHEST, restored on drop.
pub struct ThreadPriority(i32);

impl ThreadPriority {
    pub fn highest() -> Self {
        unsafe {
            let prev = GetThreadPriority(GetCurrentThread());
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
            ThreadPriority(prev)
        }
    }
}

impl Drop for ThreadPriority {
    fn drop(&mut self) {
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(self.0));
        }
    }
}

/// Sleeps on a high-resolution waitable timer (sub-millisecond wakeups on
/// Windows 10 1803+), so the spin tail only has to cover ~1 ms. Falls back to
/// thread::sleep with the 3 ms spin the Python engine used.
pub struct Sleeper(Option<HANDLE>);

impl Sleeper {
    pub fn new() -> Self {
        let h = unsafe {
            CreateWaitableTimerExW(None, PCWSTR::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0)
        };
        Sleeper(h.ok())
    }

    pub fn spin_threshold(&self) -> f64 {
        if self.0.is_some() { 0.001 } else { 0.003 }
    }

    pub fn sleep(&self, secs: f64) {
        if secs <= 0.0 {
            return;
        }
        if let Some(h) = self.0 {
            let due = -((secs * 1e7) as i64).max(1);
            unsafe {
                if SetWaitableTimer(h, &due, 0, None, None, false).is_ok() {
                    WaitForSingleObject(h, INFINITE);
                    return;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs_f64(secs));
    }
}

impl Default for Sleeper {
    fn default() -> Self {
        Sleeper::new()
    }
}

impl Drop for Sleeper {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            unsafe {
                let _ = CloseHandle(h);
            }
        }
    }
}

fn keybd(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn vk_input(vk: u16, extended: bool, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    keybd(vk, scan, flags)
}

/// What pynput sends for the same key: a modifier by its virtual key; a
/// character by the virtual key the layout types it with unshifted, else as a
/// KEYEVENTF_UNICODE packet.
fn key_input(key: Key, up: bool) -> INPUT {
    match key {
        Key::Mod(m) => {
            let vk = match m {
                Modifier::Shift => VK_LSHIFT,
                Modifier::Ctrl => VK_CONTROL,
                Modifier::Alt => VK_MENU,
                Modifier::Cmd => VK_LWIN,
            };
            vk_input(vk.0, false, up)
        }
        Key::Vk(vk) => vk_input(vk, false, up),
        Key::Char(c) => {
            let mut units = [0u16; 2];
            let single = c.encode_utf16(&mut units).len() == 1;
            let res: u16 = if single { unsafe { VkKeyScanW(units[0]) as u16 } } else { 0xFFFF };
            if single && (res >> 8) & 0xFF == 0 {
                vk_input(res & 0xFF, false, up)
            } else {
                let mut flags = KEYEVENTF_UNICODE;
                if up {
                    flags |= KEYEVENTF_KEYUP;
                }
                keybd(0, units[0], flags)
            }
        }
    }
}

/// The real thing: each batch is one SendInput call.
#[derive(Default)]
pub struct SendInputSink {
    buf: Vec<INPUT>,
}

impl SendInputSink {
    pub fn new() -> Self {
        SendInputSink { buf: Vec::with_capacity(64) }
    }
}

unsafe impl Send for SendInputSink {}

impl KeySink for SendInputSink {
    fn send(&mut self, actions: &[KeyAction]) {
        self.buf.clear();
        for a in actions {
            self.buf.push(match *a {
                KeyAction::Down(k) => key_input(k, false),
                KeyAction::Up(k) => key_input(k, true),
            });
        }
        if !self.buf.is_empty() {
            unsafe {
                SendInput(&self.buf, std::mem::size_of::<INPUT>() as i32);
            }
        }
    }
}

/// --dry-run: every batch is written to stderr instead of being typed.
pub struct LogSink {
    epoch: f64,
}

impl LogSink {
    pub fn new() -> Self {
        LogSink { epoch: perf() }
    }
}

impl Default for LogSink {
    fn default() -> Self {
        LogSink::new()
    }
}

impl KeySink for LogSink {
    fn send(&mut self, actions: &[KeyAction]) {
        let mut line = format!("keys +{:.6}", perf() - self.epoch);
        for a in actions {
            match a {
                KeyAction::Down(k) => line.push_str(&format!(" down:{k}")),
                KeyAction::Up(k) => line.push_str(&format!(" up:{k}")),
            }
        }
        line.push('\n');
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }
}

#[derive(Clone, Debug)]
pub struct Window {
    pub hwnd: isize,
    pub title: String,
    pub pid: u32,
    pub process: String,
}

fn hwnd(h: isize) -> HWND {
    HWND(h as *mut _)
}

fn process_names() -> HashMap<u32, String> {
    let mut out = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut pe = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut pe).is_ok();
        while ok {
            let len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
            out.insert(pe.th32ProcessID, String::from_utf16_lossy(&pe.szExeFile[..len]));
            ok = Process32NextW(snap, &mut pe).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

unsafe extern "system" fn collect_hwnd(h: HWND, lparam: LPARAM) -> BOOL {
    let v = &mut *(lparam.0 as *mut Vec<isize>);
    v.push(h.0 as isize);
    BOOL(1)
}

/// Visible top-level windows with a title, as midi_player.list_windows_win.
pub fn list_windows() -> Vec<Window> {
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_hwnd), LPARAM(&mut handles as *mut _ as isize));
    }
    let names = process_names();
    let mut out = Vec::new();
    for h in handles {
        unsafe {
            if !IsWindowVisible(hwnd(h)).as_bool() {
                continue;
            }
            let len = GetWindowTextLengthW(hwnd(h));
            if len <= 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd(h), &mut buf);
            if n <= 0 {
                continue;
            }
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd(h), Some(&mut pid));
            out.push(Window { hwnd: h, title, pid, process: names.get(&pid).cloned().unwrap_or_default() });
        }
    }
    out
}

pub fn focused_hwnd() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

pub fn window_alive(h: isize) -> bool {
    unsafe { IsWindow(Some(hwnd(h))).as_bool() }
}

/// SetForegroundWindow with the thread-input attach trick, and the Alt tap
/// fallback Windows needs when the caller does not own the foreground.
pub fn focus_window(target: isize) -> bool {
    let h = hwnd(target);
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let current = GetCurrentThreadId();
        let fg = GetForegroundWindow();
        let fg_tid = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let target_tid = GetWindowThreadProcessId(h, None);
        let mut attached = Vec::new();
        for tid in [fg_tid, target_tid] {
            if tid != 0 && tid != current && !attached.contains(&tid) && AttachThreadInput(current, tid, true).as_bool() {
                attached.push(tid);
            }
        }
        if BringWindowToTop(h).is_ok() && SetForegroundWindow(h).as_bool() {
            let _ = SetFocus(Some(h));
        } else {
            let mut kb = SendInputSink::new();
            kb.send(&[KeyAction::Down(Key::Mod(Modifier::Alt)), KeyAction::Up(Key::Mod(Modifier::Alt))]);
            let _ = SetForegroundWindow(h);
        }
        for tid in attached {
            let _ = AttachThreadInput(GetCurrentThreadId(), tid, false);
        }
    }
    focused_hwnd() == target
}
