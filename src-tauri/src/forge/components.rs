//! Native Forge setup. The renderer selects a profile, never a URL, destination,
//! digest or filename. Planning is read-only; the explicit install IPC alone can fetch.
use super::{fpaths::{self, ForgePaths}, standard_user, verified::{self, Pin}};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

const RELEASE: &str = "https://github.com/StarsationX/midi-studio/releases/download/forge-components-v1";
static MANIFEST: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../../../tools/forge-components.json")).expect("pinned Forge manifest"));

struct Entry<'a> { group: &'a str, path: &'a str, pin: Pin<'a> }

fn selection(args: &Value) -> Result<impl Iterator<Item = Entry<'static>>, String> {
    let level = match args["profile"].as_str() {
        Some("fast") => 0, Some("piano") => 1, Some("full") => 2,
        _ => return Err("Select a Fast, Piano or Full Forge profile.".into()),
    };
    let cuda = args["cuda"].as_bool().ok_or("Select whether to install the CUDA provider.")?;
    Ok(MANIFEST.as_array().expect("Forge entries").iter().filter_map(move |v| {
        let group = v["group"].as_str().expect("Forge group");
        let selected = match group {
            "cpu" | "fast" => true, "piano" => level >= 1, "full" => level == 2, "cuda" => cuda,
            _ => panic!("unknown group in pinned Forge manifest"),
        };
        selected.then(|| Entry { group, path: v["path"].as_str().expect("Forge path"), pin: Pin {
            size: v["size"].as_u64().expect("Forge size"), sha256: v["sha256"].as_str().expect("Forge digest"),
        } })
    }))
}

#[derive(Default)]
struct Roots { installed: Vec<PathBuf>, models: Vec<PathBuf>, envs: Vec<PathBuf>, packages: Vec<PathBuf> }

impl Roots {
    fn discover(p: &ForgePaths) -> Self {
        let mut r = Self::default();
        r.installed.extend(std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)));
        r.installed.extend(fpaths::shared_models_dir().map(|d| d.join("native")));
        r.models.push(fpaths::models_dir(p));
        r.envs = fpaths::candidate_forge_env_dirs(p);
        for (key, list) in [("MIDI_STUDIO_MODELS_DIR", &mut r.models), ("MIDI_STUDIO_FORGE_ENV_DIR", &mut r.envs)] {
            if let Some(dir) = std::env::var_os(key).filter(|v| !v.is_empty()) { list.push(dir.into()); }
        }
        let registered = fpaths::query_forge_storage_dir();
        if !registered.is_empty() { r.envs.push(registered.into()); }
        for env in &r.envs {
            r.installed.push(env.join("native"));
            r.installed.push(env.clone());
            r.models.push(env.join("models"));
            r.packages.push(env.join("python/Lib/site-packages"));
            r.packages.push(env.join("Lib/site-packages"));
        }
        if let Some(py) = fpaths::forge_env_python(p) {
            if let Some(dir) = py.parent() {
                r.packages.push(dir.join("Lib/site-packages"));
                if dir.ends_with("Scripts") {
                    if let Some(base) = dir.parent() { r.packages.push(base.join("Lib/site-packages")); }
                }
            }
        }
        r
    }

    fn candidates(&self, entry: &Entry<'_>) -> Vec<PathBuf> {
        let rel = Path::new(entry.path);
        let name = rel.file_name().expect("pinned filename");
        let mut paths: Vec<_> = self.installed.iter().map(|base| base.join(rel)).collect();
        if let Ok(model) = rel.strip_prefix("assets") {
            for dir in &self.models { paths.push(dir.join(model)); paths.push(dir.join(name)); }
        }
        for site in &self.packages {
            match entry.group {
                "fast" => paths.push(site.join("basic_pitch/saved_models/icassp_2022").join(name)),
                "cpu" | "cuda" => paths.push(site.join("onnxruntime/capi").join(name)),
                _ => (),
            }
        }
        paths.sort_unstable(); paths.dedup();
        paths
    }
}

enum Local { Installed, Reuse(PathBuf), Missing, Conflict }
struct Planned { entry: Entry<'static>, target: PathBuf, local: Local }

fn locate(entry: &Entry<'_>, target: &Path, roots: &Roots) -> Result<Local, String> {
    match fs::symlink_metadata(target) {
        Ok(_) => Ok(if entry.pin.matches(target) { Local::Installed } else { Local::Conflict }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(roots.candidates(entry).into_iter()
            .find(|p| p != target && entry.pin.matches(p)).map_or(Local::Missing, Local::Reuse)),
        Err(e) => Err(format!("Could not inspect {}: {e}", target.display())),
    }
}

fn plan(p: &ForgePaths, args: &Value) -> Result<Vec<Planned>, String> {
    let entries = selection(args)?;
    let dir = fpaths::forge_env_dir(p).join("native");
    let roots = Roots::discover(p);
    entries.map(|entry| {
        let target = dir.join(entry.path);
        let local = locate(&entry, &target, &roots)?;
        Ok(Planned { entry, target, local })
    }).collect()
}

fn conflict(path: &Path) -> String { format!("A different or unreadable file exists at {}. It was left alone. Move it aside and retry.", path.display()) }

pub(super) fn status(p: &ForgePaths, args: &Value) -> Value {
    let rows = match plan(p, args) {
        Ok(r) => r, Err(e) => return json!({"ok":false,"missingBytes":0,"files":[],"error":e}),
    };
    let mut missing = 0;
    let mut error = None;
    let files: Vec<_> = rows.iter().map(|r| {
        let state = match r.local {
            Local::Installed => "installed", Local::Reuse(_) => "reusable",
            Local::Missing => { missing += r.entry.pin.size; "missing" },
            Local::Conflict => { error.get_or_insert_with(|| conflict(&r.target)); "conflict" },
        };
        json!({"group":r.entry.group,"path":r.entry.path,"size":r.entry.pin.size,"state":state})
    }).collect();
    let mut result = json!({"ok":error.is_none(), "missingBytes":missing, "files":files});
    if let Some(e) = error { result["error"] = json!(e); }
    result
}

fn install_files(rows: Vec<Planned>, limit: Option<u64>, mut fetch: impl FnMut(&str) -> Result<Box<dyn Read>, String>) -> Result<(), String> {
    // Preflight conflicts before writing anything or requesting the first byte.
    if let Some(r) = rows.iter().find(|r| matches!(r.local, Local::Conflict)) { return Err(conflict(&r.target)); }
    let missing: u64 = rows.iter().filter(|r| matches!(r.local, Local::Missing)).map(|r| r.entry.pin.size).sum();
    if limit.is_some_and(|approved| missing > approved) {
        return Err("Local Forge files changed since the size check. Check again before downloading.".into());
    }
    for r in rows {
        if matches!(r.local, Local::Installed) { continue; }
        verified::publish(&r.target, r.entry.pin, || -> Result<Box<dyn Read>, String> {
            if let Local::Reuse(path) = r.local {
                return File::open(&path).map(|f| Box::new(f) as Box<dyn Read>).map_err(|e| format!("Could not reuse {}: {e}", path.display()));
            }
            fetch(r.entry.path.rsplit('/').next().expect("pinned filename"))
        }).map_err(|e| format!("{}: {e}", r.entry.path))?;
    }
    Ok(())
}

pub(super) fn install(p: &ForgePaths, args: &Value) -> Result<(), String> {
    standard_user::require().map_err(|e| e.to_string())?;
    let limit = args.get("maxDownloadBytes").map(|v| v.as_u64().ok_or("Invalid download limit")).transpose()?;
    let mut agent = None;
    install_files(plan(p, args)?, limit, |name| {
        if agent.is_none() {
            let tls = native_tls::TlsConnector::new().map_err(|e| format!("TLS unavailable: {e}"))?;
            agent = Some(ureq::AgentBuilder::new().tls_connector(Arc::new(tls)).https_only(true)
                .timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_secs(60)).build());
        }
        let response = agent.as_ref().unwrap().get(&format!("{RELEASE}/{name}"))
            .set("User-Agent", "midi-studio-forge").call().map_err(|e| format!("Download failed: {e}"))?;
        if response.status() != 200 { return Err(format!("Download returned HTTP {}", response.status())); }
        Ok(response.into_reader())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn profiles_pin_only_the_requested_public_dependencies() {
        let groups = |p: &str, cuda: bool| -> BTreeSet<_> {
            selection(&json!({"profile":p,"cuda":cuda})).unwrap().map(|e| e.group).collect()
        };
        assert_eq!(groups("fast", false), BTreeSet::from(["cpu","fast"]));
        assert_eq!(groups("piano", false), BTreeSet::from(["cpu","fast","piano"]));
        assert_eq!(groups("full", true), BTreeSet::from(["cpu","fast","piano","full","cuda"]));
        assert!(selection(&json!({"profile":"https://example.com", "cuda":false})).is_err());
        let mut names = BTreeSet::new();
        for e in selection(&json!({"profile":"full","cuda":true})).unwrap() {
            assert!(e.pin.size > 0 && e.pin.sha256.len() == 64 && e.pin.sha256.bytes().all(|c| c.is_ascii_hexdigit()));
            assert!(!e.path.contains("bs_rofo") && !e.path.ends_with(".ckpt"));
            assert!(Path::new(e.path).components().all(|c| matches!(c, std::path::Component::Normal(_))));
            assert!(names.insert(Path::new(e.path).file_name().unwrap()));
        }
    }

    #[test]
    fn components_reuse_retry_and_conflict_without_overwrite() {
        let dir = std::env::temp_dir().join(format!("studio-component-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let legacy = dir.join("custom-model-library");
        fs::create_dir_all(legacy.join("onnx")).unwrap();
        let source = legacy.join("onnx/model.onnx");
        let target = dir.join("native/assets/onnx/model.onnx");
        let roots = Roots { models: vec![legacy], ..Default::default() };
        let plan = || {
            let entry = Entry { group:"piano",path:"assets/onnx/model.onnx",pin:Pin {size:3,
                sha256:"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"} };
            vec![Planned { local:locate(&entry, &target, &roots).unwrap(), entry, target:target.clone() }]
        };
        fn offline(_: &str) -> Result<Box<dyn Read>, String> { panic!("unexpected download") }
        fs::write(&source, b"abc").unwrap();
        assert!(matches!(plan()[0].local, Local::Reuse(_)));
        install_files(plan(), Some(0), offline).unwrap();
        install_files(plan(), Some(0), offline).unwrap(); // already installed
        assert_eq!(fs::read(&target).unwrap(), b"abc");
        assert_eq!(fs::read(&source).unwrap(), b"abc");
        fs::write(&target, b"XYZ").unwrap();
        assert!(install_files(plan(), None, offline).unwrap_err().contains("left alone"));
        assert_eq!(fs::read(&target).unwrap(), b"XYZ");
        fs::remove_file(&target).unwrap();
        fs::write(&source, b"XYZ").unwrap(); // same size, wrong digest
        assert!(matches!(plan()[0].local, Local::Missing));
        assert!(install_files(plan(), Some(0), offline).unwrap_err().contains("Check again"));
        assert!(install_files(plan(), Some(3), |_| Ok(Box::new(&b"bad"[..]))).is_err());
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 0);
        install_files(plan(), Some(3), |name| { assert_eq!(name, "model.onnx"); Ok(Box::new(&b"abc"[..])) }).unwrap();
        assert!(matches!(plan()[0].local, Local::Installed));
        fs::remove_dir_all(dir).unwrap();
    }
}
