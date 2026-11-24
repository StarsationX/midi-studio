//! The user's Medley separator is never downloaded. The installer preserves
//! it at the same per-user path; neither path relies on changing settings.
use super::{fpaths, verified, winjob};
use std::fs::File;
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(super) const ONNX: &str = "bsrofo_sw_body.onnx";
const PIN: verified::Pin<'static> = verified::Pin { size: 700_756_116, sha256: "fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede" };
const WRONG: &str = "This is not the tested Medley ONNX (SHA-256 mismatch). No file was replaced.";

pub(super) fn destination() -> PathBuf {
    fpaths::legacy_default_forge_env_dir().join("models").join("bs_rofo_sw").join(ONNX)
}

pub(super) fn verify(path: &Path) -> Result<(), String> {
    if PIN.matches(path) { Ok(()) } else { Err(WRONG.into()) }
}

fn import_onnx(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() { verify(source)?; }
    verified::publish(target, PIN, || File::open(source).map_err(|e| format!("Could not open {}: {e}", source.display())))?;
    Ok(())
}

pub(super) fn import(source: &Path, paths: &fpaths::ForgePaths) -> Result<PathBuf, String> {
    super::standard_user::require().map_err(|e| e.to_string())?;
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
