// fpaths.rs: the Forge half of electron/paths.js, plus the installer's
// registry value and the child environment.
//
// The heavy interpreter (torch, CUDA, the models) lives in the forge env,
// %LOCALAPPDATA%\midi-studio\forge-env by default, and is never the player's.
// The host has no Python of its own at all: everything Forge runs, runs under
// this one.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
use winreg::RegKey;

use crate::paths::{engine_dir, home_dir, user_data_dir};

pub const FOLDER_NAME: &str = "MIDI Studio Forge";
const REG_KEY: &str = r"Software\StarsationX\MIDI Studio";
const REG_VALUE: &str = "ForgeStorageDir";

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// settings.forgePaths(): the three overrides, '' meaning "not set".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ForgePaths {
    pub forge_env_dir: String,
    pub forge_python_path: String,
    pub models_dir: String,
}

impl ForgePaths {
    pub fn from_settings(paths: &Value) -> ForgePaths {
        let s = |k: &str| paths.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        ForgePaths { forge_env_dir: s("forgeEnvDir"), forge_python_path: s("forgePythonPath"), models_dir: s("modelsDir") }
    }

    pub fn dir(d: &Path) -> ForgePaths {
        ForgePaths { forge_env_dir: d.to_string_lossy().into_owned(), ..Default::default() }
    }
}

pub fn local_app_data() -> PathBuf {
    env_path("LOCALAPPDATA").unwrap_or_else(|| home_dir().join("AppData").join("Local"))
}

/// A cargo build runs out of <crate>\target\<profile>\; anything else is an
/// installed copy (paths.js isPackaged).
fn is_packaged() -> bool {
    let exe = std::env::current_exe().unwrap_or_default();
    !exe.ancestors().any(|d| d.file_name().is_some_and(|n| n.eq_ignore_ascii_case("target")))
}

fn drive_of(p: &Path) -> String {
    p.components().next().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Always writable: the user's own profile.
pub fn legacy_default_forge_env_dir() -> PathBuf {
    local_app_data().join("midi-studio").join("forge-env")
}

/// paths.js defaultForgeEnvDir: installed off C:, the ~10 GB engine goes on
/// the drive the app is on, not on the C: the user was avoiding.
pub fn default_forge_env_dir() -> PathBuf {
    let local = legacy_default_forge_env_dir();
    if !is_packaged() {
        return local;
    }
    let Ok(exe) = std::env::current_exe() else { return local };
    let (app_drive, local_drive) = (drive_of(&exe), drive_of(&local));
    if !app_drive.is_empty() && !local_drive.is_empty() && app_drive != local_drive {
        return PathBuf::from(format!("{}\\", app_drive.to_uppercase())).join(FOLDER_NAME);
    }
    local
}

pub fn forge_env_dir(p: &ForgePaths) -> PathBuf {
    if !p.forge_env_dir.is_empty() {
        return PathBuf::from(&p.forge_env_dir);
    }
    default_forge_env_dir()
}

pub fn legacy_forge_env_dir() -> PathBuf {
    local_app_data().join("midi-forge")
}

fn py_in_dir(dir: &Path) -> Option<PathBuf> {
    if dir.as_os_str().is_empty() {
        return None;
    }
    [dir.join("python").join("python.exe"), dir.join("python.exe"), dir.join("Scripts").join("python.exe")]
        .into_iter()
        .find(|c| c.exists())
}

/// THE heavy interpreter. None = not provisioned.
pub fn forge_env_python(p: &ForgePaths) -> Option<PathBuf> {
    if !p.forge_python_path.is_empty() && Path::new(&p.forge_python_path).exists() {
        return Some(PathBuf::from(&p.forge_python_path));
    }
    if !p.forge_env_dir.is_empty() {
        return py_in_dir(&forge_env_dir(p));
    }
    py_in_dir(&forge_env_dir(p)).or_else(|| py_in_dir(&legacy_forge_env_dir()))
}

/// Interpreter present, torch installed AND the .ready marker setup writes
/// last, so a half-built env re-provisions instead of failing every job.
pub fn forge_env_ready(p: &ForgePaths) -> bool {
    let Some(py) = forge_env_python(p) else { return false };
    let Some(dir) = py.parent() else { return false };
    let roots: Vec<&Path> = [Some(dir), dir.parent()].into_iter().flatten().collect();
    let torch = roots.iter().any(|r| r.join("Lib").join("site-packages").join("torch").exists());
    let ready = roots.iter().any(|r| r.join(".ready").exists());
    torch && ready
}

fn logical_drives() -> Vec<char> {
    let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| (b'A' + i) as char).collect()
}

/// Every place a provisioned env could be sitting, best guess first: the
/// configured one, the defaults, the old midi-forge, then "MIDI Studio Forge"
/// at the root of every drive (the installer's folder), C: last.
pub fn candidate_forge_env_dirs(p: &ForgePaths) -> Vec<PathBuf> {
    candidates_with(p, &logical_drives())
}

fn candidates_with(p: &ForgePaths, present: &[char]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |d: PathBuf| {
        if !d.as_os_str().is_empty() && !out.iter().any(|x| x.to_string_lossy().eq_ignore_ascii_case(&d.to_string_lossy())) {
            out.push(d);
        }
    };
    if !p.forge_env_dir.is_empty() {
        add(PathBuf::from(&p.forge_env_dir));
    }
    add(default_forge_env_dir());
    add(legacy_default_forge_env_dir());
    add(legacy_forge_env_dir());
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZC".chars() {
        if present.contains(&letter) {
            add(PathBuf::from(format!("{letter}:\\")).join(FOLDER_NAME));
        }
    }
    add(PathBuf::from(r"C:\ProgramData").join("midi-studio").join("forge-env"));
    out
}

pub fn find_ready_forge_env(p: &ForgePaths) -> Option<PathBuf> {
    candidate_forge_env_dirs(p).into_iter().find(|d| forge_env_ready(&ForgePaths::dir(d)))
}

pub fn models_dir(p: &ForgePaths) -> PathBuf {
    if !p.models_dir.is_empty() {
        return PathBuf::from(&p.models_dir);
    }
    let in_forge = forge_env_dir(p).join("models");
    let legacy = legacy_forge_env_dir().join("models");
    let fallback = if legacy.is_dir() { legacy } else { engine_dir().join("models") };
    // Import may have created the default models folder for the first time.
    // That must not mask an older model library used by the other modes.
    if fallback.is_dir() && in_forge == legacy_default_forge_env_dir().join("models")
        && std::fs::read_dir(&in_forge).is_ok_and(|mut rd| rd.all(|e|
            e.is_ok_and(|entry| entry.file_name().eq_ignore_ascii_case("bs_rofo_sw"))))
        && !in_forge.join("bs_rofo_sw/BS-Rofo-SW-Fixed.ckpt").exists() {
        return fallback;
    }
    if in_forge.exists() {
        return in_forge;
    }
    fallback
}

/// The Rust Forge engine: FORGE_RS_EXE, next to the app's exe (the
/// installer's externalBin), then a dev build in the repo's
/// forge-rs\target\release. None = this build has no Rust engine.
pub fn forge_rs_exe() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    c.extend(env_path("FORGE_RS_EXE"));
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        c.push(d.join("forge-rs.exe"));
    }
    if let Some(repo) = engine_dir().parent() {
        c.push(repo.join("forge-rs").join("target").join("release").join("forge-rs.exe"));
    }
    c.into_iter().find(|p| p.is_file())
}

/// The NVIDIA adapter's name from the display class key, which is what CUDA
/// device 0 is on a one-GPU machine. Read for the label only: nothing loads.
pub fn nvidia_gpu_name() -> Option<String> {
    let class = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}", KEY_READ)
        .ok()?;
    class.enum_keys().flatten().find_map(|sub| {
        let k = class.open_subkey_with_flags(&sub, KEY_READ).ok()?;
        let name = k.get_value::<String, _>("DriverDesc").ok()?.trim().to_string();
        let vendor = k.get_value::<String, _>("ProviderName").unwrap_or_default();
        (!name.is_empty() && (vendor.contains("NVIDIA") || name.contains("NVIDIA"))).then_some(name)
    })
}

/// Pids of running Forge jobs, the fallback for a host that died without its
/// job objects closing (they always close, but a pid file costs nothing).
pub fn forge_jobs_file() -> PathBuf {
    user_data_dir().join("forge-jobs.json")
}

/// The provisioner's full output, for a user to share after a failure.
/// MIDI_STUDIO_FORGE_SETUP_LOG moves it, so a test cannot overwrite the real one.
pub fn forge_setup_log() -> PathBuf {
    env_path("MIDI_STUDIO_FORGE_SETUP_LOG").unwrap_or_else(|| local_app_data().join("midi-studio").join("forge-setup.log"))
}

// ---- the child environment ---------------------------------------------------

/// A process environment with Windows' case-insensitive names: the first
/// spelling of a name is kept, later writes replace its value.
#[derive(Clone, Debug, Default)]
pub struct EnvMap(Vec<(String, String)>);

impl EnvMap {
    pub fn from_process() -> EnvMap {
        let mut m = EnvMap::default();
        for (k, v) in std::env::vars_os() {
            m.set(&k.to_string_lossy(), &v.to_string_lossy());
        }
        m
    }

    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, k: &str, v: &str) {
        match self.0.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(k)) {
            Some(e) => e.1 = v.to_string(),
            None => self.0.push((k.to_string(), v.to_string())),
        }
    }

    /// `env.K = env.K || v`: an empty value counts as unset.
    pub fn set_default(&mut self, k: &str, v: &str) {
        if self.get(k).is_none_or(str::is_empty) {
            self.set(k, v);
        }
    }

    pub fn apply(&self, cmd: &mut Command) {
        cmd.env_clear();
        cmd.envs(self.0.iter().map(|(k, v)| (k, v)));
    }
}

/// paths.js forgeChildEnv: the process env plus where the models, the engine
/// scripts and the env itself are, and a PYTHONPATH that finds the scripts'
/// sibling imports.
pub fn forge_child_env(p: &ForgePaths) -> EnvMap {
    forge_child_env_from(EnvMap::from_process(), p)
}

pub(super) fn shared_models_dir() -> Option<&'static Path> {
    // The all-users installer's copy lives outside both uninstall trees.
    // Always use the native 64-bit Program Files, never an x86 registry view.
    static DIR: std::sync::LazyLock<Option<PathBuf>> = std::sync::LazyLock::new(|| {
        let dir: String = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows\CurrentVersion", KEY_READ | KEY_WOW64_64KEY).ok()?
            .get_value("ProgramFilesDir").ok()?;
        let test = std::env::current_exe().ok().as_deref().and_then(Path::file_stem)
            .is_some_and(|name| name.eq_ignore_ascii_case("MIDI Studio Test"));
        Some(PathBuf::from(dir).join(if test { "MIDI Studio Test Shared Models" } else { "MIDI Studio Shared Models" }))
    });
    DIR.as_deref()
}

pub fn forge_child_env_from(mut env: EnvMap, p: &ForgePaths) -> EnvMap {
    let engine = engine_dir().to_string_lossy().into_owned();
    env.set("MIDI_STUDIO_MODELS_DIR", &models_dir(p).to_string_lossy());
    env.set("MIDI_STUDIO_ENGINE_DIR", &engine);
    // An imported or installer-preserved copy survives changes to the Forge
    // storage setting. Do not redirect any of the other models to this folder.
    let medley = super::medley::destination();
    if medley.is_file() {
        env.set("FORGE_RS_ROFO_MODEL", &medley.to_string_lossy());
    } else if env.get("FORGE_RS_ROFO_MODEL").is_none_or(str::is_empty) {
        if let Some(shared) = shared_models_dir().map(|d| d.join("bs_rofo_sw").join(super::medley::ONNX)).filter(|p| p.is_file()) {
            env.set("FORGE_RS_ROFO_MODEL", &shared.to_string_lossy());
        }
    }
    let root = forge_env_dir(p);
    env.set("MIDI_STUDIO_FORGE_ENV_DIR", &root.to_string_lossy());
    // A headless upgrade can write only the protected machine cache. Use it
    // directly on first launch; do not require another setup or download.
    let local_native = root.join("native");
    if let Some(native) = Some(local_native).filter(|d| d.is_dir())
        .or_else(|| shared_models_dir().map(|d| d.join("native")).filter(|d| d.is_dir())) {
        let assets = native.join("assets");
        // Do not replace MIDI_STUDIO_MODELS_DIR: it may point to the user's
        // existing separator, and the Python engine also consumes that setting.
        env.set("FORGE_RS_NATIVE_ASSETS", &assets.to_string_lossy());
        let pitch = assets.join("basic_pitch/nmp.onnx");
        if pitch.is_file() { env.set_default("FORGE_RS_BP_MODEL", &pitch.to_string_lossy()); }
        let ort = native.join("ort-gpu");
        let dll = ort.join("onnxruntime.dll");
        if dll.is_file() {
            env.set_default("ORT_DYLIB_PATH", &dll.to_string_lossy());
            env.set_default("FORGE_RS_ORT_GPU_DIR", &ort.to_string_lossy());
            if !p.forge_python_path.is_empty() {
                // A custom interpreter can be outside the native component
                // store. Its CUDA runtime is useful even without its Python.
                if let Some(dir) = Path::new(&p.forge_python_path).parent() {
                    for base in [Some(dir), dir.parent()].into_iter().flatten() {
                        let lib = base.join("Lib/site-packages/torch/lib");
                        if lib.is_dir() { env.set_default("FORGE_RS_CUDA_DIR", &lib.to_string_lossy()); break; }
                    }
                }
            }
        }
    }
    let pp = match env.get("PYTHONPATH").filter(|v| !v.is_empty()) {
        Some(old) => format!("{engine};{old}"),
        None => engine,
    };
    env.set("PYTHONPATH", &pp);
    env.set("PYTHONUNBUFFERED", "1");
    env.set("PYTHONIOENCODING", "utf-8");
    env
}

// ---- the installer's choice ----------------------------------------------------

/// MIDI_STUDIO_REG_KEY points the read and the sync at another HKCU key, so a
/// test never touches the real one.
fn reg_key() -> String {
    std::env::var("MIDI_STUDIO_REG_KEY").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| REG_KEY.to_string())
}

fn read_value(root: &RegKey, key: &str, flags: u32) -> String {
    root.open_subkey_with_flags(key, KEY_READ | flags)
        .and_then(|k| k.get_value::<String, _>(REG_VALUE))
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

/// The first non-empty ForgeStorageDir among `roots`, in order.
pub fn query_in(roots: &[(RegKey, String, u32)]) -> String {
    roots.iter().map(|(root, key, flags)| read_value(root, key, *flags)).find(|v| !v.is_empty()).unwrap_or_default()
}

/// What the installer recorded. HKCU first; HKLM is the installer's mirror
/// for an elevated run that saw the admin's HKCU (and its 32-bit view for an
/// installer that wrote without SetRegView 64). main.js's version of this
/// called an execFile it never imported, so it always answered ''.
pub fn query_forge_storage_dir() -> String {
    let key = reg_key();
    if key != REG_KEY {
        return query_in(&[(RegKey::predef(HKEY_CURRENT_USER), key, 0)]);
    }
    query_in(&[
        (RegKey::predef(HKEY_CURRENT_USER), key.clone(), 0),
        (RegKey::predef(HKEY_LOCAL_MACHINE), key.clone(), 0),
        (RegKey::predef(HKEY_LOCAL_MACHINE), key, KEY_WOW64_32KEY),
    ])
}

/// main.js syncInstallerForgePath: the next install offers the folder in use.
/// Settings stay the source of truth if this fails.
pub fn sync_installer_forge_path(dir: &Path) -> bool {
    if dir.as_os_str().is_empty() {
        return false;
    }
    RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(reg_key())
        .and_then(|(k, _)| k.set_value(REG_VALUE, &dir.to_string_lossy().into_owned()))
        .is_ok()
}

// ---- disk ------------------------------------------------------------------------

/// Free space (GB, one decimal) on the drive holding `dir`.
pub fn free_gb(dir: &Path) -> Option<f64> {
    use std::os::windows::ffi::OsStrExt;
    let probe = if dir.exists() {
        dir.to_path_buf()
    } else {
        let abs = std::path::absolute(dir).ok()?;
        PathBuf::from(format!("{}\\", abs.components().next()?.as_os_str().to_string_lossy()))
    };
    let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut avail: u64 = 0;
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut())
    };
    (ok != 0).then(|| (avail as f64 / (1u64 << 30) as f64 * 10.0).round() / 10.0)
}

/// CUDA torch is ~15 GB with everything, the CPU build a fraction of it
/// (provision_forge.py MIN_FREE_GB_START*).
pub fn forge_need_gb() -> u32 {
    let sys = env_path("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    if sys.join("System32").join("nvcuda.dll").exists() { 15 } else { 6 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-forge-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn readiness_needs_python_torch_and_marker() {
        let d = scratch("ready");
        let p = ForgePaths::dir(&d);
        assert!(forge_env_python(&p).is_none());
        assert!(!forge_env_ready(&p));
        std::fs::create_dir_all(d.join("python").join("Lib").join("site-packages").join("torch")).unwrap();
        std::fs::write(d.join("python").join("python.exe"), b"").unwrap();
        assert_eq!(forge_env_python(&p), Some(d.join("python").join("python.exe")));
        assert!(!forge_env_ready(&p), "no .ready marker yet");
        std::fs::write(d.join(".ready"), b"1").unwrap();
        assert!(forge_env_ready(&p));
        // An explicit interpreter wins over the folder.
        let other = d.join("other.exe");
        std::fs::write(&other, b"").unwrap();
        let p2 = ForgePaths { forge_python_path: other.to_string_lossy().into(), ..p.clone() };
        assert_eq!(forge_env_python(&p2), Some(other));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn candidates_are_ordered_and_deduped() {
        let p = ForgePaths { forge_env_dir: r"E:\Mine".into(), ..Default::default() };
        let c = candidates_with(&p, &['C', 'D', 'E']);
        assert_eq!(c[0], PathBuf::from(r"E:\Mine"));
        let roots: Vec<String> = c.iter().map(|d| d.to_string_lossy().into_owned()).filter(|d| d.ends_with(FOLDER_NAME)).collect();
        assert_eq!(roots, vec![r"D:\MIDI Studio Forge", r"E:\MIDI Studio Forge", r"C:\MIDI Studio Forge"]);
        assert!(c.last().unwrap().ends_with(r"midi-studio\forge-env"));
        // The legacy default is the dev default here, so it appears once.
        let n = c.iter().filter(|d| **d == legacy_default_forge_env_dir()).count();
        assert_eq!(n, 1);
    }

    #[test]
    fn child_env_adds_paths_and_keeps_case() {
        let mut base = EnvMap::default();
        base.set("Path", r"C:\Windows");
        base.set("PYTHONPATH", r"X:\extra");
        let env = forge_child_env_from(base, &ForgePaths::dir(Path::new(r"Q:\env")));
        assert_eq!(env.get("PATH"), Some(r"C:\Windows"));
        assert_eq!(env.get("MIDI_STUDIO_FORGE_ENV_DIR"), Some(r"Q:\env"));
        assert_eq!(env.get("MIDI_STUDIO_MODELS_DIR").map(|m| m.ends_with("models")), Some(true));
        let pp = env.get("pythonpath").unwrap();
        assert!(pp.ends_with(r";X:\extra") && pp.starts_with(&*engine_dir().to_string_lossy()), "{pp}");
        assert_eq!(env.get("PYTHONUNBUFFERED"), Some("1"));
        assert_eq!(env.get("PYTHONIOENCODING"), Some("utf-8"));
        let mut e = EnvMap::default();
        e.set("OMP_NUM_THREADS", "");
        e.set_default("omp_num_threads", "3");
        assert_eq!(e.get("OMP_NUM_THREADS"), Some("3"));
        e.set_default("OMP_NUM_THREADS", "9");
        assert_eq!(e.get("OMP_NUM_THREADS"), Some("3"));
        assert_eq!(e.0.len(), 1);
    }

    #[test]
    fn native_pack_keeps_separate_custom_model_and_cuda_locations() {
        let d = scratch("native");
        let ort = d.join("native/ort-gpu");
        let assets = d.join("native/assets");
        let pitch = assets.join("basic_pitch/nmp.onnx");
        let torch = d.join("custom-python/Lib/site-packages/torch/lib");
        for dir in [ort.as_path(), pitch.parent().unwrap(), torch.as_path()] { std::fs::create_dir_all(dir).unwrap(); }
        std::fs::write(ort.join("onnxruntime.dll"), []).unwrap();
        std::fs::write(&pitch, []).unwrap();
        let paths = ForgePaths { models_dir: d.join("my-models").to_string_lossy().into_owned(),
            forge_python_path: d.join("custom-python/python.exe").to_string_lossy().into_owned(), ..ForgePaths::dir(&d) };
        let env = forge_child_env_from(EnvMap::default(), &paths);
        for (var, want) in [("FORGE_RS_NATIVE_ASSETS", assets), ("FORGE_RS_BP_MODEL", pitch),
            ("ORT_DYLIB_PATH", ort.join("onnxruntime.dll")), ("FORGE_RS_ORT_GPU_DIR", ort), ("FORGE_RS_CUDA_DIR", torch)] {
            assert_eq!(env.get(var).map(Path::new), Some(want.as_path()));
        }
        assert_eq!(env.get("MIDI_STUDIO_MODELS_DIR"), Some(paths.models_dir.as_str()));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn registry_prefers_hkcu_then_falls_back() {
        // Two scratch HKCU keys stand in for HKCU and HKLM (writing HKLM needs
        // elevation); query_in is the same code path query_forge_storage_dir runs.
        let base = format!(r"Software\StarsationX\MIDI Studio Test {}", std::process::id());
        let (cu, lm) = (format!(r"{base}\cu"), format!(r"{base}\lm"));
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let roots = || vec![(RegKey::predef(HKEY_CURRENT_USER), cu.clone(), 0), (RegKey::predef(HKEY_CURRENT_USER), lm.clone(), 0)];
        assert_eq!(query_in(&roots()), "", "neither key exists");
        let (lmk, _) = hkcu.create_subkey(&lm).unwrap();
        lmk.set_value(REG_VALUE, &r"D:\MIDI Studio Forge".to_string()).unwrap();
        assert_eq!(query_in(&roots()), r"D:\MIDI Studio Forge", "falls back to the mirror");
        let (cuk, _) = hkcu.create_subkey(&cu).unwrap();
        cuk.set_value(REG_VALUE, &"  ".to_string()).unwrap();
        assert_eq!(query_in(&roots()), r"D:\MIDI Studio Forge", "a blank HKCU value does not count");
        cuk.set_value(REG_VALUE, &r" E:\Forge ".to_string()).unwrap();
        assert_eq!(query_in(&roots()), r"E:\Forge", "HKCU wins, trimmed");
        let _ = hkcu.delete_subkey_all(&base);
    }

    #[test]
    fn free_space_reads() {
        let g = free_gb(&std::env::temp_dir()).unwrap();
        assert!(g > 0.0);
        assert!(free_gb(Path::new(r"C:\definitely\not\here")).is_some());
    }
}
