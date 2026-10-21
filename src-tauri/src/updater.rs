// updater.rs: electron/updater.js, ported. GitHub releases/latest -> SemVer
// compare -> download the Setup.exe -> SHA-256 against GitHub's per-asset
// digest -> start the NSIS installer, visibly, OUTSIDE our process tree.
//
// Status goes to the main frame only (update-status is SHELL_ONLY in the
// bridge), so the shell owns the one updater UI.
//
// Test hooks, both environment variables:
//   MIDI_STUDIO_UPDATE_URL       the releases/latest URL. Only while it is set
//                                may a URL be plain http, and only to loopback.
//   MIDI_STUDIO_UPDATE_NO_LAUNCH stop at "ready": report the exact installer
//                                command line instead of running it, and never
//                                open a browser or quit.
use std::cmp::Ordering;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::{blog, paths, Host, MAIN};

pub const LATEST_API: &str = "https://api.github.com/repos/StarsationX/midi-studio/releases/latest";
pub const URL_ENV: &str = "MIDI_STUDIO_UPDATE_URL";
pub const NO_LAUNCH_ENV: &str = "MIDI_STUDIO_UPDATE_NO_LAUNCH";
const USER_AGENT: &str = "midi-studio-updater";
const MAX_REDIRECTS: u32 = 5;

fn env_set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0")
}

// ---- SemVer-correct compare (handles -rc / -beta) ---------------------------

#[derive(Debug, Clone, PartialEq)]
enum Pre {
    Num(u64),
    Text(String),
}

/// updater.js parseVer: `v` prefix dropped, missing parts are 0, a non-number
/// part is 0, and the pre-release splits on dots into numbers and words.
fn parse_ver(v: &str) -> ([i64; 3], Vec<Pre>) {
    let s = v.trim();
    let s = s.strip_prefix(['v', 'V']).unwrap_or(s);
    let (core, pre) = s.split_once('-').map_or((s, ""), |(c, p)| (c, p.split('-').next().unwrap_or("")));
    let mut rel = [0i64; 3];
    for (i, n) in core.split('.').take(3).enumerate() {
        // parseInt: leading digits only.
        let digits: String = n.trim_start().chars().take_while(char::is_ascii_digit).collect();
        rel[i] = digits.parse().unwrap_or(0);
    }
    let pre = if pre.is_empty() {
        vec![]
    } else {
        pre.split('.')
            .map(|p| if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) { Pre::Num(p.parse().unwrap_or(0)) } else { Pre::Text(p.to_string()) })
            .collect()
    };
    (rel, pre)
}

pub fn cmp_ver(a: &str, b: &str) -> Ordering {
    let (ra, pa) = parse_ver(a);
    let (rb, pb) = parse_ver(b);
    match ra.cmp(&rb) {
        Ordering::Equal => {}
        o => return o,
    }
    match (pa.is_empty(), pb.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = match (pa.get(i), pb.get(i)) {
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) => (x, y),
        };
        let o = match (x, y) {
            (Pre::Num(x), Pre::Num(y)) => x.cmp(y),
            (Pre::Num(_), Pre::Text(_)) => Ordering::Less,
            (Pre::Text(_), Pre::Num(_)) => Ordering::Greater,
            (Pre::Text(x), Pre::Text(y)) => x.cmp(y),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

// ---- HTTPS (enforced), redirects followed by hand ---------------------------

#[derive(Clone, Copy)]
pub struct Net {
    /// Plain http to 127.0.0.1 / localhost / [::1]. Test runs only.
    pub allow_loopback_http: bool,
}

impl Net {
    pub fn from_env() -> Net {
        Net { allow_loopback_http: env_set(URL_ENV) }
    }

    fn check(&self, raw: &str) -> Result<url::Url, String> {
        let refuse = || format!("Refusing non-HTTPS URL: {raw}");
        let u = url::Url::parse(raw).map_err(|_| refuse())?;
        match u.scheme() {
            "https" => Ok(u),
            "http" if self.allow_loopback_http => {
                let loopback = match u.host() {
                    Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                    Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                    Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                    None => false,
                };
                if loopback { Ok(u) } else { Err(refuse()) }
            }
            _ => Err(refuse()),
        }
    }

    fn agent() -> Result<ureq::Agent, String> {
        let tls = native_tls::TlsConnector::new().map_err(|e| format!("TLS unavailable: {e}"))?;
        Ok(ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .redirects(0)
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
            .user_agent(USER_AGENT)
            .build())
    }

    /// GET with the redirect chain walked here, so every hop is held to the
    /// same https rule as the first.
    fn get(&self, raw: &str, accept: Option<&str>, what: &str) -> Result<ureq::Response, String> {
        let agent = Net::agent()?;
        let mut url = self.check(raw)?;
        for _ in 0..=MAX_REDIRECTS {
            let mut req = agent.request_url("GET", &url);
            if let Some(a) = accept {
                req = req.set("Accept", a);
            }
            let resp = match req.call() {
                Ok(r) => r,
                Err(ureq::Error::Status(_, r)) => r,
                Err(e) => return Err(e.to_string()),
            };
            let status = resp.status();
            if (300..400).contains(&status) {
                if let Some(loc) = resp.header("location") {
                    let next = url.join(loc).map_err(|e| e.to_string())?;
                    url = self.check(next.as_str())?;
                    continue;
                }
            }
            if status != 200 {
                return Err(format!("{what} HTTP {status}"));
            }
            return Ok(resp);
        }
        Err("Too many redirects".into())
    }

    pub fn get_json(&self, url: &str) -> Result<Value, String> {
        let resp = self.get(url, Some("application/vnd.github+json"), "GitHub API")?;
        let mut body = String::new();
        resp.into_reader().take(16 * 1024 * 1024).read_to_string(&mut body).map_err(|_| "Bad JSON".to_string())?;
        serde_json::from_str(&body).map_err(|_| "Bad JSON".to_string())
    }

    /// Stream to `dest`. A failure part-way removes the partial file.
    pub fn download(&self, url: &str, dest: &Path, on_progress: &dyn Fn(f64)) -> Result<(), String> {
        let resp = self.get(url, None, "Download")?;
        let total: u64 = resp.header("content-length").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        let fail = |e: String| {
            let _ = std::fs::remove_file(dest);
            e
        };
        let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
        let mut r = resp.into_reader();
        let mut buf = vec![0u8; 64 * 1024];
        let mut got = 0u64;
        loop {
            let n = r.read(&mut buf).map_err(|e| fail(e.to_string()))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| fail(e.to_string()))?;
            got += n as u64;
            if total > 0 {
                on_progress(got as f64 / total as f64);
            }
        }
        out.flush().map_err(|e| fail(e.to_string()))?;
        if total > 0 && got != total {
            return Err(fail(format!("Download ended early ({got} of {total} bytes)")));
        }
        Ok(())
    }
}

pub fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Against the GitHub asset's `digest` ("sha256:<hex>"). Ok(false) when the
/// release has no digest (older releases), so the caller can fall back to the
/// release page; Err on a real mismatch (never swap then).
pub fn verify_digest(file: &Path, digest: &str) -> Result<bool, String> {
    let d = digest.trim();
    let want = d.get(..7).filter(|p| p.eq_ignore_ascii_case("sha256:")).map_or(d, |_| &d[7..]).to_ascii_lowercase();
    if want.len() != 64 || !want.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(false);
    }
    if sha256_file(file)? != want {
        return Err("Checksum mismatch, download does not match the GitHub release digest".into());
    }
    Ok(true)
}

/// Updates always use the full NSIS installer, never the portable build.
pub fn pick_setup(assets: &Value) -> Option<&Value> {
    let list = assets.as_array()?;
    let name = |a: &Value| a.get("name").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    list.iter()
        .find(|a| {
            let n = name(a);
            n.ends_with(".exe") && n.find("setup").is_some_and(|i| n[i..].ends_with(".exe"))
        })
        .or_else(|| list.iter().find(|a| name(a).ends_with(".exe") && !name(a).contains("portable")))
}

#[derive(Clone, Debug)]
pub struct Staged {
    pub version: String,
    pub url: String,
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub notes: String,
    pub html_url: String,
}

/// updater.js checkForUpdates. `send` gets the statuses; an automatic check
/// (manual = false) is silent unless there is something to say.
pub fn check(net: &Net, api: &str, current: &str, manual: bool, send: &dyn Fn(Value)) -> Option<Staged> {
    if manual {
        send(json!({"state": "checking"}));
    }
    let rel = match net.get_json(api) {
        Ok(r) => r,
        Err(e) => {
            if manual {
                send(json!({"state": "error", "message": e, "manual": true}));
            }
            return None;
        }
    };
    let text = |k: &str| rel.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let latest = Some(text("tag_name")).filter(|s| !s.is_empty()).unwrap_or_else(|| text("name"));
    let setup = rel.get("assets").and_then(pick_setup);
    match setup {
        Some(a) if cmp_ver(&latest, current) == Ordering::Greater => {
            let field = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let staged = Staged {
                version: latest.trim().trim_start_matches(['v', 'V']).to_string(),
                url: field("browser_download_url"),
                name: field("name"),
                size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
                digest: field("digest"),
                notes: text("body"),
                html_url: text("html_url"),
            };
            let notes: String = staged.notes.chars().take(4000).collect();
            send(json!({
                "state": "available", "version": staged.version, "current": current,
                "size": staged.size, "notes": notes, "canSelfUpdate": true, "htmlUrl": staged.html_url,
            }));
            Some(staged)
        }
        _ => {
            if manual {
                send(json!({"state": "none", "current": current, "manual": true}));
            }
            None
        }
    }
}

pub enum Outcome {
    /// No digest on the release: the user is sent to the release page.
    Manual,
    /// The installer is running (or, in a no-launch run, would be).
    Launched(Value),
    Failed(String, Option<PathBuf>),
}

/// updater.js applyUpdate, up to and including the launch, which the caller
/// supplies. The asset name is reduced to a bare file name: it comes off the
/// network and must not be able to point outside the staging folder.
pub fn apply(net: &Net, staged: &Staged, dir: &Path, send: &dyn Fn(Value), launch: &dyn Fn(&Path) -> Result<Value, String>) -> Outcome {
    send(json!({"state": "downloading", "percent": 0}));
    let name = Path::new(&staged.name).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty());
    let Some(name) = name else {
        return Outcome::Failed("The release asset has no usable file name.".into(), None);
    };
    let _ = std::fs::create_dir_all(dir);
    let installer = dir.join(name);
    let last = Mutex::new(0i64);
    let progress = |p: f64| {
        let pct = (p * 100.0).round().clamp(0.0, 100.0) as i64;
        let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
        if pct != *l {
            *l = pct;
            send(json!({"state": "downloading", "percent": pct}));
        }
    };
    if let Err(e) = net.download(&staged.url, &installer, &progress) {
        return Outcome::Failed(e, None);
    }
    send(json!({"state": "verifying"}));
    match verify_digest(&installer, &staged.digest) {
        Ok(true) => {}
        Ok(false) => {
            let _ = std::fs::remove_file(&installer);
            send(json!({"state": "manual", "htmlUrl": staged.html_url, "reason": "no-digest"}));
            return Outcome::Manual;
        }
        Err(e) => {
            let _ = std::fs::remove_file(&installer);
            return Outcome::Failed(e, None);
        }
    }
    send(json!({"state": "ready"}));
    match launch(&installer) {
        Ok(v) => Outcome::Launched(v),
        Err(e) => Outcome::Failed(e, Some(installer)),
    }
}

// ---- launching the installer ------------------------------------------------

/// Can this process write where the app is installed? An app in Program Files
/// cannot be replaced without elevation; the installer would exit 1223 at once
/// and nothing would happen, which is what "the updater does nothing" was.
pub fn install_dir_writable() -> bool {
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) else { return false };
    let probe = dir.join(format!(".midi-studio-update-{}", std::process::id()));
    let ok = std::fs::write(&probe, "ok").is_ok();
    if ok {
        let _ = std::fs::remove_file(&probe);
    }
    ok
}

/// ALWAYS the visible wizard, never /S: NSIS skips every page in silent mode,
/// which re-decided the install folder and the Forge storage path from
/// defaults (see electron/updater.js installerArgs).
///
/// ALWAYS through Start-Process, never a direct spawn: a spawned child stays
/// in MIDI Studio's process tree, and the installer's own close-the-app step
/// (taskkill /im "MIDI Studio.exe") took the installer down with it.
/// Start-Process hands the launch to a helper that exits at once.
pub fn installer_command(file: &Path, elevate: bool) -> (String, Vec<String>) {
    let quoted = file.to_string_lossy().replace('\'', "''");
    let script = format!("Start-Process -FilePath '{quoted}'{}", if elevate { " -Verb RunAs" } else { "" });
    ("powershell.exe".into(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script])
}

/// Run the Start-Process helper and wait for it (it returns once the installer
/// is running, or the UAC prompt was refused). Only the helper is our child.
pub fn launch_installer(file: &Path) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let elevate = !install_dir_writable();
    let (program, args) = installer_command(file, elevate);
    let failed = || {
        if elevate {
            "Windows needs permission to replace the installed files. Approve the prompt, or run the downloaded installer yourself."
        } else {
            "The installer could not be started. Run the downloaded file yourself."
        }
        .to_string()
    };
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| failed())?;
    let t = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => return Ok(json!({"elevated": elevate})),
            Ok(Some(_)) | Err(_) => return Err(failed()),
            Ok(None) if t.elapsed() > Duration::from_secs(120) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

// ---- the app side -----------------------------------------------------------

#[derive(Default)]
pub struct Updater {
    cached: Mutex<Option<Staged>>,
    busy: Mutex<bool>,
}

fn api_url() -> String {
    std::env::var(URL_ENV).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| LATEST_API.to_string())
}

fn push(app: &AppHandle, v: Value) {
    Host::push(app, "update-status", v);
}

fn run_check(app: &AppHandle, manual: bool) {
    let Some(u) = app.try_state::<Arc<Updater>>().map(|s| s.inner().clone()) else { return };
    let current = app.package_info().version.to_string();
    let staged = check(&Net::from_env(), &api_url(), &current, manual, &|v| push(app, v));
    *u.cached.lock().unwrap_or_else(|e| e.into_inner()) = staged;
}

fn run_apply(app: &AppHandle) {
    let Some(u) = app.try_state::<Arc<Updater>>().map(|s| s.inner().clone()) else { return };
    let staged = u.cached.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(staged) = staged else {
        push(app, json!({"state": "error", "message": "No update staged."}));
        return;
    };
    {
        let mut busy = u.busy.lock().unwrap_or_else(|e| e.into_inner());
        if *busy {
            return;
        }
        *busy = true;
    }
    let dry = env_set(NO_LAUNCH_ENV);
    let launch = |file: &Path| -> Result<Value, String> {
        if dry {
            let elevate = !install_dir_writable();
            let (program, args) = installer_command(file, elevate);
            blog(&format!("update: no-launch run, would run: {program} {}", args.join(" ")));
            return Ok(json!({"dryRun": true, "program": program, "args": args, "elevated": elevate}));
        }
        launch_installer(file)
    };
    let dir = paths::user_data_dir().join("updates");
    let outcome = apply(&Net::from_env(), &staged, &dir, &|v| push(app, v), &launch);
    *u.busy.lock().unwrap_or_else(|e| e.into_inner()) = false;
    match outcome {
        Outcome::Manual => {
            if dry {
                blog(&format!("update: no-launch run, would open {}", staged.html_url));
            } else if staged.html_url.starts_with("https://") {
                let _ = app.opener().open_url(&staged.html_url, None::<&str>);
            }
        }
        Outcome::Failed(e, file) => {
            // Leave the app running and hand the user the file rather than
            // quitting into nothing.
            if let (Some(f), false) = (file, dry) {
                let _ = app.opener().reveal_item_in_dir(f);
            }
            push(app, json!({"state": "error", "message": e}));
        }
        Outcome::Launched(v) => {
            if dry {
                push(app, json!({"state": "ready", "launch": v}));
                return;
            }
            blog("update: installer started, closing");
            std::thread::sleep(Duration::from_millis(400));
            let h = app.state::<Arc<Host>>().inner().clone();
            match app.get_webview_window(MAIN) {
                Some(w) => h.close_now(&w),
                None => app.exit(0),
            }
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                app2.exit(0);
            });
        }
    }
}

pub fn dispatch(app: &AppHandle, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match channel {
        "update:check" => {
            let a0 = args.first().cloned().unwrap_or(Value::Null);
            let manual = if a0.is_object() { a0.get("manual").is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false))) } else { true };
            run_check(app, manual);
            Some(Ok(Value::Null))
        }
        "update:apply" => {
            run_apply(app);
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}

/// After the main window exists. An installer just ran (--post-update): say
/// so once the shell is up. Otherwise a release build (or a test run pointed
/// at a mock) checks on its own, timed from the first paint so a slow machine
/// does not answer into a page that is not listening yet.
pub fn init(app: &AppHandle) {
    app.manage(Arc::new(Updater::default()));
    let h = app.state::<Arc<Host>>().inner().clone();
    let auto = (!cfg!(debug_assertions) || env_set(URL_ENV)) && h.settings.get("ui.autoCheckUpdates") != json!(false);
    if !h.post_update && !auto {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let t = Instant::now();
        while !h.is_painted() && t.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(100));
        }
        if h.post_update {
            std::thread::sleep(Duration::from_millis(1500));
            push(&app, json!({"state": "updated", "version": app.package_info().version.to_string()}));
        } else {
            std::thread::sleep(Duration::from_millis(2500));
            run_check(&app, false);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn semver_matches_updater_js() {
        let sgn = |a: &str, b: &str| cmp_ver(a, b) as i32;
        assert_eq!(sgn("2.1.0", "2.0.0"), 1);
        assert_eq!(sgn("2.0.0", "2.1.0"), -1);
        assert_eq!(sgn("2.0.0", "2.0.0"), 0);
        assert_eq!(sgn("v2.1.0", "2.0.9"), 1);
        assert_eq!(sgn("2.0.0", "2.0.0-rc1"), 1);
        assert_eq!(sgn("2.0.0-rc2", "2.0.0-rc1"), 1);
        assert_eq!(sgn("2.1.0", "2.10.0"), -1);
        assert_eq!(sgn("3.0.0-beta.2", "3.0.0-beta.10"), -1);
        assert_eq!(sgn("3.0.0-1", "3.0.0-alpha"), -1);
        assert_eq!(sgn("3.0.0-alpha.1", "3.0.0-alpha"), 1);
        assert_eq!(sgn("3", "3.0.0"), 0);
    }

    #[test]
    fn picks_setup_not_portable() {
        let assets = json!([
            {"name": "MIDI-Studio-2.1.0-portable.exe", "browser_download_url": "https://x/p", "size": 1},
            {"name": "MIDI-Studio-2.1.0-Setup.exe", "browser_download_url": "https://x/s", "size": 1},
        ]);
        assert_eq!(pick_setup(&assets).unwrap()["name"], json!("MIDI-Studio-2.1.0-Setup.exe"));
        let only_portable = json!([{"name": "MIDI-Studio-portable.exe"}, {"name": "notes.txt"}]);
        assert!(pick_setup(&only_portable).is_none());
    }

    #[test]
    fn installer_goes_through_start_process_and_never_silent() {
        let f = Path::new(r"C:\Users\o'brien\AppData\Roaming\midi-studio\updates\MIDI-Studio-3.1.0-Setup.exe");
        let (p, a) = installer_command(f, false);
        assert_eq!(p, "powershell.exe");
        assert_eq!(a, vec![
            "-NoProfile".to_string(), "-NonInteractive".into(), "-Command".into(),
            r"Start-Process -FilePath 'C:\Users\o''brien\AppData\Roaming\midi-studio\updates\MIDI-Studio-3.1.0-Setup.exe'".into(),
        ]);
        let (_, a) = installer_command(f, true);
        assert!(a[3].ends_with("-Setup.exe' -Verb RunAs"), "{}", a[3]);
        let src = include_str!("updater.rs");
        let no_s = ["'/", "S'"].concat();
        assert!(!src.contains(&no_s) && !src.contains(&["\"/", "S\""].concat()), "no /S anywhere in the updater");
    }

    #[test]
    fn https_only_except_loopback_in_test_runs() {
        let strict = Net { allow_loopback_http: false };
        let test = Net { allow_loopback_http: true };
        assert!(strict.check("https://api.github.com/x").is_ok());
        assert!(strict.check("http://127.0.0.1:1/x").is_err());
        assert!(test.check("http://127.0.0.1:1/x").is_ok());
        assert!(test.check("http://localhost:1/x").is_ok());
        assert!(test.check("http://example.com/x").is_err());
        assert!(test.check("ftp://127.0.0.1/x").is_err());
        assert!(test.check("file:///C:/x").is_err());
    }

    // ---- a localhost mock of the GitHub API and its asset CDN --------------

    struct Mock {
        base: String,
    }

    const PAYLOAD: &[u8] = b"MZ this is not an installer, it is a test payload that must never run";

    fn digest_of(b: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(b);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Serves until the test process ends. Routes:
    ///   /latest/<tag>/<digest-mode>  release JSON (digest-mode: good|bad|none)
    ///   /asset                       302 -> /cdn/file (GitHub redirects too)
    ///   /cdn/file                    the payload
    ///   /fail                        500
    fn mock() -> Mock {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let b2 = base.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let base = b2.clone();
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
                    let send = |s: &mut std::net::TcpStream, status: &str, extra: &str, body: &[u8]| {
                        let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len());
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(body);
                    };
                    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
                    match parts.as_slice() {
                        ["latest", tag, mode] => {
                            let digest = match *mode {
                                "good" => format!("sha256:{}", digest_of(PAYLOAD)),
                                "bad" => format!("sha256:{}", digest_of(b"something else")),
                                _ => String::new(),
                            };
                            let body = json!({
                                "tag_name": tag, "name": format!("MIDI Studio {tag}"), "body": "notes",
                                "html_url": format!("{base}/release"),
                                "assets": [
                                    {"name": format!("MIDI-Studio-{}-portable.exe", tag.trim_start_matches('v')), "browser_download_url": format!("{base}/nope"), "size": 1},
                                    {"name": format!("MIDI-Studio-{}-Setup.exe", tag.trim_start_matches('v')), "browser_download_url": format!("{base}/asset"),
                                     "size": PAYLOAD.len(), "digest": digest},
                                ],
                            });
                            send(&mut s, "200 OK", "Content-Type: application/json\r\n", body.to_string().as_bytes());
                        }
                        ["asset"] => send(&mut s, "302 Found", &format!("Location: {base}/cdn/file\r\n"), b""),
                        ["cdn", "file"] => send(&mut s, "200 OK", "Content-Type: application/octet-stream\r\n", PAYLOAD),
                        _ => send(&mut s, "500 Internal Server Error", "", b"no"),
                    }
                });
            }
        });
        Mock { base }
    }

    fn collect() -> (Arc<Mutex<Vec<Value>>>, impl Fn(Value)) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l2 = log.clone();
        (log, move |v: Value| l2.lock().unwrap().push(v))
    }

    fn states(log: &Arc<Mutex<Vec<Value>>>) -> Vec<String> {
        log.lock().unwrap().iter().map(|v| v["state"].as_str().unwrap_or("").to_string()).collect()
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("midi-studio-updater-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    const NET: Net = Net { allow_loopback_http: true };

    #[test]
    fn mock_up_to_date() {
        let m = mock();
        let (log, send) = collect();
        let s = check(&NET, &format!("{}/latest/v3.0.1/good", m.base), "3.0.1", true, &send);
        assert!(s.is_none());
        assert_eq!(states(&log), ["checking", "none"]);
        assert_eq!(log.lock().unwrap()[1], json!({"state": "none", "current": "3.0.1", "manual": true}));
        // An automatic check says nothing at all.
        let (log, send) = collect();
        assert!(check(&NET, &format!("{}/latest/v3.0.1/good", m.base), "3.0.1", false, &send).is_none());
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn mock_update_available() {
        let m = mock();
        let (log, send) = collect();
        let s = check(&NET, &format!("{}/latest/v3.1.0/good", m.base), "3.0.1", false, &send).expect("staged");
        assert_eq!(s.version, "3.1.0");
        assert_eq!(s.name, "MIDI-Studio-3.1.0-Setup.exe");
        let v = log.lock().unwrap()[0].clone();
        assert_eq!(v["state"], json!("available"));
        assert_eq!(v["version"], json!("3.1.0"));
        assert_eq!(v["current"], json!("3.0.1"));
        assert_eq!(v["size"], json!(PAYLOAD.len()));
        assert_eq!(v["canSelfUpdate"], json!(true));
    }

    #[test]
    fn mock_download_checksum_pass_stops_before_launch() {
        let m = mock();
        let (_, quiet) = collect();
        let s = check(&NET, &format!("{}/latest/v3.1.0/good", m.base), "3.0.1", true, &quiet).unwrap();
        let dir = scratch("pass");
        let (log, send) = collect();
        let ran = Mutex::new(None);
        let out = apply(&NET, &s, &dir, &send, &|f: &Path| {
            // Record what WOULD run. Nothing is launched.
            *ran.lock().unwrap() = Some(installer_command(f, false));
            Ok(json!({"recorded": true}))
        });
        assert!(matches!(out, Outcome::Launched(_)));
        let file = dir.join("MIDI-Studio-3.1.0-Setup.exe");
        assert_eq!(std::fs::read(&file).unwrap(), PAYLOAD, "followed the redirect to the payload");
        assert_eq!(sha256_file(&file).unwrap(), digest_of(PAYLOAD));
        let st = states(&log);
        assert_eq!(st.first().map(String::as_str), Some("downloading"));
        assert_eq!(&st[st.len() - 2..], ["verifying", "ready"]);
        assert!(log.lock().unwrap().iter().any(|v| v["percent"] == json!(100)));
        let (program, args) = ran.lock().unwrap().clone().unwrap();
        assert_eq!(program, "powershell.exe");
        assert_eq!(args[3], format!("Start-Process -FilePath '{}'", file.display()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mock_checksum_fail_never_launches() {
        let m = mock();
        let (_, quiet) = collect();
        let s = check(&NET, &format!("{}/latest/v3.1.0/bad", m.base), "3.0.1", true, &quiet).unwrap();
        let dir = scratch("fail");
        let (log, send) = collect();
        let out = apply(&NET, &s, &dir, &send, &|_: &Path| panic!("must not launch on a checksum mismatch"));
        match out {
            Outcome::Failed(e, None) => assert!(e.contains("Checksum mismatch"), "{e}"),
            _ => panic!("expected a checksum failure"),
        }
        assert!(!dir.join("MIDI-Studio-3.1.0-Setup.exe").exists(), "the bad download is removed");
        assert!(!states(&log).contains(&"ready".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mock_no_digest_sends_to_release_page() {
        let m = mock();
        let (_, quiet) = collect();
        let s = check(&NET, &format!("{}/latest/v3.1.0/none", m.base), "3.0.1", true, &quiet).unwrap();
        let dir = scratch("none");
        let (log, send) = collect();
        let out = apply(&NET, &s, &dir, &send, &|_: &Path| panic!("must not launch without a digest"));
        assert!(matches!(out, Outcome::Manual));
        assert_eq!(log.lock().unwrap().last().unwrap()["reason"], json!("no-digest"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mock_server_error_is_reported_only_when_asked() {
        let m = mock();
        let (log, send) = collect();
        assert!(check(&NET, &format!("{}/fail", m.base), "3.0.1", true, &send).is_none());
        assert_eq!(log.lock().unwrap()[1], json!({"state": "error", "message": "GitHub API HTTP 500", "manual": true}));
        // A strict client refuses the mock outright.
        let (log, send) = collect();
        check(&Net { allow_loopback_http: false }, &format!("{}/latest/v3.1.0/good", m.base), "3.0.1", true, &send);
        assert!(log.lock().unwrap()[1]["message"].as_str().unwrap().starts_with("Refusing non-HTTPS URL"));
    }
}
