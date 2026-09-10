// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded transfer capacity probe. Emits metadata only; never applies a mutation.
use ifc_lite_processing::appearance::{plan_mesh_transfer, register_scan_correspondences, MeshTransferRequest};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("input directory"));
    let source = read(&root.join("source.ifc"))?;
    let rgba = read(&root.join("rgba.bin"))?;
    let mut request: MeshTransferRequest = serde_json::from_slice(&read(&root.join("request.json"))?)?;
    request.registration_sha256 = register_scan_correspondences(&request.registration)?.request_sha256;
    let start = std::time::Instant::now();
    match plan_mesh_transfer(&source, &request, &rgba) {
        Ok(plan) => println!("{}", serde_json::json!({"elapsedMs":start.elapsed().as_millis(), "summary":plan.transfer})),
        Err(error) => println!("{}", serde_json::json!({"elapsedMs":start.elapsed().as_millis(), "refusal":error})),
    }
    Ok(())
}

fn read(path: &std::path::Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    use std::io::Read;
    const LIMIT: u64 = 128 * 1024 * 1024;
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > LIMIT { return Err("input must be a bounded regular file".into()); }
    let mut result = Vec::new();
    std::fs::File::open(path)?.take(LIMIT + 1).read_to_end(&mut result)?;
    if result.len() as u64 > LIMIT { return Err("input grew past its bound".into()); }
    Ok(result)
}
