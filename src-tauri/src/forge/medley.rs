//! The user's Medley separator is never downloaded. The installer preserves
//! it at the same per-user path; neither path relies on changing settings.
use super::{fpaths, winjob};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) const ONNX: &str = "bsrofo_sw_body.onnx";
const SHA: &str = "fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede";
const WRONG: &str = "This is not the tested Medley ONNX (SHA-256 mismatch). No file was replaced.";

pub(super) fn destination() -> PathBuf {
    fpaths::legacy_default_forge_env_dir().join("models").join("bs_rofo_sw").join(ONNX)
}

fn verified_copy(path: &Path, out: &mut impl Write) -> Result<(), String> {
    let mut input = File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let meta = input.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() != 700_756_116 { return Err(WRONG.into()); }
    let mut hash = Sha256::new();
    let mut buf = [0; 64 * 1024];
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    if format!("{:x}", hash.finalize()) != SHA { return Err(WRONG.into()); }
    Ok(())
}

pub(super) fn verify(path: &Path) -> Result<(), String> {
    verified_copy(path, &mut io::sink())
}

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

fn import_onnx(source: &Path, target: &Path) -> Result<(), String> {
    let existing = || verify(target).map_err(|e| format!("A different or unreadable file already exists at {}. It was left alone. Move it aside and retry. {e}", target.display()));
    if target.try_exists().map_err(|e| e.to_string())? {
        verify(source)?;
        return existing();
    }
    let dir = target.parent().ok_or("No model storage folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let (tmp, mut output) = loop {
        let name = dir.join(format!(".medley-{}-{}.part", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        match File::create_new(&name) {
            Ok(file) => break (Temp(name), file),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    };
    let written = verified_copy(source, &mut output).and_then(|_| output.sync_all().map_err(|e| e.to_string()));
    drop(output);
    written?;
    // Same-volume atomic publication, without std::fs::rename's REPLACE_EXISTING.
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileW(wide(&tmp.0).as_ptr(), wide(target).as_ptr()) } == 0 {
        let e = io::Error::last_os_error();
        if e.kind() == io::ErrorKind::AlreadyExists { return existing(); }
        return Err(format!("Could not install the verified copy: {e}"));
    }
    Ok(())
}

fn unelevated() -> bool {
    use windows_sys::Win32::{Foundation::CloseHandle, Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{GetCurrentProcess, OpenProcessToken}};
    let mut token = std::ptr::null_mut();
    let mut info = TOKEN_ELEVATION { TokenIsElevated: 1 };
    let mut size = 0;
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return false; }
        let ok = GetTokenInformation(token, TokenElevation, (&mut info as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut size);
        CloseHandle(token);
        ok != 0 && info.TokenIsElevated == 0
    }
}

pub(super) fn import(source: &Path, paths: &fpaths::ForgePaths) -> Result<PathBuf, String> {
    if !unelevated() { return Err("Close Studio and reopen it without Run as administrator before importing a local model.".into()); }
    let target = destination();
    if source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ckpt")) {
        let python = fpaths::forge_env_python(paths).ok_or("This checkpoint needs an already installed local Forge Python environment. Choose bsrofo_sw_body.onnx instead.")?;
        let msst = [fpaths::forge_env_dir(paths), fpaths::legacy_default_forge_env_dir(), fpaths::legacy_forge_env_dir()]
            .into_iter().map(|dir| dir.join("msst")).find(|d| d.join("models/bs_roformer/bs_roformer.py").is_file())
            .ok_or("The original local MSST installation is missing. Choose bsrofo_sw_body.onnx instead.")?;
        let script = crate::paths::engine_dir().join("import_medley_checkpoint.py");
        let mut cmd = Command::new(python);
        cmd.arg("-I").arg(&script).arg(msst).arg(source).arg(&target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        let job = winjob::Job::new(winjob::mem_limit()).map_err(|e| e.to_string())?;
        let (child, _) = winjob::spawn_in_job(&mut cmd, &job, true).map_err(|e| format!("Could not start the offline converter: {e}"))?;
        let result = child.wait_with_output().map_err(|e| e.to_string())?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let tail = stderr.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("Local conversion did not produce a verified model. Your checkpoint was kept. {tail}"));
        }
        verify(&target)?;
    } else {
        import_onnx(source, &target)?;
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_import_leaves_no_model_or_partial_and_keeps_conflicts() {
        let dir = std::env::temp_dir().join(format!("medley-import-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("wrong.onnx");
        let dest = dir.join("models").join(ONNX);
        fs::write(&source, b"not a model").unwrap();
        assert!(import_onnx(&source, &dest).unwrap_err().contains("SHA-256"));
        assert_eq!(fs::read_dir(dest.parent().unwrap()).unwrap().count(), 0);
        fs::write(&dest, b"keep me").unwrap();
        assert!(import_onnx(&source, &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"keep me");
        fs::remove_dir_all(dir).unwrap();
    }
}
