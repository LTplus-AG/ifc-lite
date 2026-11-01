// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C2-7 (#8263) output-identity witness, injected by `validate.sh identity`
//! into the base export and the head checkout as a processing example, built
//! and removed again. Prints mesh/vertex/triangle counts and SHA-256 digests
//! of the serialized meshes, of every instance record (all fields, floats as
//! bits), of `GeometryDiagnostics` and of the processing stats with
//! wall-clock fields removed. One Rayon worker, default options.

use ifc_lite_processing::{process_geometry, InstanceRecord};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn digest(value: &impl serde::Serialize) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).expect("serialize")))
}

/// Every field of one instance record, floats as bit patterns. Destructured
/// exhaustively, so a new field fails the build instead of escaping the digest.
fn instance_value(record: &InstanceRecord) -> Value {
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
    json!({
        "express_id": express_id,
        "ifc_type": ifc_type,
        "global_id": global_id,
        "name": name,
        "presentation_layer": presentation_layer,
        "color": color.map(f32::to_bits),
        "template_express_id": template_express_id,
        "rep_identity": rep_identity.to_string(),
        "transform": transform.map(f32::to_bits),
        "geometry_item_id": geometry_item_id,
    })
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: c27_identity_probe <input.ifc>");
    let content = std::fs::read(&path).expect("read fixture");
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().expect("pool");
    let result = pool.install(|| process_geometry(&content));
    let mut stats = serde_json::to_value(&result.stats).expect("stats");
    if let Value::Object(map) = &mut stats {
        map.retain(|key, _| !key.ends_with("_ms") && key != "from_cache");
    }
    let diagnostics = &result.stats.geometry_diagnostics;
    let hosts = diagnostics.as_ref().map_or(0, |d| d.hosts_with_openings);
    let instances: Vec<Value> = result.instances.iter().map(instance_value).collect();
    println!(
        "{}",
        json!({
            "fixture": path.rsplit('/').next(),
            "meshes": result.meshes.len(),
            "vertices": result.meshes.iter().map(|m| m.positions.len() / 3).sum::<usize>(),
            "triangles": result.meshes.iter().map(|m| m.indices.len() / 3).sum::<usize>(),
            "meshesSha256": digest(&result.meshes),
            "instances": instances.len(),
            "instancesSha256": digest(&instances),
            "diagnosticsPresent": diagnostics.is_some(),
            "diagnosticHosts": hosts,
            "diagnosticsSha256": digest(diagnostics),
            "statsSha256": digest(&stats),
        })
    );
}
