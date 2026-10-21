// review.rs: the Editor's review:load / review:saveProject / review:exportMidi,
// electron/main.js loadReviewFile and its two handlers, on midi_doc.rs instead
// of a python child process. Same envelopes, same dialogs, same guard against
// writing over the user's original .mid (forge-storage.js candidateTarget).
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{midi_doc, paths, Host, MAIN};

fn is_obj(v: &Value) -> bool {
    v.is_object()
}

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `${v}` / String(v) for the values these handlers see.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Array(_) => "".into(),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// String(v || fallback).
fn or_str(v: Option<&Value>, fallback: &str) -> String {
    match v {
        Some(v) if js_truthy(v) => js_string(v),
        _ => fallback.to_string(),
    }
}

fn exists(p: &str) -> bool {
    !p.is_empty() && Path::new(p).exists()
}

fn is_midi(p: &str) -> bool {
    let l = p.to_lowercase();
    l.ends_with(".mid") || l.ends_with(".midi")
}

/// path.basename(p, path.extname(p)).
fn base_no_ext(p: &str) -> String {
    let base = p.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 => base[..i].to_string(),
        _ => base.to_string(),
    }
}

fn components_lower(p: &Path) -> Vec<String> {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    abs.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase().replace('/', "\\"))
        .collect()
}

/// forge-storage.js isInside: child is parent or below it (case-insensitive,
/// as path.relative is on Windows).
pub fn is_inside(child: &str, parent: &str) -> bool {
    let c = components_lower(Path::new(child));
    let p = components_lower(Path::new(parent));
    c.len() >= p.len() && c[..p.len()] == p[..]
}

/// forge-storage.js uniquePath: "song.mid" -> "song (2).mid" when taken.
pub fn unique_path(target: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    if !exists(target) {
        return target.to_path_buf();
    }
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (base, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    for n in 2..999 {
        let c = dir.join(format!("{base} ({n}){ext}"));
        if !exists(&c) {
            return c;
        }
    }
    target.to_path_buf()
}

/// forge-storage.js candidateTarget. Opening a plain .mid points the "clean"
/// candidate straight at the user's own file; only a real project (or a file
/// already inside the project folder) may be overwritten in place.
pub fn candidate_target(existing: Option<&Value>, project_dir: &Path, from_project: bool, fallback_name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    if let Some(e) = existing.filter(|e| js_truthy(e)) {
        let e = js_string(e);
        if from_project || is_inside(&e, &project_dir.to_string_lossy()) {
            return PathBuf::from(e);
        }
    }
    unique_path(&project_dir.join(fallback_name), exists)
}

/// new Date().toISOString().
fn iso_now() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// main.js loadReviewFile.
pub fn load_review_file(file_path: &str) -> Result<Value, String> {
    if !exists(file_path) {
        return Err("Project or MIDI file was not found.".into());
    }
    if is_midi(file_path) {
        let document = midi_doc::load(Path::new(file_path))?;
        return Ok(json!({
            "projectPath": "",
            "project": {"format": "midi-studio-project", "version": 1, "name": base_no_ext(file_path),
                "sourceAudio": "", "selectedCandidate": "clean", "candidates": {"clean": file_path}},
            "documents": {"clean": document},
        }));
    }
    let text = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let project: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if project.get("format").and_then(Value::as_str) != Some("midi-studio-project") || !project.get("candidates").is_some_and(is_obj) {
        return Err("This is not a MIDI Studio project.".into());
    }
    let mut documents = Map::new();
    for (name, midi_path) in project["candidates"].as_object().into_iter().flatten() {
        if let Some(p) = midi_path.as_str().filter(|p| exists(p)) {
            documents.insert(name.clone(), midi_doc::load(Path::new(p))?);
        }
    }
    if documents.is_empty() {
        return Err("The project MIDI files could not be found.".into());
    }
    Ok(json!({"projectPath": file_path, "project": project, "documents": documents}))
}

fn save_dialog(app: &AppHandle, title: &str, default: &Path, filter: (&str, &[&str])) -> Option<PathBuf> {
    let mut d = app.dialog().file().set_title(title).add_filter(filter.0, filter.1);
    if let Some(dir) = default.parent() {
        d = d.set_directory(dir);
    }
    if let Some(n) = default.file_name() {
        d = d.set_file_name(n.to_string_lossy());
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        d = d.set_parent(&w);
    }
    d.blocking_save_file()?.into_path().ok()
}

fn output_dir(app: &AppHandle) -> PathBuf {
    let h = app.state::<std::sync::Arc<Host>>();
    paths::program_output_dir(&h.settings.get_str("forge.outputDir"))
}

/// The project file the way JSON.stringify(saved, null, 2) wrote it.
fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// review:saveProject, minus the dialog (`pick` stands in for it).
pub fn save_project(payload: &Value, output: &Path, pick: impl FnOnce(PathBuf) -> Option<PathBuf>) -> Result<Value, String> {
    let empty = json!({});
    let payload = if is_obj(payload) { payload } else { &empty };
    let project = payload.get("project").filter(|v| is_obj(v)).unwrap_or(&empty);
    let documents = payload.get("documents").filter(|v| is_obj(v)).unwrap_or(&empty);
    let mut project_path = or_str(payload.get("projectPath"), "");
    let from_project = !project_path.is_empty();
    let name = or_str(project.get("name"), "melody");
    if project_path.is_empty() {
        match pick(output.join(format!("{name}.midstudio.json"))) {
            Some(p) => project_path = p.to_string_lossy().into_owned(),
            None => return Ok(json!({"ok": false, "canceled": true})),
        }
    }
    let project_dir = Path::new(&project_path).parent().map(Path::to_path_buf).unwrap_or_default();
    let mut candidates = Map::new();
    for (cand, document) in documents.as_object().into_iter().flatten() {
        let existing = project.get("candidates").filter(|c| js_truthy(c)).and_then(|c| c.get(cand));
        let midi_path = candidate_target(existing, &project_dir, from_project, &format!("{name}_{cand}.mid"), Path::exists);
        midi_doc::save(&midi_path, document)?;
        candidates.insert(cand.clone(), json!(midi_path.to_string_lossy()));
    }
    // Object.assign({}, project, {...}): existing keys keep their place.
    let mut saved = project.as_object().cloned().unwrap_or_default();
    saved.insert("format".into(), json!("midi-studio-project"));
    saved.insert("version".into(), json!(1));
    saved.insert("candidates".into(), Value::Object(candidates));
    let selected = [payload.get("selectedCandidate"), project.get("selectedCandidate")]
        .into_iter()
        .flatten()
        .find(|v| js_truthy(v))
        .cloned()
        .unwrap_or(json!("clean"));
    saved.insert("selectedCandidate".into(), selected);
    saved.insert("updatedAt".into(), json!(iso_now()));
    let saved = Value::Object(saved);
    std::fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;
    std::fs::write(&project_path, pretty(&saved)).map_err(|e| e.to_string())?;
    Ok(json!({"ok": true, "projectPath": project_path, "project": saved}))
}

/// The review:* channels. None: not one of ours.
pub fn handle(app: &AppHandle, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    let fail = |e: String| json!({"ok": false, "error": e});
    Some(Ok(match channel {
        "review:load" => {
            let fp = or_str(Some(&a0), "");
            match load_review_file(&fp) {
                Ok(data) => json!({"ok": true, "data": data}),
                Err(e) => fail(e),
            }
        }
        "review:saveProject" => {
            let pick = |def: PathBuf| save_dialog(app, "Save MIDI Studio project", &def, ("MIDI Studio project", &["json"]));
            save_project(&a0, &output_dir(app), pick).unwrap_or_else(fail)
        }
        "review:exportMidi" => {
            let empty = json!({});
            let p = if is_obj(&a0) { &a0 } else { &empty };
            let def = output_dir(app).join(format!("{}_edited.mid", or_str(p.get("name"), "melody")));
            let Some(target) = save_dialog(app, "Export edited MIDI", &def, ("MIDI", &["mid"])) else {
                return Some(Ok(json!({"ok": false, "canceled": true})));
            };
            let doc = p.get("document").filter(|d| js_truthy(d)).cloned().unwrap_or(json!({}));
            match midi_doc::save(&target, &doc) {
                Ok(_) => {
                    let dir = target.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                    Host::push(app, "library-changed", json!(dir));
                    json!({"ok": true, "path": target.to_string_lossy()})
                }
                Err(e) => fail(e),
            }
        }
        _ => return None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_target_never_overwrites_an_opened_midi() {
        let dir = Path::new(r"C:\Users\x\Documents\MIDI Studio");
        // A plain .mid opened from elsewhere: a NEW file in the project folder.
        let t = candidate_target(Some(&json!(r"D:\songs\mine.mid")), dir, false, "mine_clean.mid", |_| false);
        assert_eq!(t, dir.join("mine_clean.mid"));
        // ...unless the project was opened from disk, or the candidate is inside it.
        assert_eq!(candidate_target(Some(&json!(r"D:\songs\mine.mid")), dir, true, "x.mid", |_| false), PathBuf::from(r"D:\songs\mine.mid"));
        let inside = r"c:\users\x\documents\midi studio\sub\a.mid";
        assert_eq!(candidate_target(Some(&json!(inside)), dir, false, "x.mid", |_| false), PathBuf::from(inside));
        // Taken names count up.
        let taken = dir.join("mine_clean.mid");
        let t = candidate_target(None, dir, false, "mine_clean.mid", |p| p == taken);
        assert_eq!(t, dir.join("mine_clean (2).mid"));
    }

    #[test]
    fn iso_is_javascripts() {
        let s = iso_now();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z') && &s[4..5] == "-" && &s[10..11] == "T");
    }

    #[test]
    fn save_project_round_trips_through_load() {
        let d = std::env::temp_dir().join(format!("ms-review-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let doc = json!({"bpm": 100, "programs": {}, "notes": [{"pitch": 60, "start": 0.0, "end": 0.6, "velocity": 90, "channel": 0}]});
        let payload = json!({"projectPath": "", "project": {"name": "tune", "sourceAudio": "a.wav", "candidates": {"clean": r"D:\elsewhere\tune.mid"}},
            "documents": {"clean": doc}, "selectedCandidate": "clean"});
        let r = save_project(&payload, &d, |def| Some(def)).unwrap();
        assert_eq!(r["ok"], json!(true));
        let pp = r["projectPath"].as_str().unwrap().to_string();
        assert!(pp.ends_with("tune.midstudio.json"));
        let saved = &r["project"];
        assert_eq!(saved["sourceAudio"], json!("a.wav"));
        let clean = saved["candidates"]["clean"].as_str().unwrap();
        assert!(clean.ends_with("tune_clean.mid"), "never the user's original: {clean}");
        let back = load_review_file(&pp).unwrap();
        assert_eq!(back["documents"]["clean"]["notes"][0]["end"], json!(0.6));
        assert_eq!(back["documents"]["clean"]["bpm"], json!(100.0));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn load_refuses_what_main_js_refused() {
        assert_eq!(load_review_file("").unwrap_err(), "Project or MIDI file was not found.");
        let f = std::env::temp_dir().join(format!("ms-notproject-{}.json", std::process::id()));
        std::fs::write(&f, r#"{"format":"other"}"#).unwrap();
        assert_eq!(load_review_file(&f.to_string_lossy()).unwrap_err(), "This is not a MIDI Studio project.");
        let _ = std::fs::remove_file(&f);
    }
}
