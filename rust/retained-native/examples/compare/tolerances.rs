// SPDX-License-Identifier: MPL-2.0
use serde_json::{Map, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

type Error = Box<dyn std::error::Error>;

/// Each top-level key is one immutable preregistration, never a deep merge.
pub fn load(directory: &Path) -> Result<Value, Error> {
    let fragments = directory.join("tolerances.d");
    let mut files = match std::fs::read_dir(&fragments) {
        Ok(entries) => entries.map(|entry| entry.map(|e| e.path())).collect::<Result<Vec<_>, _>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    files.retain(|path| path.extension().is_some_and(|ext| ext == "json"));
    files.sort();
    files.insert(0, directory.join("tolerances.json"));
    let mut merged = Map::new();
    let mut owners = BTreeMap::<String, PathBuf>::new();
    for file in files {
        let text = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let value: Value = serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", file.display()))?;
        let values = value.as_object().ok_or_else(|| format!("{}: expected a tolerance object", file.display()))?;
        for (key, value) in values {
            if let Some(previous) = owners.get(key) {
                return Err(format!("Duplicate tolerance {key}: {} and {}; never redefine existing keys", previous.display(), file.display()).into());
            }
            owners.insert(key.clone(), file.clone());
            merged.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(merged))
}

pub fn registered() -> Result<Value, Error> {
    load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cli-retained"))
}
