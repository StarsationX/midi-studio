//! Saves the MIDI response delivered to MuseScore's public piano player.
//! This observes an anonymous browser response; it never reads or replays
//! authorization headers, cookies, tokens, or the site's download API.
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_2, ICoreWebView2_4, ICoreWebView2_8, COREWEBVIEW2_PERMISSION_STATE_DENY};
use webview2_com::{DownloadStartingEventHandler, PermissionRequestedEventHandler, WebResourceResponseReceivedEventHandler, WebResourceResponseViewGetContentCompletedHandler};
use windows::core::{Interface, PWSTR};
use windows::Win32::System::Com::{CoTaskMemFree, IStream};

use super::runner::Emit;

const MAX_MIDI_BYTES: usize = 16 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 90;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn is_musescore(value: &str) -> bool {
    Url::parse(value).ok().and_then(|u| u.host_str().map(|s| s.trim_end_matches('.').to_lowercase()))
        .is_some_and(|h| h == "musescore.com" || h.ends_with(".musescore.com"))
}

fn player_url(value: &str) -> Result<(Url, String), String> {
    let u = Url::parse(value).map_err(|_| "Enter a valid MuseScore score URL.")?;
    let host = u.host_str().unwrap_or("").trim_end_matches('.');
    if !matches!(u.scheme(), "https" | "http") || !matches!(host, "musescore.com" | "www.musescore.com")
        || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return Err("Enter a public musescore.com score URL.".into());
    }
    let parts = u.path().trim_matches('/').split('/').collect::<Vec<_>>();
    let (prefix, id) = match parts.as_slice() {
        ["user", user, "scores", id] | ["user", user, "scores", id, "piano-tutorial"]
            if user.chars().all(|c| c.is_ascii_digit()) => (format!("user/{user}/scores"), *id),
        [name, "scores", id] | [name, "scores", id, "piano-tutorial"] => (format!("{name}/scores"), *id),
        _ => return Err("Use a MuseScore link containing /scores/ and the score number.".into()),
    };
    if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("The MuseScore URL has no valid score number.".into());
    }
    let url = Url::parse(&format!("https://musescore.com/{prefix}/{id}/piano-tutorial")).map_err(|e| e.to_string())?;
    Ok((url, id.into()))
}

fn midi_response_url(value: &str) -> bool {
    let Ok(u) = Url::parse(value) else { return false };
    let host = u.host_str().unwrap_or("");
    u.scheme() == "https" && (host == "musescore.com" || host.ends_with(".musescore.com")
        || host == "cdn.ustatik.com" || host == "s3.ultimate-guitar.com")
        && u.path().contains("scoredata/") && u.path().to_ascii_lowercase().ends_with("/score.mid")
}

fn validate_midi(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_MIDI_BYTES || !bytes.starts_with(b"MThd") {
        return Err("The public player did not return a valid MIDI file.".into());
    }
    let smf = midly::Smf::parse(bytes).map_err(|_| "The public player returned an unreadable MIDI file.")?;
    if smf.tracks.is_empty() || !smf.tracks.iter().flatten().any(|e| matches!(e.kind,
        midly::TrackEventKind::Midi { message: midly::MidiMessage::NoteOn { vel, .. }, .. } if vel.as_int() > 0)) {
        return Err("The player MIDI contains no notes.".into());
    }
    Ok(())
}

fn filename(title: &str, id: &str) -> String {
    let title = title.split(" | MuseScore").next().unwrap_or(title)
        .trim_end_matches(" - piano tutorial").trim();
    let safe: String = title.chars().filter(|c| !c.is_control()).map(|c|
        if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c }).take(110).collect();
    let safe = safe.trim().trim_end_matches(['.', ' ']);
    if safe.is_empty() { format!("MuseScore {id}.mid") } else { format!("{safe} [{id}].mid") }
}

fn save_midi(out: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    validate_midi(bytes)?;
    std::fs::create_dir_all(out).map_err(|e| format!("Could not create the output folder: {e}"))?;
    let stem = name.strip_suffix(".mid").unwrap_or(name);
    for n in 1..=10000 {
        let path = out.join(if n == 1 { name.into() } else { format!("{stem} ({n}).mid") });
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|_| file.flush()) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Could not save the MIDI: {e}"));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not save the MIDI: {e}")),
        }
    }
    Err("Too many MIDI files with this name in the output folder.".into())
}

struct Job {
    id: String,
    label: String,
    score_id: String,
    out: PathBuf,
    title: Mutex<String>,
    done: AtomicBool,
    reading: AtomicBool,
}

pub struct MuseScore {
    app: AppHandle,
    emit: Emit,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    seq: AtomicU64,
}

impl MuseScore {
    pub fn new(app: &AppHandle, emit: Emit) -> Arc<Self> {
        Arc::new(Self { app: app.clone(), emit, jobs: Mutex::new(HashMap::new()), seq: AtomicU64::new(0) })
    }

    pub fn is_running(&self) -> bool { !lock(&self.jobs).is_empty() }

    pub fn start(self: &Arc<Self>, value: &str, out: PathBuf) -> String {
        let id = format!("yt-ms-{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1);
        let parsed = player_url(value);
        let job = Arc::new(Job { label: id.clone(), id: id.clone(), score_id: parsed.as_ref().map(|(_, id)| id.clone()).unwrap_or_default(),
            out, title: Mutex::new(String::new()), done: AtomicBool::new(false), reading: AtomicBool::new(false) });
        lock(&self.jobs).insert(id.clone(), job.clone());
        let me = self.clone();
        std::thread::spawn(move || {
            // Deliver the job id before progress/error reaches the renderer.
            std::thread::sleep(Duration::from_millis(50));
            let url = match parsed { Ok((url, _)) => url, Err(e) => { me.finish(&job, Err(e)); return } };
            if job.done.load(Ordering::SeqCst) { return; }
            (me.emit)(json!({"event":"forge.progress","jobId":job.id,"stage":"Download","percent":-1,"message":"Loading MuseScore's public MIDI player…"}));
            if let Err(e) = me.open_player(&job, url) { me.finish(&job, Err(e)); return; }
            for _ in 0..TIMEOUT_SECS {
                std::thread::sleep(Duration::from_secs(1));
                if job.done.load(Ordering::SeqCst) { return; }
            }
            me.finish(&job, Err("MuseScore's public player did not deliver a MIDI file. It may be unavailable or the site may have blocked this browser request. No MIDI was saved.".into()));
        });
        id
    }

    fn open_player(self: &Arc<Self>, job: &Arc<Job>, url: Url) -> Result<(), String> {
        let title_job = job.clone();
        let window = WebviewWindowBuilder::new(&self.app, &job.label, WebviewUrl::External(Url::parse("about:blank").unwrap()))
            .title("Downloading MuseScore MIDI")
            .inner_size(1100.0, 760.0).visible(false).focused(false).skip_taskbar(true)
            .incognito(true).additional_browser_args(&crate::browser_args())
            .on_navigation(|url| url.as_str() == "about:blank" || (url.scheme() == "https" && matches!(url.host_str(), Some("musescore.com" | "www.musescore.com"))))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_document_title_changed(move |_, title| { *lock(&title_job.title) = title; })
            .build().map_err(|e| format!("Could not start the public MIDI player: {e}"))?;
        if job.done.load(Ordering::SeqCst) { let _ = window.close(); return Ok(()); }
        let me = self.clone();
        let close_job = job.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) { me.finish(&close_job, Err("cancelled".into())); }
        });
        let me = self.clone();
        let observe_job = job.clone();
        let navigate_window = window.clone();
        window.with_webview(move |platform| {
            let setup = unsafe {
                (|| -> windows::core::Result<()> {
                    let core = platform.controller().CoreWebView2()?;
                    core.cast::<ICoreWebView2_8>()?.SetIsMuted(true)?;
                    let settings = core.Settings()?;
                    settings.SetIsWebMessageEnabled(false)?;
                    settings.SetAreHostObjectsAllowed(false)?;
                    let mut permission_token = 0;
                    core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; }
                        Ok(())
                    })), &mut permission_token)?;
                    let mut download_token = 0;
                    core.cast::<ICoreWebView2_4>()?.add_DownloadStarting(&DownloadStartingEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args { args.SetCancel(true)?; }
                        Ok(())
                    })), &mut download_token)?;
                    let core2: ICoreWebView2_2 = core.cast()?;
                    let callback_me = me.clone();
                    let callback_job = observe_job.clone();
                    let handler = WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                        if callback_job.done.load(Ordering::SeqCst) { return Ok(()); }
                        let Some(args) = args else { return Ok(()) };
                        let request = args.Request()?;
                        let mut raw = PWSTR::null();
                        request.Uri(&mut raw)?;
                        let uri = raw.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(raw.as_ptr().cast()));
                        if !midi_response_url(&uri) { return Ok(()); }
                        let response = args.Response()?;
                        let mut status = 0;
                        response.StatusCode(&mut status)?;
                        if status != 200 || callback_job.reading.swap(true, Ordering::SeqCst) { return Ok(()); }
                        let body_me = callback_me.clone();
                        let body_job = callback_job.clone();
                        let read = WebResourceResponseViewGetContentCompletedHandler::create(Box::new(move |result, stream| {
                            let body = result.map_err(|e| e.to_string()).and_then(|_| stream.ok_or_else(|| "The MIDI response had no content.".into()))
                                .and_then(|stream| read_stream(&stream));
                            let me = body_me.clone();
                            let job = body_job.clone();
                            std::thread::spawn(move || me.finish(&job, body));
                            Ok(())
                        }));
                        if let Err(e) = response.GetContent(&read) { callback_me.finish(&callback_job, Err(format!("Could not read the player MIDI: {e}"))); }
                        Ok(())
                    }));
                    let mut token = 0;
                    core2.add_WebResourceResponseReceived(&handler, &mut token)?;
                    Ok(())
                })()
            };
            match setup {
                Ok(()) => { if let Err(e) = navigate_window.navigate(url) { me.finish(&observe_job, Err(format!("Could not load the public player: {e}"))); } }
                Err(e) => me.finish(&observe_job, Err(format!("Could not observe the public player: {e}"))),
            }
        }).map_err(|e| format!("Could not observe the public player: {e}"))?;
        Ok(())
    }

    fn finish(&self, job: &Job, result: Result<Vec<u8>, String>) {
        if job.done.swap(true, Ordering::SeqCst) { return; }
        let result = result.and_then(|bytes| save_midi(&job.out, &filename(&lock(&job.title), &job.score_id), &bytes));
        lock(&self.jobs).remove(&job.id);
        let app = self.app.clone();
        let label = job.label.clone();
        let _ = self.app.run_on_main_thread(move || { if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } });
        match result {
            Ok(path) => {
                crate::allow_dir(&self.app, &job.out);
                crate::Host::push(&self.app, "library-changed", json!(job.out.to_string_lossy()));
                (self.emit)(json!({"event":"forge.progress","jobId":job.id,"stage":"Done","percent":100,"message":"Original player MIDI saved"}));
                (self.emit)(json!({"event":"forge.done","jobId":job.id,"ok":true,"result":{"downloadedPath":path.to_string_lossy(),"source":"musescore-player","scoreId":job.score_id}}));
            }
            Err(error) => (self.emit)(json!({"event":"forge.done","jobId":job.id,"ok":false,"error":error})),
        }
    }

    pub fn cancel(&self, id: &str) -> bool {
        let job = lock(&self.jobs).get(id).cloned();
        if let Some(job) = job { self.finish(&job, Err("cancelled".into())); true } else { false }
    }

    pub fn cancel_all(&self) {
        let ids = lock(&self.jobs).keys().cloned().collect::<Vec<_>>();
        for id in ids { self.cancel(&id); }
    }
}

unsafe fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        let mut count = 0;
        stream.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut count)).ok().map_err(|e| format!("Could not read the MIDI response: {e}"))?;
        if count == 0 { return Ok(bytes); }
        if bytes.len() + count as usize > MAX_MIDI_BYTES { return Err("The player MIDI exceeds the 16 MB download limit.".into()); }
        bytes.extend_from_slice(&chunk[..count as usize]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MIDI: &[u8] = b"MThd\0\0\0\x06\0\0\0\x01\x01\xe0MTrk\0\0\0\x0c\0\x90\x3c\x64\x60\x80\x3c\0\0\xff\x2f\0";

    #[test]
    fn public_player_urls_are_canonical_and_bounded() {
        let (url, id) = player_url("https://musescore.com/user/40298614/scores/38165006?tracking=1#x").unwrap();
        assert_eq!(id, "38165006");
        assert_eq!(url.as_str(), "https://musescore.com/user/40298614/scores/38165006/piano-tutorial");
        assert!(player_url("http://www.musescore.com/author/scores/123/piano-tutorial").is_ok());
        for input in ["https://musescore.com.evil.test/user/1/scores/2", "https://user:secret@musescore.com/user/1/scores/2", "file://musescore.com/user/1/scores/2", "https://musescore.com/user/1/scores/x", "https://musescore.com/api/jmuse?id=2"] {
            assert!(player_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn only_player_midi_responses_are_candidates() {
        assert!(midi_response_url("https://s3w.musescore.com/musescore.scoredata/g/example/score.mid?signature=x"));
        assert!(!midi_response_url("https://musescore.com/api/jmuse?id=1&type=midi"));
        assert!(!midi_response_url("https://musescore.com.evil.test/scoredata/g/x/score.mid"));
        assert!(!midi_response_url("http://musescore.com/scoredata/g/x/score.mid"));
    }

    #[test]
    fn validates_real_midi_and_keeps_exact_bytes() {
        assert!(validate_midi(MIDI).is_ok());
        assert!(validate_midi(b"<html>denied</html>").is_err());
        assert!(validate_midi(b"MThdinvalid").is_err());
        let out = std::env::temp_dir().join(format!("musescore-save-{}", std::process::id()));
        std::fs::create_dir_all(&out).unwrap();
        let first = save_midi(&out, "Score.mid", MIDI).unwrap();
        let next = save_midi(&out, "Score.mid", MIDI).unwrap();
        assert_ne!(first, next);
        assert_eq!(std::fs::read(&first).unwrap(), MIDI);
        assert_eq!(std::fs::read(&next).unwrap(), MIDI);
        std::fs::remove_file(first).unwrap(); std::fs::remove_file(next).unwrap();
        let _ = std::fs::remove_dir(out);
    }

    #[test]
    fn title_cannot_escape_output_folder() {
        assert_eq!(filename("../../song: title | MuseScore.com", "123"), ".._.._song_ title [123].mid");
        assert_eq!(filename("", "123"), "MuseScore 123.mid");
        assert!(filename(&"x".repeat(500), "123").len() < 140);
    }
}
