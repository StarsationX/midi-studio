// paths.rs: the parts of electron/paths.js the Tauri host needs so far.
//
// userData stays Electron's folder (%APPDATA%\midi-studio), so the settings
// file, the mappings folder and everything else the user already has carry
// straight over. MIDI_STUDIO_USER_DATA points it somewhere else, which is how
// a test run keeps its hands off the real profile.
use std::path::{Path, PathBuf};

use serde_json::Value;

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn home_dir() -> PathBuf {
    env_path("USERPROFILE").or_else(|| env_path("HOME")).unwrap_or_else(|| PathBuf::from("."))
}

pub fn user_data_dir() -> PathBuf {
    if let Some(p) = env_path("MIDI_STUDIO_USER_DATA") {
        return p;
    }
    env_path("APPDATA").unwrap_or_else(|| home_dir().join("AppData").join("Roaming")).join("midi-studio")
}

pub fn settings_file() -> PathBuf {
    user_data_dir().join("midi-studio-settings.json")
}

pub fn boot_log() -> PathBuf {
    env_path("MIDI_STUDIO_BOOT_LOG").unwrap_or_else(|| std::env::temp_dir().join("midi-studio-boot.log"))
}

/// python-engine/: the player's bundled mapping presets live there. A packaged
/// build ships it next to the exe; a dev build finds the repo's copy by walking
/// up from target/<profile>/.
pub fn engine_dir() -> PathBuf {
    if let Some(p) = env_path("MIDI_STUDIO_ENGINE_DIR") {
        return p;
    }
    let exe = std::env::current_exe().unwrap_or_default();
    for dir in exe.ancestors().skip(1) {
        for c in [dir.join("python-engine"), dir.join("resources").join("python-engine")] {
            if c.join("mappings").is_dir() {
                return c;
            }
        }
    }
    exe.parent().map(|d| d.join("python-engine")).unwrap_or_else(|| PathBuf::from("python-engine"))
}

pub fn user_mappings_dir() -> PathBuf {
    user_data_dir().join("mappings")
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn preset_version(v: &Value) -> f64 {
    match v.get("x_app_preset_version") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// paths.js shouldRefreshPreset: a newer bundled preset replaces the user's
/// copy, and so does the one known-bad legacy drums map.
fn should_refresh_preset(src: &Path, dst: &Path) -> bool {
    if !dst.exists() {
        return true;
    }
    let (Some(s), Some(d)) = (read_json(src), read_json(dst)) else { return false };
    let (sv, dv) = (preset_version(&s), preset_version(&d));
    if sv != 0.0 && sv > dv {
        return true;
    }
    let is_drums = dst.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("drums.json"));
    let legacy_name = d.get("name").and_then(Value::as_str).is_some_and(|n| n.to_lowercase().starts_with("drums"));
    let legacy_kick = d.get("note_to_key").and_then(|m| m.get("36")).and_then(Value::as_str) == Some("c");
    is_drums && dv == 0.0 && legacy_name && legacy_kick
}

/// paths.js ensureUserMappings: create the folder and seed it with the bundled
/// presets, never overwriting a user's own edits.
pub fn ensure_user_mappings() -> PathBuf {
    let dir = user_mappings_dir();
    let _ = std::fs::create_dir_all(&dir);
    let src = engine_dir().join("mappings");
    if let Ok(rd) = std::fs::read_dir(&src) {
        for e in rd.flatten() {
            let name = e.file_name();
            if !name.to_string_lossy().to_lowercase().ends_with(".json") {
                continue;
            }
            let dst = dir.join(&name);
            if should_refresh_preset(&e.path(), &dst) {
                let _ = std::fs::copy(e.path(), &dst);
            }
        }
    }
    dir
}

/// main.js programOutputDir: the Forge output setting, else Documents\MIDI Studio.
pub fn program_output_dir(forge_output_dir: &str) -> PathBuf {
    let set = forge_output_dir.trim();
    if !set.is_empty() {
        return PathBuf::from(set);
    }
    home_dir().join("Documents").join("MIDI Studio")
}

pub fn is_midi(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mid") || e.eq_ignore_ascii_case("midi"))
}

/// main.js listMidis: .mid/.midi in a folder and one level of subfolders,
/// capped at 1000, sorted case-insensitively.
pub fn list_midis(dir: &Path) -> Vec<String> {
    fn walk(d: &Path, depth: u32, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            if out.len() >= 1000 {
                return;
            }
            let Ok(ft) = e.file_type() else { continue };
            let full = e.path();
            if ft.is_dir() {
                if depth < 1 {
                    walk(&full, depth + 1, out);
                }
            } else if ft.is_file() && is_midi(&full) {
                out.push(full.to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    if dir.as_os_str().is_empty() || !dir.exists() {
        return out;
    }
    walk(dir, 0, &mut out);
    out.sort_by_key(|p| p.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_midis_one_level_deep_sorted() {
        let root = std::env::temp_dir().join(format!("midi-studio-list-test-{}", std::process::id()));
        let deep = root.join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();
        for p in [root.join("Zed.mid"), root.join("alpha.MIDI"), root.join("b").join("mid.mid"), deep.join("too-deep.mid"), root.join("x.txt")] {
            std::fs::write(p, b"").unwrap();
        }
        let got: Vec<String> = list_midis(&root)
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(got, vec!["alpha.MIDI", "mid.mid", "Zed.mid"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn output_dir_defaults_to_documents() {
        assert!(program_output_dir("").ends_with(Path::new("Documents").join("MIDI Studio")));
        assert_eq!(program_output_dir(" D:\\out "), PathBuf::from("D:\\out"));
    }
}
