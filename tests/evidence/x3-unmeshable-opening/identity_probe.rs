// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! X3 / ROUTER-37 (#8385) output-identity probe, adapted from the C2-8a probe
//! (#8263). qualify.sh copies this file into
//! `rust/processing/examples/` of the base export and the head checkout, so
//! both sides run the same harness against their own pipeline.
//!
//! One rayon worker runs the canonical `process_geometry` entry point. It
//! prints mesh/vertex/triangle counts, the ordered geometry-payload FNV of
//! `perf_probe --fingerprint`, the SHA-256 of the serialized result (meshes,
//! metadata, frame, transforms and the FULL contents of every instance record,
//! via its `Debug` form, since `InstanceRecord` is not `Serialize`), the SHA-256
//! of the instance records alone (from the default pass and from a second pass
//! with instancing armed, so the records are non-empty), and the SHA-256 of the `GeometryDiagnostics`
//! and the non-timing `ProcessingStats` counters, which it also writes to
//! `<out>.diagnostics.json` for diffing. Timings are excluded.
//!
//! Usage: x3_identity_probe <input.ifc> <out-prefix>

#[path = "perf_probe/fingerprint.rs"]
mod fingerprint;

use ifc_lite_processing::{process, process_geometry, ProcessingRequest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: x3_identity_probe <input.ifc> <out-prefix>".into());
    }
    let content = std::fs::read(&args[0])?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build()?;
    let result = pool.install(|| process_geometry(&content));
    // `process_geometry` never arms instancing, so its instance list is empty;
    // a second, instanced pass gives the instance records real contents.
    let instanced =
        pool.install(|| process(&content, &ProcessingRequest::full_pass().instancing(true), &mut ()));

    let vertices: usize = result.meshes.iter().map(|m| m.positions.len() / 3).sum();
    let triangles: usize = result.meshes.iter().map(|m| m.indices.len() / 3).sum();
    let meshes: Vec<Value> =
        result.meshes.iter().map(serde_json::to_value).collect::<Result<_, _>>()?;
    let instances: Vec<String> = result.instances.iter().chain(&instanced.instances).map(|i| format!("{i:?}")).collect();
    let instances_sha = sha(instances.join("\n").as_bytes());
    let instanced_meshes: Vec<Value> =
        instanced.meshes.iter().map(serde_json::to_value).collect::<Result<_, _>>()?;
    let output = serde_json::to_vec(&json!({
        "buildingTransform": result.building_transform,
        "coordinateSpace": result.mesh_coordinate_space,
        "frame": format!("{:?}", result.frame),
        "instances": instances,
        "instancedMeshes": instanced_meshes,
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
        "X3_IDENTITY {}",
        json!({
            "meshes": result.meshes.len(),
            "vertices": vertices,
            "triangles": triangles,
            "geometryPayloadFnv1a64": fingerprint::mesh_fingerprint(&result.meshes),
            "instances": result.instances.len(),
            "instancedRunInstances": instanced.instances.len(),
            "instancedRunFnv1a64": fingerprint::mesh_fingerprint(&instanced.meshes),
            "instancesSha256": instances_sha,
            "outputSha256": sha(&output),
            "diagnosticsSha256": sha(&diagnostics),
            "hasGeometryDiagnostics": result.stats.geometry_diagnostics.is_some(),
        })
    );
    Ok(())
}
