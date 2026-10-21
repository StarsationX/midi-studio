//! On-disk cache of ORT-optimized models.
//!
//! The first session for a model is built from the original file with full
//! optimization and `optimized_model_filepath` set, so ORT writes the graph
//! it ended up with; later runs load that file with optimization disabled.
//! An entry is keyed by the model's content hash, the exact ONNX Runtime
//! build (its build-info string) and a tag naming the execution provider and
//! any shape overrides, because an optimized graph may carry EP- and
//! CPU-specific nodes and must never be loaded by another runtime.
//!
//! The content hash of a large model is memoised by (path, size, mtime) in
//! `hashes.json`, so a cache hit costs a stat, not a 700 MB read.
//! FORGE_RS_MODEL_CACHE=0 turns the cache off; FORGE_RS_CACHE_DIR moves it.

use anyhow::{anyhow, Context, Result};
use std::collections::BTreeMap;
use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Bump when the way entries are produced changes.
const FORMAT: u32 = 1;

#[derive(Debug, Clone)]
pub struct ModelCache {
    pub dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub path: PathBuf,
    /// `<model stem>.<tag>.`: every entry for this model and tag starts so.
    prefix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheUse {
    Off,
    Hit,
    /// Built now and written for next time.
    Stored,
    /// Built now; the entry could not be written.
    Unwritable,
}

impl std::fmt::Display for CacheUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CacheUse::Off => "off",
            CacheUse::Hit => "hit",
            CacheUse::Stored => "miss, stored",
            CacheUse::Unwritable => "miss, not writable",
        })
    }
}

impl ModelCache {
    /// FORGE_RS_CACHE_DIR, else `<forge env>\cache\forge-rs`; None when
    /// FORGE_RS_MODEL_CACHE=0.
    pub fn from_env() -> Option<ModelCache> {
        if std::env::var("FORGE_RS_MODEL_CACHE").is_ok_and(|v| v == "0") {
            return None;
        }
        let dir = std::env::var_os("FORGE_RS_CACHE_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| crate::ortenv::forge_env_dir().map(|f| f.join("cache").join("forge-rs")))?;
        Some(ModelCache { dir })
    }

    pub fn entry(&self, model: &Path, tag: &str) -> Result<CacheEntry> {
        std::fs::create_dir_all(&self.dir).with_context(|| format!("create {}", self.dir.display()))?;
        let content = self.content_hash(model)?;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        h.write_u64(content);
        h.write(ort::info().as_bytes());
        h.write(tag.as_bytes());
        h.write_u32(FORMAT);
        let stem = model.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "model".into());
        let prefix = format!("{stem}.{tag}.");
        Ok(CacheEntry { path: self.dir.join(format!("{prefix}{:016x}.onnx", h.finish())), prefix })
    }

    fn content_hash(&self, model: &Path) -> Result<u64> {
        let meta = std::fs::metadata(model).with_context(|| format!("stat {}", model.display()))?;
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64);
        let key = std::fs::canonicalize(model).unwrap_or_else(|_| model.to_path_buf()).to_string_lossy().into_owned();
        let memo_path = self.dir.join("hashes.json");
        let mut memo: BTreeMap<String, (u64, u64, String)> =
            std::fs::read_to_string(&memo_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if let Some((size, mt, hash)) = memo.get(&key) {
            if *size == meta.len() && *mt == mtime {
                if let Ok(v) = u64::from_str_radix(hash, 16) {
                    return Ok(v);
                }
            }
        }
        let mut f = std::fs::File::open(model).with_context(|| format!("open {}", model.display()))?;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.write(&buf[..n]);
        }
        let v = h.finish();
        memo.insert(key, (meta.len(), mtime, format!("{v:016x}")));
        let tmp = memo_path.with_extension(format!("json.{}", std::process::id()));
        if std::fs::write(&tmp, serde_json::to_string_pretty(&memo)?).is_ok() && std::fs::rename(&tmp, &memo_path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(v)
    }
}

impl CacheEntry {
    /// Where ORT writes the new entry; renamed into place once it loads.
    pub fn temp_path(&self) -> PathBuf {
        self.path.with_extension(format!("onnx.part{}", std::process::id()))
    }

    /// Move a freshly written entry into place and drop older entries for
    /// the same model and tag (another ORT build, an older model).
    pub fn commit(&self, tmp: &Path) -> Result<()> {
        std::fs::rename(tmp, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(tmp);
            anyhow!("{e}")
        })?;
        if let (Some(dir), Some(keep)) = (self.path.parent(), self.path.file_name()) {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if name != keep && n.starts_with(&self.prefix) && n.ends_with(".onnx") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        Ok(())
    }
}
