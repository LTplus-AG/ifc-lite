// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! X2 (#8385) output-identity probe, after tests/evidence/c2-8a. qualify.sh
//! copies this file into `rust/processing/examples/` of the base export and
//! the head checkout, so both sides run the same harness on their pipeline.
//!
//! One rayon worker runs two passes: the canonical `process_geometry`, then the
//! same full pass with instancing on, so `instances` is not empty. Per pass it
//! prints mesh/vertex/triangle counts, the ordered geometry-payload FNV of
//! `perf_probe --fingerprint`, the SHA-256 of the serialized result (meshes,
//! metadata, frame, transforms), the SHA-256 of EVERY instance record field
//! (f32/f64 by bit pattern, in order), and the SHA-256 of the
//! `GeometryDiagnostics` plus non-timing `ProcessingStats`, which it also writes
//! to `<out>.<pass>.diagnostics.json` for diffing. Timings are excluded.
//!
//! Usage: x2_identity_probe <input.ifc> <out-prefix>

#[path = "perf_probe/fingerprint.rs"]
mod fingerprint;

use ifc_lite_processing::{process, process_geometry, InstanceRecord, ProcessingRequest, ProcessingResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn put_str(h: &mut Sha256, s: Option<&str>) {
    match s {
        None => h.update([0u8]),
        Some(s) => {
            h.update([1u8]);
            h.update((s.len() as u64).to_le_bytes());
            h.update(s.as_bytes());
        }
    }
}

/// Every field of every record, in emission order (destructured, so a new
/// field fails to compile instead of escaping the hash).
fn instances_sha(instances: &[InstanceRecord]) -> String {
    let mut h = Sha256::new();
    h.update((instances.len() as u64).to_le_bytes());
    for record in instances {
        let InstanceRecord {
            express_id,
            ifc_type,
            global_id,
            name,
            presentation_layer,
            color,
            template_express_id,
            rep_identity,
            transform,
            geometry_item_id,
        } = record;
        h.update(express_id.to_le_bytes());
        put_str(&mut h, Some(ifc_type));
        put_str(&mut h, global_id.as_deref());
        put_str(&mut h, name.as_deref());
        put_str(&mut h, presentation_layer.as_deref());
        color.iter().for_each(|c| h.update(c.to_bits().to_le_bytes()));
        h.update(template_express_id.to_le_bytes());
        h.update(rep_identity.to_le_bytes());
        transform.iter().for_each(|c| h.update(c.to_bits().to_le_bytes()));
        match geometry_item_id {
            None => h.update([0u8]),
            Some(id) => {
                h.update([1u8]);
                h.update(id.to_le_bytes());
            }
        }
    }
    format!("{:x}", h.finalize())
}

fn report(pass: &str, result: &ProcessingResult, out: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let vertices: usize = result.meshes.iter().map(|m| m.positions.len() / 3).sum();
    let triangles: usize = result.meshes.iter().map(|m| m.indices.len() / 3).sum();
    let meshes: Vec<Value> = result.meshes.iter().map(serde_json::to_value).collect::<Result<_, _>>()?;
    let output = serde_json::to_vec(&json!({
        "buildingTransform": result.building_transform,
        "coordinateSpace": result.mesh_coordinate_space,
        "frame": format!("{:?}", result.frame),
        "meshes": meshes,
        "metadata": result.metadata,
        "siteTransform": result.site_transform,
    }))?;
    let mut stats = serde_json::to_value(&result.stats)?;
    if let Value::Object(map) = &mut stats {
        map.retain(|key, _| !key.ends_with("_time_ms") && !key.ends_with("TimeMs"));
    }
    let diagnostics = serde_json::to_vec_pretty(&stats)?;
    std::fs::write(format!("{out}.{pass}.diagnostics.json"), &diagnostics)?;
    Ok(json!({
        "meshes": result.meshes.len(),
        "vertices": vertices,
        "triangles": triangles,
        "instances": result.instances.len(),
        "geometryPayloadFnv1a64": fingerprint::mesh_fingerprint(&result.meshes),
        "outputSha256": sha(&output),
        "instancesSha256": instances_sha(&result.instances),
        "diagnosticsSha256": sha(&diagnostics),
        "hasGeometryDiagnostics": result.stats.geometry_diagnostics.is_some(),
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: x2_identity_probe <input.ifc> <out-prefix>".into());
    }
    let content = std::fs::read(&args[0])?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build()?;
    let flat = pool.install(|| process_geometry(&content));
    let instanced = pool.install(|| {
        let request = ProcessingRequest::full_pass().retain_meshes(true).instancing(true);
        process(&content, &request, &mut ())
    });
    println!(
        "X2_IDENTITY {}",
        json!({
            "flat": report("flat", &flat, &args[1])?,
            "instanced": report("instanced", &instanced, &args[1])?,
        })
    );
    Ok(())
}
