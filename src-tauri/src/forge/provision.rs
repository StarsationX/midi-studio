// provision.rs: electron/forge-provisioner.js.
//
// Electron ran provision_forge.py under the LIGHT player Python it shipped.
// This host ships no Python at all, so the one step that needed an
// interpreter to exist already, the embeddable Python and its pip, is done
// here instead, and provision_forge.py then runs, unchanged, under the env's
// own interpreter (stdlib only, which the embeddable distribution has):
//
//   1. python-3.13.5-embed-amd64.zip from python.org (~11 MB) into
//      <env>\python, `import site` switched on in its ._pth;
//   2. get-pip.py, run by that interpreter;
//   3. provision_forge.py, which finds the Python present, skips its own
//      ensure_python, and does torch, the packages, MSST, the model, verify.
//
// The MSTEP/MLOG/MDONE/MFAIL protocol, the log tee and the "still working"
// watchdog are forge-provisioner.js's.
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::fpaths::EnvMap;
use super::runner::{Emit, Log, Pump};
use super::winjob::{self, Job};

/// Keep in step with PYVER / GETPIP_URL in provision_forge.py (a test checks).
pub const PYVER: &str = "3.13.5";
pub fn embed_url() -> String {
    format!("https://www.python.org/ftp/python/{PYVER}/python-{PYVER}-embed-amd64.zip")
}
pub const GETPIP_URL: &str = "https://bootstrap.pypa.io/get-pip.py";

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One protocol line as a forge:status payload, and the step it names.
pub fn protocol_event(line: &str) -> (Option<Value>, Option<String>) {
    if let Some(rest) = line.strip_prefix("MSTEP|") {
        let p: Vec<&str> = rest.splitn(3, '|').collect();
        if p.len() != 3 {
            return (None, None);
        }
        let pct = js_parse_int(p[0]).unwrap_or(-1);
        return (Some(json!({"event": "forge.provision.progress", "percent": pct, "step": p[1], "message": p[2]})), Some(p[1].to_string()));
    }
    if let Some(rest) = line.strip_prefix("MLOG|") {
        return (Some(json!({"event": "forge.provision.log", "line": rest})), None);
    }
    if line.starts_with("MDONE|") {
        return (Some(json!({"event": "forge.provision.done"})), None);
    }
    if let Some(rest) = line.strip_prefix("MFAIL|") {
        return (Some(json!({"event": "forge.provision.error", "message": rest})), None);
    }
    (Some(json!({"event": "forge.provision.log", "line": line})), None)
}

/// parseInt: leading whitespace, a sign, then as many digits as there are.
fn js_parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let (neg, digits) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let n: String = digits.chars().take_while(char::is_ascii_digit).collect();
    let v: i64 = n.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// ISO 8601 UTC, for the log header (no date crate for one line).
pub fn iso_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// What one setup run needs. The closures run on the setup thread: the
/// fallback records a different folder in the settings, and the env is read
/// after it so the script sees the folder actually in use.
pub struct StartReq {
    pub env_dir: PathBuf,
    pub fallback_dir: PathBuf,
    pub engine_dir: PathBuf,
    pub log_path: PathBuf,
    pub on_fallback: Box<dyn FnOnce(&Path) + Send>,
    pub child_env: Box<dyn FnOnce() -> EnvMap + Send>,
}

#[derive(Default)]
struct RunState {
    cancelled: Arc<AtomicBool>,
    job: Mutex<Option<Arc<Job>>>,
}

type Tee = Arc<Mutex<Option<BufWriter<File>>>>;

pub struct Provisioner {
    emit: Emit,
    log: Log,
    run: Mutex<Option<Arc<RunState>>>,
    /// Silence longer than this gets a "still working" line.
    quiet: Duration,
}

impl Provisioner {
    pub fn new(emit: Emit, log: Log) -> Arc<Provisioner> {
        let quiet = std::env::var("MIDI_STUDIO_FORGE_WATCHDOG_MS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map_or(Duration::from_secs(45), Duration::from_millis);
        Provisioner::with_quiet(emit, log, quiet)
    }

    pub fn with_quiet(emit: Emit, log: Log, quiet: Duration) -> Arc<Provisioner> {
        Arc::new(Provisioner { emit, log, run: Mutex::new(None), quiet })
    }

    pub fn is_running(&self) -> bool {
        lock(&self.run).is_some()
    }

    pub fn cancel(&self) {
        let Some(r) = lock(&self.run).clone() else { return };
        r.cancelled.store(true, Ordering::SeqCst);
        let job = lock(&r.job).clone();
        if let Some(j) = job {
            j.terminate();
        }
    }

    pub fn start(self: &Arc<Self>, req: StartReq) {
        let state = {
            let mut run = lock(&self.run);
            if run.is_some() {
                drop(run);
                (self.emit)(json!({"event": "forge.provision.log", "line": "Setup is already running."}));
                return;
            }
            let s = Arc::new(RunState::default());
            *run = Some(s.clone());
            s
        };
        let me = self.clone();
        std::thread::Builder::new()
            .name("forge-setup".into())
            .spawn(move || {
                me.run_setup(req, &state);
                *lock(&me.run) = None;
            })
            .ok();
    }

    fn run_setup(self: &Arc<Self>, req: StartReq, st: &Arc<RunState>) {
        // The log first: everything below can fail, and when it did there was
        // nothing anywhere to say why.
        let log_path = req.log_path.clone();
        let tee: Tee = Arc::new(Mutex::new(
            log_path.parent().and_then(|d| std::fs::create_dir_all(d).ok()).and_then(|()| File::create(&log_path).ok()).map(BufWriter::new),
        ));
        if let Some(w) = lock(&tee).as_mut() {
            let _ = writeln!(w, "=== Midi Forge setup log, {} ===", iso_now());
        }
        let emit = self.emit.clone();
        let say = {
            let (tee, emit) = (tee.clone(), emit.clone());
            move |line: &str| {
                if let Some(w) = lock(&tee).as_mut() {
                    let _ = writeln!(w, "{line}");
                }
                emit(json!({"event": "forge.provision.log", "line": line}));
            }
        };
        let fail = |message: &str| {
            say(&format!("FAILED before start: {message}"));
            if let Some(mut w) = lock(&tee).take() {
                let _ = w.flush();
            }
            emit(json!({"event": "forge.provision.error", "message": message, "logPath": log_path.to_string_lossy()}));
        };
        let cancelled = || st.cancelled.load(Ordering::SeqCst);

        let mut env_dir = req.env_dir.clone();
        say(&format!("log file: {}", log_path.display()));
        say(&format!("install target: {}", env_dir.display()));
        if let Err(e) = super::storage::mark_managed(&env_dir) {
            // A drive root needs administrator rights on most machines, and that
            // is the default when the app is installed off C:. Fall back to the
            // user profile rather than dead-ending.
            say(&format!("cannot write {}: {e}", env_dir.display()));
            match super::storage::mark_managed(&req.fallback_dir) {
                Ok(_) => {
                    (req.on_fallback)(&req.fallback_dir);
                    say(&format!("using {} instead, change it in Settings if you want another drive", req.fallback_dir.display()));
                    env_dir = req.fallback_dir.clone();
                }
                Err(e2) => {
                    return fail(&format!(
                        "Cannot create the Forge folder at {} ({e}) or at {} ({e2}). Pick another folder with \"Change folder…\".",
                        env_dir.display(),
                        req.fallback_dir.display()
                    ));
                }
            }
        }
        let env = (req.child_env)();
        let py = env_dir.join("python").join("python.exe");
        say(&format!(
            "launcher: {}{}",
            py.display(),
            if py.exists() { "" } else { " (embedded Python, set up by MIDI Studio first)" }
        ));
        (self.emit)(json!({"event": "forge.provision.progress", "percent": 0, "step": "Start", "message": "Setting up Midi Forge…"}));

        let last_output = Arc::new(Mutex::new((Instant::now(), "Preparing".to_string())));
        let watchdog_stop = Arc::new(AtomicBool::new(false));
        self.watchdog(last_output.clone(), watchdog_stop.clone());
        let stop_watchdog = || watchdog_stop.store(true, Ordering::SeqCst);

        if let Err(e) = self.bootstrap(&env_dir, &env, st, &say, &last_output) {
            stop_watchdog();
            if cancelled() {
                if let Some(mut w) = lock(&tee).take() {
                    let _ = write!(w, "\n=== bootstrap cancelled ===\n");
                    let _ = w.flush();
                }
                return (self.emit)(json!({"event": "forge.provision.error", "message": "Setup cancelled."}));
            }
            return fail(&e);
        }

        let script = req.engine_dir.join("provision_forge.py");
        let mut cmd = Command::new(&py);
        cmd.arg(&script).current_dir(&req.engine_dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        env.apply(&mut cmd);
        let code = self.run_streaming(cmd, st, &tee, &last_output, &|line: &str| {
            let (ev, step) = protocol_event(line);
            if let Some(s) = step {
                lock(&last_output).1 = s;
            }
            if let Some(ev) = ev {
                (self.emit)(ev);
            }
        });
        stop_watchdog();
        let code = match code {
            Ok(c) => c,
            Err(e) => return fail(&format!("Couldn't start setup: {e}")),
        };
        let was_cancelled = cancelled();
        if let Some(mut w) = lock(&tee).take() {
            let _ = write!(w, "\n=== exited code={} cancelled={was_cancelled} ===\n", code.map_or("null".into(), |c| c.to_string()));
            let _ = w.flush();
        }
        (self.log)(&format!("forge setup exited code={code:?} cancelled={was_cancelled}"));
        if was_cancelled {
            (self.emit)(json!({"event": "forge.provision.error", "message": "Setup cancelled."}));
        } else if code != Some(0) {
            (self.emit)(json!({
                "event": "forge.provision.error",
                "message": format!("Setup failed (exit {}). Full log: {}", code.map_or("null".into(), |c| c.to_string()), log_path.display()),
                "logPath": log_path.to_string_lossy(),
            }));
        }
        // Success was already said by MDONE.
    }

    fn watchdog(self: &Arc<Self>, last: Arc<Mutex<(Instant, String)>>, stop: Arc<AtomicBool>) {
        let (emit, quiet) = (self.emit.clone(), self.quiet);
        let tick = (quiet / 3).max(Duration::from_millis(100));
        std::thread::spawn(move || loop {
            std::thread::sleep(tick);
            if stop.load(Ordering::SeqCst) {
                return;
            }
            let mut l = lock(&last);
            let q = l.0.elapsed().as_secs_f64().round() as u64;
            if l.0.elapsed() >= quiet {
                emit(json!({"event": "forge.provision.log", "line": format!(
                    "still working, {} has been running for {}m {}s with no output. Downloads print only when they finish.",
                    l.1, q / 60, q % 60
                )}));
                l.0 = Instant::now();
            }
        });
    }

    /// Run a setup child in its own job, teeing raw output to the log and
    /// handing each line to `on_line`. Returns the exit code.
    fn run_streaming(&self, mut cmd: Command, st: &Arc<RunState>, tee: &Tee, last: &Arc<Mutex<(Instant, String)>>, on_line: &(dyn Fn(&str) + Sync)) -> std::io::Result<Option<i32>> {
        let job = Arc::new(Job::new(winjob::mem_limit())?);
        let (mut child, _) = winjob::spawn_in_job(&mut cmd, &job, false)?;
        *lock(&st.job) = Some(job.clone());
        if st.cancelled.load(Ordering::SeqCst) {
            job.terminate();
        }
        let outs: Vec<Box<dyn Read + Send>> = [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .collect();
        std::thread::scope(|s| {
            for mut r in outs {
                s.spawn(move || {
                    let mut pump = Pump::default();
                    let mut buf = [0u8; 8192];
                    let mut handle = |line: &str| {
                        lock(last).0 = Instant::now();
                        on_line(line);
                    };
                    loop {
                        match r.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if let Some(w) = lock(tee).as_mut() {
                                    let _ = w.write_all(&buf[..n]);
                                }
                                pump.feed(&buf[..n], &mut handle);
                            }
                        }
                    }
                    pump.finish(&mut handle);
                });
            }
        });
        let code = child.wait()?.code();
        *lock(&st.job) = None;
        Ok(code)
    }

    fn step(&self, pct: i64, step: &str, msg: &str) {
        (self.emit)(json!({"event": "forge.provision.progress", "percent": pct, "step": step, "message": msg}));
    }

    /// Steps 1 and 2 of setup: the embeddable interpreter and its pip. Each is
    /// skipped when already done, so an interrupted setup resumes.
    fn bootstrap(&self, env_dir: &Path, env: &EnvMap, st: &Arc<RunState>, say: &(dyn Fn(&str) + Sync), last: &Arc<Mutex<(Instant, String)>>) -> Result<(), String> {
        let pdir = env_dir.join("python");
        let py = pdir.join("python.exe");
        let cancelled = || st.cancelled.load(Ordering::SeqCst);
        if !py.exists() {
            lock(last).1 = "Python".into();
            self.step(2, "Python", "Downloading embedded Python…");
            let zip = env_dir.join("python-embed.zip");
            download(&embed_url(), &zip, "Python", &cancelled, &|line: &str, pct: Option<i64>| {
                lock(last).0 = Instant::now();
                match pct {
                    Some(_) => self.step(-1, "Python", line),
                    None => say(line),
                }
            })?;
            let extracted = (|| -> Result<(), String> {
                std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
                let f = File::open(&zip).map_err(|e| e.to_string())?;
                zip::ZipArchive::new(f).and_then(|mut a| a.extract(&pdir)).map_err(|e| format!("could not unpack {}: {e}", zip.display()))
            })();
            let _ = std::fs::remove_file(&zip);
            extracted?;
            enable_site(&pdir).map_err(|e| format!("could not enable site-packages: {e}"))?;
            say(&format!("embedded Python {PYVER} unpacked into {}", pdir.display()));
        }
        if cancelled() {
            return Err("cancelled".into());
        }
        if !pip_present(&pdir) {
            lock(last).1 = "Python".into();
            self.step(4, "Python", "Bootstrapping pip…");
            let gp = pdir.join("get-pip.py");
            download(GETPIP_URL, &gp, "pip", &cancelled, &|line: &str, _| {
                lock(last).0 = Instant::now();
                say(line);
            })?;
            // provision_forge.py's _child_env: pip's cache and temp on the
            // drive the user chose, not on C:.
            let mut env = env.clone();
            for (k, d) in [("PIP_CACHE_DIR", "pip-cache"), ("TMP", "tmp"), ("TEMP", "tmp")] {
                let p = env_dir.join(d);
                let _ = std::fs::create_dir_all(&p);
                env.set(k, &p.to_string_lossy());
            }
            say(&format!("$ {} {} --no-warn-script-location", py.display(), gp.display()));
            let mut cmd = Command::new(&py);
            cmd.arg(&gp).arg("--no-warn-script-location").current_dir(env_dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            env.apply(&mut cmd);
            let tee: Tee = Arc::new(Mutex::new(None));
            let code = self.run_streaming(cmd, st, &tee, last, &|line: &str| say(line)).map_err(|e| format!("could not run get-pip.py: {e}"))?;
            let _ = std::fs::remove_file(&gp);
            if cancelled() {
                return Err("cancelled".into());
            }
            if code != Some(0) || !pip_present(&pdir) {
                return Err(format!("get-pip.py failed (exit {})", code.map_or("null".into(), |c| c.to_string())));
            }
        }
        Ok(())
    }
}

pub fn pip_present(pdir: &Path) -> bool {
    pdir.join("Lib").join("site-packages").join("pip").is_dir()
}

/// The embeddable distribution ships with `#import site` in its ._pth, which
/// leaves site-packages (and so everything pip installs) off sys.path.
pub fn enable_site(pdir: &Path) -> std::io::Result<()> {
    for e in std::fs::read_dir(pdir)?.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("python") && name.ends_with("._pth") {
            let t = std::fs::read_to_string(e.path())?;
            std::fs::write(e.path(), t.replace("#import site", "import site"))?;
        }
    }
    Ok(())
}

/// provision_forge.py _download: progress as it goes, a heartbeat every 4 MB
/// when the size is unknown. `report(line, Some(pct))` for the bar,
/// `report(line, None)` for the log.
pub fn download(url: &str, dest: &Path, label: &str, cancelled: &dyn Fn() -> bool, report: &dyn Fn(&str, Option<i64>)) -> Result<(), String> {
    report(&format!("download {url}"), None);
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // https only, over the OS's own TLS (schannel), as the updater does.
    if !url.starts_with("https://") {
        return Err(format!("refusing a non-https download: {url}"));
    }
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("TLS unavailable: {e}"))?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(Arc::new(tls))
        .https_only(true)
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent.get(url).set("User-Agent", "midi-studio-provisioner").call().map_err(|e| format!("download failed: {url}: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut out = BufWriter::new(File::create(&part).map_err(|e| e.to_string())?);
    let mut r = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let (mut read, mut last, mut beat) = (0u64, -1i64, 0f64);
    loop {
        if cancelled() {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("cancelled".into());
        }
        let n = r.read(&mut buf).map_err(|e| format!("download failed: {url}: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        read += n as u64;
        let mb = read as f64 / 1_048_576.0;
        if let Some(pct) = (read * 100).checked_div(total).map(|p| p as i64) {
            if pct != last {
                report(&format!("{label} {pct}% ({mb:.0} MB)"), Some(pct));
                last = pct;
            }
        }
        if mb - beat >= 4.0 {
            beat = mb;
            report(&format!("{label} {mb:.0} MB"), None);
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    report(&format!("{label} downloaded ({:.0} MB)", read as f64 / 1_048_576.0), None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_lines() {
        let (ev, step) = protocol_event("MSTEP|10|Python|Downloading embedded Python…");
        assert_eq!(ev.unwrap(), json!({"event": "forge.provision.progress", "percent": 10, "step": "Python", "message": "Downloading embedded Python…"}));
        assert_eq!(step.as_deref(), Some("Python"));
        let (ev, _) = protocol_event("MSTEP|-1|PyTorch|PyTorch: 1,204 MB written (~21%)");
        assert_eq!(ev.unwrap()["percent"], -1);
        let (ev, _) = protocol_event("MSTEP|x|Verify|Verifying installation…");
        assert_eq!(ev.unwrap()["percent"], -1, "parseInt NaN is indeterminate");
        assert_eq!(protocol_event("MSTEP|5|Start").0, None, "a short MSTEP says nothing");
        assert_eq!(protocol_event("MLOG|[  0.0s] setup starting in D:\\env").0.unwrap(), json!({"event": "forge.provision.log", "line": "[  0.0s] setup starting in D:\\env"}));
        assert_eq!(protocol_event("MDONE|ok").0.unwrap(), json!({"event": "forge.provision.done"}));
        assert_eq!(protocol_event("MFAIL|Not enough free disk on C:\\").0.unwrap(), json!({"event": "forge.provision.error", "message": "Not enough free disk on C:\\"}));
        assert_eq!(protocol_event("Collecting torch==2.11.0").0.unwrap()["line"], "Collecting torch==2.11.0");
        assert_eq!(js_parse_int(" 42abc"), Some(42));
        assert_eq!(js_parse_int("-1"), Some(-1));
        assert_eq!(js_parse_int(""), None);
    }

    #[test]
    fn bootstrap_constants_match_the_script() {
        let script = include_str!("../../../python-engine/provision_forge.py");
        assert!(script.contains(&format!("PYVER = \"{PYVER}\"")), "PYVER drifted from provision_forge.py");
        assert!(script.contains(GETPIP_URL));
        assert!(script.contains("python-{PYVER}-embed-amd64.zip"));
        // The script must still skip its own ensure_python once ours ran.
        assert!(script.contains("if self.py.exists():"));
    }

    #[test]
    fn iso_dates() {
        let s = iso_now();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }

    const FAKE_SCRIPT: &str = r#"import os, sys, time
def emit(l):
    sys.stdout.write(l + "\n"); sys.stdout.flush()
mode = os.environ.get("FAKE_MODE", "ok")
emit("MSTEP|5|Start|Checking your system…")
emit("MLOG|env_dir = " + os.environ.get("MIDI_STUDIO_FORGE_ENV_DIR", "?"))
emit("MLOG|python = " + sys.executable)
for i in range(0, 101, 25):
    sys.stdout.write("Downloading torch-2.11.0-cp313-cp313-win_amd64.whl %d%%\r" % i); sys.stdout.flush()
sys.stdout.write("\n")
sys.stderr.write("WARNING: a warning on stderr\n"); sys.stderr.flush()
emit("MSTEP|-1|PyTorch|Installing PyTorch (CPU build, ~300 MB)…")
if mode == "hang":
    time.sleep(600)
time.sleep(float(os.environ.get("FAKE_QUIET", "0")))
if mode == "fail":
    emit("MFAIL|Not enough free disk on C:\\ for first-time setup")
    sys.exit(1)
emit("MSTEP|100|Done|Midi-Forge is ready.")
emit("MDONE|ok")
"#;

    struct Harness {
        prov: Arc<Provisioner>,
        events: Arc<Mutex<Vec<Value>>>,
    }

    impl Harness {
        fn new(quiet: Duration) -> Harness {
            let events = Arc::new(Mutex::new(Vec::new()));
            let ev = events.clone();
            let prov = Provisioner::with_quiet(Arc::new(move |v| lock(&ev).push(v)), Arc::new(|_| {}), quiet);
            Harness { prov, events }
        }

        fn start(&self, env_dir: &Path, fallback: &Path, engine: &Path, log: &Path, mode: &str, fell_back: Arc<AtomicBool>) {
            lock(&self.events).clear();
            let (mode, env_dir_s) = (mode.to_string(), env_dir.to_path_buf());
            self.prov.start(StartReq {
                env_dir: env_dir.to_path_buf(),
                fallback_dir: fallback.to_path_buf(),
                engine_dir: engine.to_path_buf(),
                log_path: log.to_path_buf(),
                on_fallback: Box::new(move |_| fell_back.store(true, Ordering::SeqCst)),
                child_env: Box::new(move || {
                    let mut e = EnvMap::from_process();
                    e.set("FAKE_MODE", &mode);
                    e.set("FAKE_QUIET", "1.6");
                    e.set("MIDI_STUDIO_FORGE_ENV_DIR", &env_dir_s.to_string_lossy());
                    e
                }),
            });
        }

        fn wait(&self, secs: u64) {
            let t = Instant::now();
            while self.prov.is_running() && t.elapsed() < Duration::from_secs(secs) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!self.prov.is_running(), "setup did not finish in {secs}s");
        }

        fn events(&self) -> Vec<Value> {
            lock(&self.events).clone()
        }

        fn logs(&self) -> Vec<String> {
            self.events().iter().filter(|e| e["event"] == "forge.provision.log").map(|e| e["line"].as_str().unwrap_or("").to_string()).collect()
        }
    }

    /// The whole provisioner against a fake provision_forge.py, with the REAL
    /// bootstrap (python.org embeddable zip ~11 MB + get-pip) into a scratch
    /// folder. Network, so opt-in: cargo test -- --ignored provision_end_to_end
    #[test]
    #[ignore]
    fn provision_end_to_end() {
        let root = std::env::temp_dir().join("ms-forge-provision-e2e");
        let _ = std::fs::remove_dir_all(&root);
        let (env_dir, engine, log) = (root.join("forge-env"), root.join("engine"), root.join("forge-setup.log"));
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::write(engine.join("provision_forge.py"), FAKE_SCRIPT).unwrap();
        let h = Harness::new(Duration::from_millis(500));
        let fell = Arc::new(AtomicBool::new(false));

        // 1. Fresh folder: bootstrap, then the script to MDONE.
        h.start(&env_dir, &root.join("unused"), &engine, &log, "ok", fell.clone());
        h.wait(300);
        let ev = h.events();
        let logs = h.logs();
        let steps: Vec<(i64, String)> =
            ev.iter().filter(|e| e["event"] == "forge.provision.progress" && e["percent"] != -1).map(|e| (e["percent"].as_i64().unwrap(), e["step"].as_str().unwrap().into())).collect();
        assert_eq!(steps, vec![(0, "Start".into()), (2, "Python".into()), (4, "Python".into()), (5, "Start".into()), (100, "Done".into())], "{ev:#?}");
        assert!(logs.iter().any(|l| l.contains("embedded Python 3.13.5 unpacked")), "{logs:#?}");
        assert!(logs.iter().any(|l| l.contains("Successfully installed pip")), "{logs:#?}");
        assert!(logs.iter().any(|l| l.ends_with("50%")), "\\r progress lines stream: {logs:#?}");
        assert!(logs.iter().any(|l| l == "WARNING: a warning on stderr"));
        assert!(logs.iter().any(|l| l == &format!("env_dir = {}", env_dir.display())));
        assert!(logs.iter().any(|l| l.contains(&format!("python = {}", env_dir.join("python").join("python.exe").display()))));
        assert!(logs.iter().any(|l| l.starts_with("still working, PyTorch has been running for")), "watchdog: {logs:#?}");
        assert_eq!(ev.last().unwrap()["event"], "forge.provision.done");
        assert!(!ev.iter().any(|e| e["event"] == "forge.provision.error"));
        assert!(pip_present(&env_dir.join("python")));
        assert!(std::fs::read_to_string(env_dir.join("python").join("python313._pth")).unwrap().contains("\nimport site"));
        assert!(env_dir.join(super::super::storage::MARKER).exists());
        assert!(!env_dir.join("python-embed.zip").exists() && !env_dir.join("python").join("get-pip.py").exists());
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.starts_with("=== Midi Forge setup log, "));
        assert!(text.contains("MDONE|ok") && text.contains("Downloading torch-2.11.0") && text.contains("=== exited code=0 cancelled=false ==="));

        // 2. Already bootstrapped: no Python steps. An unwritable target falls
        //    back to the profile folder; MFAIL then a non-zero exit.
        let free = (b'D'..=b'Z').map(|c| c as char).find(|c| !Path::new(&format!("{c}:\\")).exists()).unwrap();
        let bogus = PathBuf::from(format!("{free}:\\MIDI Studio Forge"));
        h.start(&bogus, &env_dir, &engine, &log, "fail", fell.clone());
        h.wait(60);
        assert!(fell.load(Ordering::SeqCst), "on_fallback ran");
        let ev = h.events();
        assert!(!ev.iter().any(|e| e["step"] == "Python"), "bootstrap skipped: {ev:#?}");
        assert!(h.logs().iter().any(|l| l.starts_with(&format!("using {} instead", env_dir.display()))));
        assert!(ev.iter().any(|e| e["event"] == "forge.provision.error" && e["message"] == "Not enough free disk on C:\\ for first-time setup"));
        let last = ev.last().unwrap();
        assert_eq!(last["message"], json!(format!("Setup failed (exit 1). Full log: {}", log.display())));
        assert_eq!(last["logPath"], json!(log.to_string_lossy()));

        // 3. Cancel a hung setup; a second start while it runs is refused.
        h.start(&env_dir, &root.join("unused"), &engine, &log, "hang", fell.clone());
        std::thread::sleep(Duration::from_millis(1500));
        assert!(h.prov.is_running());
        h.start(&env_dir, &root.join("unused"), &engine, &log, "hang", fell);
        assert!(h.logs().iter().any(|l| l == "Setup is already running."));
        let t = Instant::now();
        h.prov.cancel();
        h.wait(10);
        assert!(t.elapsed() < Duration::from_secs(5));
        assert_eq!(h.events().last().unwrap(), &json!({"event": "forge.provision.error", "message": "Setup cancelled."}));
        assert!(std::fs::read_to_string(&log).unwrap().contains("cancelled=true"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn site_is_enabled() {
        let d = std::env::temp_dir().join(format!("ms-forge-pth-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("python313._pth"), "python313.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n").unwrap();
        enable_site(&d).unwrap();
        let t = std::fs::read_to_string(d.join("python313._pth")).unwrap();
        assert!(t.contains("\nimport site\n") && !t.contains("#import site"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
