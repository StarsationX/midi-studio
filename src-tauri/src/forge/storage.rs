// storage.rs: electron/forge-storage.js. Where the multi-GB Forge env lives,
// and the only rules under which MIDI Studio will move or delete it: a folder
// is ours if it is the default or carries the marker file setup writes.
use std::io;
use std::path::{Path, PathBuf};

use super::fpaths::FOLDER_NAME;

pub const MARKER: &str = ".midi-studio-forge";

fn resolve(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

fn normalized(p: &Path) -> String {
    resolve(p).to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    !a.as_os_str().is_empty() && !b.as_os_str().is_empty() && normalized(a) == normalized(b)
}

/// `child` is `parent` or somewhere below it.
pub fn is_inside(child: &Path, parent: &Path) -> bool {
    let (c, p) = (normalized(child), normalized(parent));
    c == p || c.starts_with(&format!("{p}\\"))
}

/// A picked folder becomes "<folder>\MIDI Studio Forge" unless it already is one.
pub fn target_for_selection(selected: &Path) -> PathBuf {
    let dir = resolve(selected);
    if dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(FOLDER_NAME)) {
        dir
    } else {
        dir.join(FOLDER_NAME)
    }
}

pub fn mark_managed(dir: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(MARKER), "Managed by MIDI Studio.\n")?;
    Ok(dir.to_path_buf())
}

pub fn is_managed(dir: &Path, default_dir: &Path) -> bool {
    if dir.as_os_str().is_empty() {
        return false;
    }
    if same_path(dir, default_dir) {
        return true;
    }
    dir.join(MARKER).exists()
}

pub fn is_empty(dir: &Path) -> bool {
    if !dir.exists() {
        return true;
    }
    std::fs::read_dir(dir).map(|mut rd| rd.next().is_none()).unwrap_or(false)
}

pub fn assert_writable(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(format!(
        ".midi-studio-write-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    ));
    std::fs::write(&probe, "ok")?;
    std::fs::remove_file(&probe)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_tree(&e.path(), &to)?;
        } else {
            if to.exists() {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} exists", to.display())));
            }
            std::fs::copy(e.path(), &to)?;
        }
    }
    Ok(())
}

fn err(msg: &str) -> io::Error {
    io::Error::other(msg.to_string())
}

/// forge-storage.js moveManaged: a rename when it can be, a copy into a
/// staging folder then a rename when the target is on another drive.
pub fn move_managed(source: &Path, target: &Path, default_dir: &Path) -> io::Result<PathBuf> {
    let (source, target) = (resolve(source), resolve(target));
    if same_path(&source, &target) {
        return Ok(target);
    }
    if !is_managed(&source, default_dir) {
        return Err(err("The current Forge folder is not marked as managed by MIDI Studio."));
    }
    if is_inside(&target, &source) || is_inside(&source, &target) {
        return Err(err("Choose a folder outside the current Forge folder."));
    }
    assert_writable(target.parent().unwrap_or(&target))?;
    if !is_empty(&target) {
        return Err(err("The selected Forge destination is not empty."));
    }
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    match std::fs::rename(&source, &target) {
        Ok(()) => {}
        // ERROR_NOT_SAME_DEVICE: Node's EXDEV.
        Err(e) if e.raw_os_error() == Some(17) => {
            let staging = PathBuf::from(format!("{}.moving", target.display()));
            let _ = std::fs::remove_dir_all(&staging);
            let copied = copy_tree(&source, &staging)
                .and_then(|()| mark_managed(&staging).map(|_| ()))
                .and_then(|()| std::fs::rename(&staging, &target));
            if let Err(e) = copied {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e);
            }
            std::fs::remove_dir_all(&source)?;
        }
        Err(e) => return Err(e),
    }
    mark_managed(&target)?;
    Ok(target)
}

/// "song.mid" -> "song (2).mid" when the name is taken.
pub fn unique_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let dir = target.parent().unwrap_or(Path::new(""));
    let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let base = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    for n in 2..999 {
        let c = dir.join(format!("{base} ({n}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    target.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-forge-storage-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn path_rules() {
        assert!(same_path(Path::new(r"C:\A\b\"), Path::new(r"c:\a\B")));
        assert!(!same_path(Path::new(""), Path::new("")));
        assert!(is_inside(Path::new(r"C:\a\b\c"), Path::new(r"C:\a\b")));
        assert!(is_inside(Path::new(r"C:\a\b"), Path::new(r"C:\a\b")));
        assert!(!is_inside(Path::new(r"C:\a\bc"), Path::new(r"C:\a\b")));
        assert_eq!(target_for_selection(Path::new(r"D:\")), PathBuf::from(r"D:\MIDI Studio Forge"));
        assert_eq!(target_for_selection(Path::new(r"D:\x\midi studio forge")), PathBuf::from(r"D:\x\midi studio forge"));
    }

    #[test]
    fn managed_and_move() {
        let root = scratch("move");
        let (src, dst, default) = (root.join("src"), root.join("dst"), root.join("default"));
        std::fs::create_dir_all(src.join("python").join("Lib")).unwrap();
        std::fs::write(src.join("python").join("Lib").join("x.txt"), b"x").unwrap();
        assert!(!is_managed(&src, &default));
        assert!(move_managed(&src, &dst, &default).is_err(), "an unmarked folder is never moved");
        mark_managed(&src).unwrap();
        assert!(is_managed(&src, &default));
        assert!(is_managed(&default, &default), "the default always counts");
        assert!(move_managed(&src, &src.join("inner"), &default).is_err());
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("other"), b"").unwrap();
        assert!(move_managed(&src, &dst, &default).is_err(), "a non-empty target is refused");
        std::fs::remove_file(dst.join("other")).unwrap();
        let moved = move_managed(&src, &dst, &default).unwrap();
        assert!(same_path(&moved, &dst));
        assert!(!src.exists());
        assert_eq!(std::fs::read(dst.join("python").join("Lib").join("x.txt")).unwrap(), b"x");
        assert!(dst.join(MARKER).exists());
        assert!(is_empty(&root.join("nope")));
        assert!(!is_empty(&dst));
        assert!(assert_writable(&root.join("w")).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unique_names() {
        let root = scratch("unique");
        let f = root.join("song.mid");
        assert_eq!(unique_path(&f), f);
        std::fs::write(&f, b"").unwrap();
        assert_eq!(unique_path(&f), root.join("song (2).mid"));
        std::fs::write(root.join("song (2).mid"), b"").unwrap();
        assert_eq!(unique_path(&f), root.join("song (3).mid"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
