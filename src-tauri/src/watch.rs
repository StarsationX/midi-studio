// watch.rs: the small host jobs that watch something.
//
//   * gamewatch (electron/gamewatch.js): is a game running? MIDI Studio is a
//     companion app, and while Roblox or Minecraft is up it must get out of
//     the way. One Toolhelp32 snapshot every 20 seconds, names only: no
//     process is opened, and nothing is ever done to one.
//   * step-aside: playback is live or a game is up, so Forge should give way
//     (main.js refreshForgeBackground). forge/mod.rs subscribes to it.
//   * panel-failed: a panel iframe that did not load. The bridge spots it
//     (Tauri has no did-fail-load for subframes) and the host logs and pushes
//     it, as main.js did.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

use crate::{blog, Host};

/// Order decides which name wins when two are up.
pub const GAMES: [&str; 3] = ["RobloxPlayerBeta.exe", "RobloxStudioBeta.exe", "javaw.exe"];
const POLL: Duration = Duration::from_secs(20);
/// Nothing needs to know about a running game in the first seconds.
const FIRST: Duration = Duration::from_secs(8);

/// Every running process's image name, lowercased. Read-only: the snapshot
/// lists names and ids, and no process handle is ever opened.
pub fn process_names() -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            out.push(String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase());
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

/// The first watched name that is running, exact and case-insensitive (a
/// game name can never match as a substring of some unrelated process).
pub fn detect<S: AsRef<str>>(running: &[String], watched: &[S]) -> String {
    watched
        .iter()
        .map(AsRef::as_ref)
        .find(|g| running.iter().any(|r| r.eq_ignore_ascii_case(g)))
        .unwrap_or("")
        .to_string()
}

fn env_ms(name: &str) -> Option<Duration> {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_millis)
}

// ---- step-aside ---------------------------------------------------------------

pub type StepHook = Box<dyn Fn(&Value) + Send + Sync>;

#[derive(Default)]
struct Step {
    playback: bool,
    game: String,
    last: Option<(bool, bool)>,
}

#[derive(Default)]
pub struct Watch {
    step: Mutex<Step>,
    hooks: Mutex<Vec<StepHook>>,
}

fn watch(app: &AppHandle) -> Option<Arc<Watch>> {
    app.try_state::<Arc<Watch>>().map(|s| s.inner().clone())
}

/// Where Forge hooks in. `f` gets
/// {"background": bool, "pause": bool, "playback": bool, "game": name, "rule": whenGaming}
/// every time either flag changes: background means drop to idle priority and
/// smaller batches; pause means hand the GPU back entirely until the game closes.
pub fn on_step_aside(app: &AppHandle, f: StepHook) {
    if let Some(w) = watch(app) {
        w.hooks.lock().unwrap_or_else(|e| e.into_inner()).push(f);
    }
}

fn when_gaming(app: &AppHandle) -> String {
    let h = app.state::<Arc<Host>>();
    crate::ipc::performance(&h.settings.get("performance"), &h.settings.get("ui"))["whenGaming"].as_str().unwrap_or("limit").to_string()
}

/// main.js refreshForgeBackground: playback always counts (a late keypress is
/// simply wrong); a game only counts if the user left that setting on.
pub fn step_flags(playback: bool, game: &str, rule: &str) -> (bool, bool) {
    let up = !game.is_empty();
    (playback || (up && rule != "nothing"), up && rule == "pause")
}

fn refresh(app: &AppHandle) {
    let Some(w) = watch(app) else { return };
    let rule = when_gaming(app);
    let event = {
        let mut st = w.step.lock().unwrap_or_else(|e| e.into_inner());
        let flags = step_flags(st.playback, &st.game, &rule);
        if st.last == Some(flags) {
            return;
        }
        st.last = Some(flags);
        json!({"background": flags.0, "pause": flags.1, "playback": st.playback, "game": st.game, "rule": rule})
    };
    blog(&format!("forge:step-aside {event}"));
    for f in w.hooks.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        f(&event);
    }
}

/// From the engine-event stream: playback_started / playback_done / error.
pub fn on_engine_event(app: &AppHandle, channel: &str, v: &Value) {
    if channel != "engine-event" {
        return;
    }
    let on = match v.get("event").and_then(Value::as_str) {
        Some("playback_started") => true,
        Some("playback_done" | "error") => false,
        _ => return,
    };
    let Some(w) = watch(app) else { return };
    {
        let mut st = w.step.lock().unwrap_or_else(|e| e.into_inner());
        if st.playback == on {
            return;
        }
        st.playback = on;
    }
    refresh(app);
}

fn game_changed(app: &AppHandle, game: &str) {
    if let Some(w) = watch(app) {
        w.step.lock().unwrap_or_else(|e| e.into_inner()).game = game.to_string();
    }
    blog(&format!("gamewatch: {}", if game.is_empty() { "no game" } else { game }));
    refresh(app);
    Host::push(app, "game-active", json!({"game": game, "rule": when_gaming(app)}));
}

// ---- panel-failed ---------------------------------------------------------------

fn panel_failed(app: &AppHandle, p: &Value) {
    let text = |k: &str| match p.get(k) {
        Some(Value::String(s)) => s.chars().take(500).collect(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    };
    let (url, desc) = (text("url"), text("desc"));
    let code = p.get("code").cloned().filter(Value::is_number).unwrap_or(json!(-6));
    blog(&format!("panel did-fail-load {code} {desc} {url}"));
    // The shell covers that panel with its own empty state.
    Host::push(app, "panel-failed", json!({"url": url, "code": code, "desc": desc}));
}

pub fn dispatch(app: &AppHandle, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match channel {
        "app:panelFailed" => {
            panel_failed(app, args.first().unwrap_or(&Value::Null));
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}

/// Test runs can shorten the cadence (MIDI_STUDIO_GAMEWATCH_FIRST_MS /
/// _POLL_MS) and watch harmless names INSTEAD of the games
/// (MIDI_STUDIO_GAMEWATCH_NAMES, comma-separated), so detection can be proven
/// without a game, and a game the user has open cannot skew the run.
pub fn init(app: &AppHandle) {
    app.manage(Arc::new(Watch::default()));
    let first = env_ms("MIDI_STUDIO_GAMEWATCH_FIRST_MS").unwrap_or(FIRST);
    let poll = env_ms("MIDI_STUDIO_GAMEWATCH_POLL_MS").unwrap_or(POLL).max(Duration::from_millis(250));
    let names: Vec<String> = std::env::var("MIDI_STUDIO_GAMEWATCH_NAMES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let app = app.clone();
    let _ = std::thread::Builder::new().name("gamewatch".into()).spawn(move || {
        let watched: Vec<String> = if names.is_empty() { GAMES.iter().map(|g| g.to_string()).collect() } else { names };
        blog(&format!("gamewatch: watching {}", watched.join(", ")));
        std::thread::sleep(first);
        let mut active = String::new();
        loop {
            let found = detect(&process_names(), &watched);
            if found != active {
                active = found;
                game_changed(&app, &active);
            }
            std::thread::sleep(poll);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_is_exact_and_ordered() {
        let run = |v: &[&str]| v.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
        assert_eq!(detect(&run(&["explorer.exe", "javaw.exe", "robloxplayerbeta.exe"]), &GAMES), "RobloxPlayerBeta.exe");
        assert_eq!(detect(&run(&["javaw.exe"]), &GAMES), "javaw.exe");
        assert_eq!(detect(&run(&["notjavaw.exe", "robloxplayerbeta.exe.bak"]), &GAMES), "");
        assert_eq!(detect(&run(&["RobloxStudioBeta.exe"]), &GAMES), "RobloxStudioBeta.exe");
    }

    #[test]
    fn snapshot_sees_this_process() {
        let me = std::env::current_exe().unwrap();
        let name = me.file_name().unwrap().to_string_lossy().to_lowercase();
        assert!(process_names().contains(&name), "{name} not in the snapshot");
    }

    #[test]
    fn step_aside_rules() {
        assert_eq!(step_flags(false, "", "limit"), (false, false));
        assert_eq!(step_flags(true, "", "nothing"), (true, false));
        assert_eq!(step_flags(false, "javaw.exe", "nothing"), (false, false));
        assert_eq!(step_flags(false, "javaw.exe", "limit"), (true, false));
        assert_eq!(step_flags(false, "javaw.exe", "pause"), (true, true));
    }
}
