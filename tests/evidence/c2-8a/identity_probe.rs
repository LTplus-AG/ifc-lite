// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C2-8 (#8263) output-identity probe. qualify.sh copies this file into
//! `rust/processing/examples/` of the base export and the head checkout, so
//! both sides run the same harness against their own pipeline.
//!
//! One rayon worker runs the canonical `process_geometry` entry point. It
//! prints mesh/vertex/triangle counts, the ordered geometry-payload FNV of
//! `perf_probe --fingerprint`, the SHA-256 of the serialized result (meshes,
//! metadata, frame and transforms), and the SHA-256 of the `GeometryDiagnostics`
//! and the non-timing `ProcessingStats` counters, which it also writes to
//! `<out>.diagnostics.json` for diffing. Timings are excluded.
//!
//! Usage: c2_8_identity_probe <input.ifc> <out-prefix>

#[path = "perf_probe/fingerprint.rs"]
mod fingerprint;

use ifc_lite_processing::process_geometry;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: c2_8_identity_probe <input.ifc> <out-prefix>".into());
    }
    let content = std::fs::read(&args[0])?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build()?;
    let result = pool.install(|| process_geometry(&content));

    let vertices: usize = result.meshes.iter().map(|m| m.positions.len() / 3).sum();
    let triangles: usize = result.meshes.iter().map(|m| m.indices.len() / 3).sum();
    let meshes: Vec<Value> =
        result.meshes.iter().map(serde_json::to_value).collect::<Result<_, _>>()?;
    let output = serde_json::to_vec(&json!({
        "buildingTransform": result.building_transform,
        "coordinateSpace": result.mesh_coordinate_space,
        "frame": format!("{:?}", result.frame),
        "instances": result.instances.len(),
        "meshes": meshes,
        "metadata": result.metadata,
        "siteTransform": result.site_transform,
    }))?;
    let mut stats = serde_json::to_value(&result.stats)?;
    if let Value::Object(map) = &mut stats {
        map.retain(|key, _| !key.ends_with("_time_ms") && !key.ends_with("TimeMs"));
    }
    let diagnostics = serde_json::to_vec_pretty(&stats)?;
    std::fs::write(format!("{}.diagnostics.json", args[1]), &diagnostics)?;

    println!(
        "C28_IDENTITY {}",
        json!({
            "meshes": result.meshes.len(),
            "vertices": vertices,
            "triangles": triangles,
            "geometryPayloadFnv1a64": fingerprint::mesh_fingerprint(&result.meshes),
            "outputSha256": sha(&output),
            "diagnosticsSha256": sha(&diagnostics),
            "hasGeometryDiagnostics": result.stats.geometry_diagnostics.is_some(),
        })
    );
    Ok(())
}
