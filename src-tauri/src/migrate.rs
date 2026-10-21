// migrate.rs: the Electron build's per-panel localStorage, carried over once.
//
// Settings already live in a file both hosts share. What does not carry over
// on its own is what each panel keeps in localStorage (recent files, the Forge
// queue and results, disclosure and resize state, the skin): Electron served
// the renderer from file://, Tauri from http://tauri.localhost, and storage
// is per origin and per browser profile.
//
// Electron's profile keeps it in %APPDATA%\midi-studio\Local Storage\leveldb.
// That folder is never opened in place: Chromium may be holding it (the old
// app can still be running when the new one first starts) and a leveldb
// writer recovers its log into new files on open. The files are copied to a
// temp folder, the copy is read, and the copy is deleted.
//
// The values reach the new origin through an initialization script on the
// main window, which runs before any page script and so before any panel's
// iframe exists. It only fills keys the new origin does not have yet, and it
// stamps a sentinel key so a reload in the same session does nothing. The
// marker file in user data stops the read on every later launch; it is
// written once the page has painted, so a launch that dies first tries again.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::paths::user_data_dir;

/// Chromium's localStorage keys are `_<storage key>\0<script key>`; a
/// first-party file:// page's storage key serializes as `file://`.
pub const ELECTRON_ORIGIN: &str = "file://";
pub const SENTINEL_KEY: &str = "midi-studio:electron-migrated";
const MARKER: &str = "tauri-localstorage-migrated.json";
/// No single value the renderer writes comes near this; the cap keeps a
/// corrupt or foreign profile from turning into a huge init script.
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// MIDI_STUDIO_ELECTRON_LEVELDB points the read at another folder (a test's
/// copy); otherwise it is the profile next to the shared settings file.
pub fn electron_leveldb_dir() -> PathBuf {
    env_path("MIDI_STUDIO_ELECTRON_LEVELDB").unwrap_or_else(|| user_data_dir().join("Local Storage").join("leveldb"))
}

pub fn marker_file() -> PathBuf {
    user_data_dir().join(MARKER)
}

/// Chromium stores each localStorage string with a one-byte format prefix:
/// 0 = UTF-16LE, 1 = Latin-1.
pub fn decode_chromium_string(b: &[u8]) -> Option<String> {
    let (&tag, rest) = b.split_first()?;
    match tag {
        0 => {
            if rest.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).ok()
        }
        1 => Some(rest.iter().map(|&c| c as char).collect()),
        _ => None,
    }
}

/// One leveldb row, if it is a localStorage entry of `origin`.
pub fn parse_entry(origin: &str, key: &[u8], value: &[u8]) -> Option<(String, String)> {
    let prefix = [b"_".as_slice(), origin.as_bytes(), b"\0"].concat();
    let script_key = key.strip_prefix(prefix.as_slice())?;
    Some((decode_chromium_string(script_key)?, decode_chromium_string(value)?))
}

fn scratch_dir() -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::env::temp_dir().join(format!("midi-studio-ls-migrate-{}-{nanos}", std::process::id()))
}

/// Copy the leveldb files (not LOCK: it is Chromium's, and copying a held
/// lock file can fail) into `dst`.
fn copy_db(src: &Path, dst: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("scratch {}: {e}", dst.display()))?;
    let mut n = 0;
    for e in std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))?.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().eq_ignore_ascii_case("LOCK") || !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        std::fs::copy(e.path(), dst.join(&name)).map_err(|err| format!("copy {}: {err}", name.to_string_lossy()))?;
        n += 1;
    }
    Ok(n)
}

/// Every localStorage key/value `origin` has in the leveldb folder `src`.
/// `src` is only ever read.
pub fn read_origin(src: &Path, origin: &str) -> Result<BTreeMap<String, String>, String> {
    use rusty_leveldb::{LdbIterator, Options, DB};
    if !src.join("CURRENT").is_file() {
        return Err(format!("no leveldb at {}", src.display()));
    }
    let tmp = scratch_dir();
    let result = (|| {
        copy_db(src, &tmp)?;
        let opts = Options { create_if_missing: false, ..Options::default() };
        let mut db = DB::open(&tmp, opts).map_err(|e| format!("open copy: {e}"))?;
        let mut it = db.new_iter().map_err(|e| format!("iterate: {e}"))?;
        let mut out = BTreeMap::new();
        let mut total = 0usize;
        while let Some((k, v)) = it.next() {
            if let Some((key, val)) = parse_entry(origin, &k, &v) {
                total += key.len() + val.len();
                if total > MAX_TOTAL_BYTES {
                    return Err("localStorage larger than expected, not migrating".into());
                }
                out.insert(key, val);
            }
        }
        drop(it);
        drop(db);
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// The main window's initialization script. JSON is valid JS; U+2028/2029
/// are escaped because older engines treat them as line breaks in strings.
pub fn init_script(entries: &BTreeMap<String, String>, stamp: u64) -> String {
    let data = serde_json::to_string(entries).unwrap_or_else(|_| "{}".into()).replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    format!(
        "(function(){{try{{var ls=window.localStorage;if(!ls||ls.getItem({sentinel})!==null)return;\
var m={data};for(var k in m){{if(Object.prototype.hasOwnProperty.call(m,k)&&ls.getItem(k)===null)ls.setItem(k,m[k]);}}\
ls.setItem({sentinel},{stamp});}}catch(e){{}}}})();",
        sentinel = Value::from(SENTINEL_KEY),
        stamp = Value::from(stamp.to_string()),
    )
}

pub struct Pending {
    pub script: String,
    keys: Vec<String>,
    source: PathBuf,
}

/// What to inject this launch, if anything. A profile that has nothing to
/// migrate (a fresh machine, or no Electron data) is marked done at once; a
/// profile that could not be read is not, so a later launch can retry.
pub fn prepare() -> Option<Pending> {
    if marker_file().exists() {
        return None;
    }
    let src = electron_leveldb_dir();
    if !src.join("CURRENT").is_file() {
        write_marker(&json!({"migrated": 0, "reason": "no Electron localStorage", "source": src.to_string_lossy()}));
        return None;
    }
    match read_origin(&src, ELECTRON_ORIGIN) {
        Ok(entries) if entries.is_empty() => {
            write_marker(&json!({"migrated": 0, "reason": "Electron localStorage was empty", "source": src.to_string_lossy()}));
            None
        }
        Ok(entries) => {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            Some(Pending { script: init_script(&entries, stamp), keys: entries.keys().cloned().collect(), source: src })
        }
        Err(e) => {
            crate::blog(&format!("migrate: localStorage not read, will retry next launch: {e}"));
            None
        }
    }
}

impl Pending {
    pub fn key_count(&self) -> usize {
        self.keys.len()
    }

    /// The page painted with the script in place: never read again.
    pub fn commit(&self) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        write_marker(&json!({
            "migrated": self.keys.len(), "keys": self.keys, "source": self.source.to_string_lossy(),
            "origin": ELECTRON_ORIGIN, "at": at,
        }));
    }
}

fn write_marker(v: &Value) {
    let f = marker_file();
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(&f, serde_json::to_vec_pretty(v).unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str) -> Vec<u8> {
        let mut v = vec![0u8];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    fn latin1(s: &str) -> Vec<u8> {
        let mut v = vec![1u8];
        v.extend(s.chars().map(|c| c as u8));
        v
    }

    fn key(origin: &str, k: &[u8]) -> Vec<u8> {
        [b"_".as_slice(), origin.as_bytes(), b"\0", k].concat()
    }

    #[test]
    fn decodes_both_chromium_string_formats() {
        assert_eq!(decode_chromium_string(&latin1("midi-studio:skin")).as_deref(), Some("midi-studio:skin"));
        assert_eq!(decode_chromium_string(&utf16("caf\u{e9} \u{266b} 日本")).as_deref(), Some("caf\u{e9} \u{266b} 日本"));
        assert_eq!(decode_chromium_string(&[1, 0xe9]).as_deref(), Some("\u{e9}"));
        assert_eq!(decode_chromium_string(&[0, 0x41]), None, "odd UTF-16 length");
        assert_eq!(decode_chromium_string(&[7, 0x41]), None, "unknown format");
        assert_eq!(decode_chromium_string(&[]), None);
    }

    #[test]
    fn only_the_requested_origin_is_taken() {
        assert_eq!(
            parse_entry("file://", &key("file://", &latin1("a")), &utf16("[1,2]")),
            Some(("a".into(), "[1,2]".into()))
        );
        assert_eq!(parse_entry("file://", &key("http://tauri.localhost", &latin1("a")), &latin1("x")), None);
        assert_eq!(parse_entry("file://", b"META:file://", b"\x08\x01"), None);
        assert_eq!(parse_entry("file://", b"VERSION", b"1"), None);
    }

    #[test]
    fn script_fills_only_missing_keys_and_is_valid_json_inside() {
        let mut m = BTreeMap::new();
        m.insert("k\"1".to_string(), "v</script>\u{2028}".to_string());
        let s = init_script(&m, 42);
        assert!(s.contains(r#"ls.getItem("midi-studio:electron-migrated")!==null"#));
        assert!(s.contains(r#"ls.getItem(k)===null"#));
        assert!(s.contains(r#"ls.setItem("midi-studio:electron-migrated","42")"#));
        assert!(s.contains("\\u2028") && !s.contains('\u{2028}'));
        let data = s.split("var m=").nth(1).unwrap().split(";for(").next().unwrap();
        let back: BTreeMap<String, String> = serde_json::from_str(data).unwrap();
        assert_eq!(back, m);
    }

    /// Lists what a real profile would migrate. Point it at a COPY:
    ///   MIDI_STUDIO_ELECTRON_LEVELDB=<copy> cargo test dump_electron_copy -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dump_electron_copy() {
        let src = env_path("MIDI_STUDIO_ELECTRON_LEVELDB").expect("MIDI_STUDIO_ELECTRON_LEVELDB=<a copy>");
        let got = read_origin(&src, ELECTRON_ORIGIN).unwrap();
        for (k, v) in &got {
            let shown: String = v.chars().take(100).collect();
            println!("{k} ({} chars): {shown}", v.chars().count());
        }
        println!("{} keys", got.len());
    }

    #[test]
    fn reads_a_real_leveldb_and_leaves_the_source_untouched() {
        use rusty_leveldb::{Options, DB};
        let root = std::env::temp_dir().join(format!("ms-migrate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("leveldb");
        {
            let mut db = DB::open(&src, Options { create_if_missing: true, ..Options::default() }).unwrap();
            db.put(b"VERSION", b"1").unwrap();
            db.put(b"META:file://", b"\x08\x01").unwrap();
            db.put(&key("file://", &latin1("midi-player:last")), &latin1(r"C:\Songs\a.mid")).unwrap();
            db.put(&key("file://", &latin1("gone")), &latin1("x")).unwrap();
            db.delete(&key("file://", &latin1("gone"))).unwrap();
            db.put(&key("file://", &latin1("unicode")), &utf16("\u{266b}")).unwrap();
            db.put(&key("http://tauri.localhost", &latin1("other")), &latin1("y")).unwrap();
            db.flush().unwrap();
        }
        let before: Vec<(String, u64)> = {
            let mut v: Vec<(String, u64)> = std::fs::read_dir(&src)
                .unwrap()
                .flatten()
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().unwrap().len()))
                .collect();
            v.sort();
            v
        };
        let got = read_origin(&src, ELECTRON_ORIGIN).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got["midi-player:last"], r"C:\Songs\a.mid");
        assert_eq!(got["unicode"], "\u{266b}");
        let mut after: Vec<(String, u64)> = std::fs::read_dir(&src)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().unwrap().len()))
            .collect();
        after.sort();
        assert_eq!(before, after, "the source folder is never written");
        assert!(read_origin(&root.join("missing"), ELECTRON_ORIGIN).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
