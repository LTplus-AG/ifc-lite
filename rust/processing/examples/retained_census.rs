// SPDX-License-Identifier: MPL-2.0
//! Read-only retained-source coverage census. No geometry is evaluated.
//! cargo run -p ifc-lite-processing --example retained_census -- --manifest tests/models/manifest.json

#[path = "retained_census/logic.rs"]
mod logic;

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let mut manifest = None;
    let mut paths = Vec::new();
    while let Some(arg) = args.next() {
        if arg.to_string_lossy() == "--manifest" {
            manifest = Some(PathBuf::from(args.next().ok_or("--manifest needs a path")?));
        } else {
            paths.push(PathBuf::from(arg));
        }
    }
    if manifest.is_none() && paths.is_empty() {
        return Err("pass --manifest tests/models/manifest.json and/or IFC paths".into());
    }
    let mut fixtures = Vec::new();
    if let Some(manifest) = manifest {
        let bytes = std::fs::read(&manifest)?;
        let json: serde_json::Value = serde_json::from_slice(&bytes)?;
        let root = manifest.parent().ok_or("manifest has no parent")?;
        for file in json["files"]
            .as_array()
            .ok_or("manifest has no files array")?
        {
            let relative = file["path"].as_str().ok_or("manifest entry has no path")?;
            let path = root.join(relative);
            fixtures.push((format!("tests/models/{relative}"), path));
        }
    }
    for path in paths {
        fixtures.push((path.to_string_lossy().into_owned(), path));
    }
    let report = logic::census_paths(fixtures)?;
    // serde_json::Map uses sorted keys; converting through Value also sorts
    // nested struct fields rather than retaining their declaration order.
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::to_value(report)?)?
    );
    Ok(())
}
