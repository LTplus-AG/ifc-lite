// SPDX-License-Identifier: MPL-2.0
//! Per-slice coverage ownership. A model belongs to exactly one manifest.
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}};
type Error = Box<dyn std::error::Error>;
const BASE: &str = "tests/manifests/cli-retained-coverage.tsv";
const HEADER: &str = "# SPDX-License-Identifier: MPL-2.0\nmodel\tid\tstatus\tcode\n";
pub fn fragments(root: &str, extension: &str) -> Result<Vec<PathBuf>, Error> {
    if !Path::new(root).exists() { return Ok(Vec::new()); }
    let mut paths = std::fs::read_dir(root)?.map(|e| e.map(|e| e.path())).collect::<Result<Vec<_>, _>>()?;
    paths.retain(|p| p.extension().is_some_and(|e| e == extension)); paths.sort(); Ok(paths)
}
fn rows(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter(|s| !s.is_empty() && !s.starts_with('#') && !s.starts_with("model\t"))
}
pub fn coverage(actual: &[String], bless: bool, gate: bool, violations: &mut Vec<String>) -> Result<(), Error> {
    let mut files = vec![PathBuf::from(BASE)];
    files.extend(fragments("tests/manifests/cli-retained-coverage.d", "tsv")?);
    let mut owners = BTreeMap::new(); let mut pins = BTreeSet::new(); let mut keys = BTreeSet::new();
    for file in &files {
        for row in rows(&std::fs::read_to_string(file)?) {
            let parts: Vec<_> = row.split('\t').collect();
            if parts.len() != 4 || parts[1].parse::<u32>().is_err() { return Err(format!("invalid coverage row in {}", file.display()).into()); }
            let model = parts[0].to_owned();
            if let Some(previous) = owners.insert(model, file.clone()) { if previous != *file { return Err("model rows span coverage files".into()); } }
            if !keys.insert((parts[0].to_owned(), parts[1].parse::<u32>()?)) { return Err("duplicate coverage model/id".into()); }
            pins.insert(row.to_owned());
        }
    }
    // New models route to the matching slice even before its first blessing.
    for universe in fragments("tests/fixtures/cli-retained/universe.d", "txt")? {
        let destination = Path::new("tests/manifests/cli-retained-coverage.d").join(universe.file_stem().ok_or("missing slice name")?).with_extension("tsv");
        for model in std::fs::read_to_string(universe)?.lines().map(str::trim).filter(|s| !s.is_empty() && !s.starts_with('#')) {
            if let Some(owner) = owners.insert(model.to_owned(), destination.clone()) {
                if owner != destination { return Err(format!("model {model} has conflicting slice ownership").into()); }
            }
        }
        if !files.contains(&destination) { files.push(destination); }
    }
    let actual: BTreeSet<_> = actual.iter().cloned().collect();
    if bless {
        let mut outputs: BTreeMap<_, String> = files.into_iter().map(|p| (p, HEADER.to_owned())).collect();
        for row in &actual {
            let model = row.split('\t').next().ok_or("empty model")?;
            let owner = owners.get(model).ok_or_else(|| format!("no coverage owner for {model}"))?;
            let output = outputs.get_mut(owner).ok_or("missing owner file")?;
            output.push_str(row); output.push('\n');
        }
        for (path, text) in outputs {
            std::fs::create_dir_all(path.parent().ok_or("coverage parent missing")?)?;
            std::fs::write(path, text)?;
        }
    } else if gate && pins != actual { violations.push("coverage or refusal histogram differs from committed manifests".into()); }
    Ok(())
}
