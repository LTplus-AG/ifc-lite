/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use ifc_lite_cloud_import::{convert, Snapshot};
use serde::Deserialize;
use std::{collections::BTreeMap, fs, io::Read, path::Path};

#[derive(Deserialize)]
struct Input {
    #[serde(flatten)]
    snapshot: Snapshot,
    blobs: BTreeMap<String, String>,
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 { return Err("Expected manifest and output paths".into()); }
    let manifest = Path::new(&args[0]);
    let mut bytes = Vec::new();
    fs::File::open(manifest)?.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 * 1024 { return Err("Snapshot manifest exceeds limit".into()); }
    let input: Input = serde_json::from_slice(&bytes)?;
    let directory = manifest.parent().ok_or("Missing snapshot directory")?;
    let mut blobs = BTreeMap::new();
    let mut total = 0;
    for (id, name) in input.blobs {
        if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." { return Err("Invalid blob filename".into()); }
        let mut blob = Vec::new();
        fs::File::open(directory.join(name))?.take(512 * 1024 * 1024 + 1).read_to_end(&mut blob)?;
        total += blob.len();
        if total > 512 * 1024 * 1024 { return Err("Snapshot blobs exceed limit".into()); }
        blobs.insert(id, blob);
    }
    let artifact = convert(&input.snapshot, &blobs)?;
    fs::write(&args[1], serde_json::to_vec(&artifact)?)?;
    Ok(())
}
fn main() {
    if run().is_err() {
        // Source payloads and filesystem paths never enter production logs.
        eprintln!("Forma snapshot conversion failed");
        std::process::exit(1);
    }
}
