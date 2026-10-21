use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::VkKeyScanW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_LOWER_IL_INJECTED, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::keys::Modifier;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HkKey {
    Mod(Modifier),
    Vk(u16),
}

fn named_vk(name: &str) -> Option<HkKey> {
    let vk: u16 = match name {
        "alt" | "alt_l" | "alt_r" | "alt_gr" => return Some(HkKey::Mod(Modifier::Alt)),
        "cmd" | "cmd_l" | "cmd_r" => return Some(HkKey::Mod(Modifier::Cmd)),
        "ctrl" | "ctrl_l" | "ctrl_r" => return Some(HkKey::Mod(Modifier::Ctrl)),
        "shift" | "shift_l" | "shift_r" => return Some(HkKey::Mod(Modifier::Shift)),
        "backspace" => 0x08,
        "tab" => 0x09,
        "enter" => 0x0D,
        "pause" => 0x13,
        "caps_lock" => 0x14,
        "esc" => 0x1B,
        "space" => 0x20,
        "page_up" => 0x21,
        "page_down" => 0x22,
        "end" => 0x23,
        "home" => 0x24,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "print_screen" => 0x2C,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "menu" => 0x5D,
        "num_lock" => 0x90,
        "scroll_lock" => 0x91,
        "media_volume_mute" => 0xAD,
        "media_volume_down" => 0xAE,
        "media_volume_up" => 0xAF,
        "media_next" => 0xB0,
        "media_previous" => 0xB1,
        "media_stop" => 0xB2,
        "media_play_pause" => 0xB3,
        f if f.len() >= 2 && f.starts_with('f') => match f[1..].parse::<u16>() {
            Ok(n) if (1..=24).contains(&n) => 0x6F + n,
            _ => return None,
        },
        _ => return None,
    };
    Some(HkKey::Vk(vk))
}

fn char_vk(c: char) -> HkKey {
    let mut units = [0u16; 2];
    let enc = c.encode_utf16(&mut units);
    if enc.len() != 1 {
        return HkKey::Vk(0);
    }
    let res = unsafe { VkKeyScanW(units[0]) } as u16;
    HkKey::Vk(if res == 0xFFFF { 0 } else { res & 0xFF })
}

/// pynput's HotKey.parse: `<ctrl>+<alt>+h`, `<f6>`, `a`, `<65>`. Characters
/// match by the virtual key the layout types them with, which is the physical
/// key pynput compares after lowercasing.
pub fn parse_combo(combo: &str) -> Result<Vec<HkKey>, String> {
    let chars: Vec<char> = combo.chars().collect();
    let mut raw = Vec::new();
    let mut start = 0;
    for (i, c) in chars.iter().enumerate() {
        if *c == '+' && i != start {
            raw.push(chars[start..i].iter().collect::<String>());
            start = i + 1;
        }
    }
    if start == chars.len() {
        return Err(combo.to_string());
    }
    raw.push(chars[start..].iter().collect::<String>());

    let mut keys = Vec::new();
    for s in &raw {
        let n = s.chars().count();
        let key = if n == 1 {
            char_vk(s.chars().next().unwrap().to_lowercase().next().unwrap())
        } else if n > 2 && s.starts_with('<') && s.ends_with('>') {
            let p = s[1..s.len() - 1].to_lowercase();
            match named_vk(&p) {
                Some(k) => k,
                None => match p.parse::<u16>() {
                    Ok(vk) => HkKey::Vk(vk),
                    Err(_) => return Err(s.clone()),
                },
            }
        } else {
            return Err(s.clone());
        };
        keys.push(key);
    }
    if keys.iter().collect::<std::collections::HashSet<_>>().len() != keys.len() {
        return Err(combo.to_string());
    }
    Ok(keys)
}

fn canonical(vk: u32) -> HkKey {
    match vk {
        0x10 | 0xA0 | 0xA1 => HkKey::Mod(Modifier::Shift),
        0x11 | 0xA2 | 0xA3 => HkKey::Mod(Modifier::Ctrl),
        0x12 | 0xA4 | 0xA5 => HkKey::Mod(Modifier::Alt),
        0x5B | 0x5C => HkKey::Mod(Modifier::Cmd),
        v => HkKey::Vk(v as u16),
    }
}

/// pynput HotKey semantics: fires once when the last of its keys goes down
/// while the rest are held; keys outside the combination are ignored, and
/// auto-repeat never re-fires.
pub struct Combo {
    pub name: String,
    keys: Vec<HkKey>,
    down: Vec<bool>,
}

impl Combo {
    pub fn new(name: &str, keys: Vec<HkKey>) -> Self {
        let n = keys.len();
        Combo { name: name.to_string(), keys, down: vec![false; n] }
    }

    pub fn press(&mut self, key: HkKey) -> bool {
        match self.keys.iter().position(|k| *k == key) {
            Some(i) if !self.down[i] => {
                self.down[i] = true;
                self.down.iter().all(|d| *d)
            }
            _ => false,
        }
    }

    pub fn release(&mut self, key: HkKey) {
        if let Some(i) = self.keys.iter().position(|k| *k == key) {
            self.down[i] = false;
        }
    }
}

type Fire = Arc<dyn Fn(&str) + Send + Sync>;

struct Active {
    combos: Vec<Combo>,
    fire: Fire,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let data = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = data.flags.0 & (LLKHF_INJECTED.0 | LLKHF_LOWER_IL_INJECTED.0) != 0;
        let msg = wparam.0 as u32;
        if !injected {
            let key = canonical(data.vkCode);
            let mut fired: Vec<String> = Vec::new();
            let mut fire: Option<Fire> = None;
            if let Ok(mut guard) = ACTIVE.lock() {
                if let Some(active) = guard.as_mut() {
                    if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                        for c in active.combos.iter_mut() {
                            if c.press(key) {
                                fired.push(c.name.clone());
                            }
                        }
                    } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                        for c in active.combos.iter_mut() {
                            c.release(key);
                        }
                    }
                    if !fired.is_empty() {
                        fire = Some(active.fire.clone());
                    }
                }
            }
            if let Some(f) = fire {
                for name in &fired {
                    f(name);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// The GlobalHotKeys equivalent: a WH_KEYBOARD_LL hook on its own message
/// loop thread. Never suppresses a key and ignores injected ones, as pynput.
pub struct HotkeyListener {
    thread_id: u32,
    handle: Option<JoinHandle<()>>,
}

impl HotkeyListener {
    pub fn start(combos: Vec<Combo>, fire: Fire) -> Result<HotkeyListener, String> {
        *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Active { combos, fire });
        let (tx, rx) = mpsc::channel::<Result<u32, String>>();
        let handle = std::thread::Builder::new()
            .name("hotkeys".into())
            .spawn(move || unsafe {
                let mut msg = MSG::default();
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let module = GetModuleHandleW(PCWSTR::null()).ok().map(|m| m.into());
                let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0) {
                    Ok(h) => h,
                    Err(e) => {
                        let _ = tx.send(Err(e.message()));
                        return;
                    }
                };
                let _ = tx.send(Ok(GetCurrentThreadId()));
                while GetMessageW(&mut msg, None, 0, 0).0 > 0 {}
                let _ = UnhookWindowsHookEx(hook);
            })
            .map_err(|e| e.to_string())?;
        match rx.recv() {
            Ok(Ok(thread_id)) => Ok(HotkeyListener { thread_id, handle: Some(handle) }),
            Ok(Err(e)) => {
                let _ = handle.join();
                ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).take();
                Err(e)
            }
            Err(_) => Err("hotkey thread died".into()),
        }
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            let _ = h.join();
            ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }
}

impl Drop for HotkeyListener {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pynput_syntax() {
        assert_eq!(parse_combo("<f6>").unwrap(), vec![HkKey::Vk(0x75)]);
        assert_eq!(parse_combo("<ctrl>+<alt>+h").unwrap()[..2], [HkKey::Mod(Modifier::Ctrl), HkKey::Mod(Modifier::Alt)]);
        assert_eq!(parse_combo("<shift>+<65>").unwrap(), vec![HkKey::Mod(Modifier::Shift), HkKey::Vk(65)]);
        assert_eq!(parse_combo("<page_up>").unwrap(), vec![HkKey::Vk(0x21)]);
        assert_eq!(parse_combo("<ctrl>++").unwrap().len(), 2);
        assert!(parse_combo("<nope>").is_err());
        assert!(parse_combo("<ctrl>+").is_err());
        assert!(parse_combo("<ctrl>+<ctrl>").is_err());
        assert!(parse_combo("ab").is_err());
    }

    #[test]
    fn combo_fires_once_on_last_key() {
        let mut c = Combo::new("play", vec![HkKey::Mod(Modifier::Ctrl), HkKey::Vk(0x75)]);
        assert!(!c.press(HkKey::Mod(Modifier::Ctrl)));
        assert!(!c.press(HkKey::Mod(Modifier::Shift)), "keys outside the combo are ignored");
        assert!(c.press(HkKey::Vk(0x75)));
        assert!(!c.press(HkKey::Vk(0x75)), "auto-repeat does not re-fire");
        c.release(HkKey::Vk(0x75));
        assert!(c.press(HkKey::Vk(0x75)), "re-pressing while the modifier is held fires again");
        c.release(HkKey::Mod(Modifier::Ctrl));
        c.release(HkKey::Vk(0x75));
        assert!(!c.press(HkKey::Vk(0x75)));
    }
}
