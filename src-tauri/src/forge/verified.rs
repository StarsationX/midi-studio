//! Publish a pinned file on its destination volume. Neither a failed transfer nor
//! a competing installer may replace an existing file (including a conflict).
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy)]
pub(super) struct Pin<'a> {
    pub size: u64,
    pub sha256: &'a str,
}

impl Pin<'_> {
    pub fn copy(&self, mut source: impl Read, mut out: impl Write) -> io::Result<()> {
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = source.read(&mut buf)?;
            if n == 0 { break; }
            bytes += n as u64;
            if bytes > self.size { return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected file size")); }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        if bytes != self.size || format!("{:x}", hash.finalize()) != self.sha256 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "SHA-256 or size mismatch"));
        }
        Ok(())
    }

    pub fn matches(&self, path: &Path) -> bool {
        fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == self.size)
            && File::open(path).is_ok_and(|f| self.copy(f, io::sink()).is_ok())
    }
}

struct Part(PathBuf);
impl Drop for Part {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

pub(super) fn publish<R: Read>(target: &Path, pin: Pin<'_>, open: impl FnOnce() -> Result<R, String>) -> Result<(), String> {
    let existing = || if pin.matches(target) { Ok(()) } else {
        Err(format!("A different or unreadable file already exists at {}. It was left alone. Move it aside and retry.", target.display()))
    };
    match fs::symlink_metadata(target) {
        Ok(_) => return existing(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    let dir = target.parent().ok_or("No component storage folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let (tmp, mut out) = loop {
        let p = dir.join(format!(".forge-{}-{}.part", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        match File::create_new(&p) {
            Ok(f) => break (Part(p), f),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    };
    let result = open().and_then(|r| pin.copy(r, &mut out).and_then(|_| out.sync_all()).map_err(|e| e.to_string()));
    drop(out);
    result?;
    // fs::rename on Windows would replace an unrelated file created in this gap.
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileW(wide(&tmp.0).as_ptr(), wide(target).as_ptr()) } == 0 {
        let e = io::Error::last_os_error();
        if e.kind() == io::ErrorKind::AlreadyExists { return existing(); }
        return Err(format!("Could not publish {}: {e}", target.display()));
    }
    Ok(())
}
