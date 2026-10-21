use std::collections::HashMap;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::Value;

pub const PRESETS: [&str; 8] = [
    "virtualpiano", "virtualpiano66",
    "roblox", "roblox61", "roblox66", "roblox88", "roblox88ctrl", "drums",
];

pub type NoteToKey = IndexMap<i64, String>;

#[derive(Debug)]
pub struct Mapping {
    pub data: Value,
    pub note_to_key: NoteToKey,
}

impl Mapping {
    pub fn get(&self, field: &str) -> Option<&Value> {
        self.data.get(field)
    }
}

/// `_resolve_mapping`: a user-managed copy in the AppData mappings folder wins,
/// so custom and edited mappings persist across portable re-extractions.
pub fn resolve_mapping(arg: &str, user_dir: Option<&Path>) -> String {
    if let Some(dir) = user_dir {
        if !arg.is_empty() && !Path::new(arg).is_absolute() {
            let name = if arg.ends_with(".json") { arg.to_string() } else { format!("{arg}.json") };
            let cand = dir.join(name);
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
    }
    arg.to_string()
}

pub fn load_mapping(arg: &str, script_dir: &Path) -> Result<Mapping, String> {
    let path: PathBuf = if PRESETS.contains(&arg) {
        script_dir.join("mappings").join(format!("{arg}.json"))
    } else {
        PathBuf::from(arg)
    };
    if !path.is_file() {
        return Err(format!("Mapping file not found: {}", path.display()));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let raw = data
        .get("note_to_key")
        .and_then(Value::as_object)
        .ok_or_else(|| "'note_to_key'".to_string())?;
    let mut note_to_key = NoteToKey::new();
    for (k, v) in raw {
        let n: i64 = k
            .trim()
            .parse()
            .map_err(|_| format!("invalid literal for int() with base 10: '{k}'"))?;
        let key = v
            .as_str()
            .ok_or_else(|| format!("mapping value for note {k} is not a string"))?;
        note_to_key.insert(n, key.to_string());
    }
    Ok(Mapping { data, note_to_key })
}

/// `make_resolver`: note -> key lookup that folds out-of-range notes by octaves.
pub struct Resolver<'a> {
    map: &'a NoteToKey,
    fold: bool,
    lo: i64,
    hi: i64,
    cache: HashMap<i64, Option<&'a str>>,
}

impl<'a> Resolver<'a> {
    pub fn new(map: &'a NoteToKey, fold: bool) -> Self {
        let lo = map.keys().copied().min().unwrap_or(0);
        let hi = map.keys().copied().max().unwrap_or(0);
        Resolver { map, fold: fold && !map.is_empty(), lo, hi, cache: HashMap::new() }
    }

    pub fn resolve(&mut self, n: i64) -> Option<&'a str> {
        let map = self.map;
        if let Some(k) = map.get(&n) {
            return Some(k.as_str());
        }
        if !self.fold {
            return None;
        }
        if let Some(k) = self.cache.get(&n) {
            return *k;
        }
        let mut m = n;
        while m < self.lo {
            m += 12;
        }
        while m > self.hi {
            m -= 12;
        }
        let mut key = map.get(&m).map(String::as_str);
        if key.is_none() {
            let mut cand = n.rem_euclid(12);
            while cand < 128 {
                if self.lo <= cand && cand <= self.hi {
                    if let Some(k) = map.get(&cand) {
                        key = Some(k.as_str());
                        break;
                    }
                }
                cand += 12;
            }
        }
        self.cache.insert(n, key);
        key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn octave_fold() {
        let mapping: NoteToKey = (36..97).map(|n| (n, ((b'a' + (n % 26) as u8) as char).to_string())).collect();
        let mut r = Resolver::new(&mapping, true);
        assert_eq!(r.resolve(60), Some(mapping[&60].as_str()), "in-range note must not move");
        assert_eq!(r.resolve(24), Some(mapping[&36].as_str()), "a note below the mapping folds up an octave");
        assert_eq!(r.resolve(12), Some(mapping[&36].as_str()), "two octaves below folds up two");
        assert_eq!(r.resolve(108), Some(mapping[&96].as_str()), "a note above the mapping folds down");
        assert_eq!(Resolver::new(&mapping, false).resolve(24), None, "fold=false keeps the old drop-it behaviour");
    }

    #[test]
    fn unmapped_pitch_class_still_unmapped() {
        let white: NoteToKey = (36..97)
            .filter(|n| [0, 2, 4, 5, 7, 9, 11].contains(&(n % 12)))
            .map(|n| (n, n.to_string()))
            .collect();
        let mut r = Resolver::new(&white, true);
        assert_eq!(r.resolve(61), None, "no key for this pitch class in any octave");
        assert_eq!(r.resolve(24), Some(white[&36].as_str()), "but naturals still fold");
    }
}
