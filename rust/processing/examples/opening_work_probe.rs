// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6537 whole-fixture work diagnostic, not a benchmark or alternate loader.
//! One Rayon worker lets the caller drain every thread-local counter from the
//! same worker that runs the canonical processor. The processor owns RTC setup.
//! Feature-off runs provide output controls without diagnostic instrumentation.
//! Usage: opening_work_probe <input.ifc> <capture.json>

#[path = "perf_probe/fingerprint.rs"]
mod fingerprint;

use ifc_lite_processing::{process_geometry, ProcessingResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, io::Write, path::Path};

fn write_capture(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)?.write_all(bytes)
}

fn process_and_drain(content: &[u8]) -> (ProcessingResult, Value) {
    #[cfg(feature = "opening-perf-trace")]
    ifc_lite_geometry::opening_perf_trace::take();
    let result = process_geometry(content);
    #[cfg(feature = "opening-perf-trace")]
    let counters = json!(ifc_lite_geometry::opening_perf_trace::take());
    #[cfg(not(feature = "opening-perf-trace"))]
    let counters = Value::Null;
    (result, counters)
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: opening_work_probe <input.ifc> <capture.json>".into());
    }
    let content = std::fs::read(&args[0])?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build()?;
    let (result, counters) = pool.install(|| process_and_drain(&content));
    if !result.instances.is_empty() {
        return Err("Default diagnostic route unexpectedly emitted native-only instances".into());
    }
    // Ordered, exact float-bit geometry payload witness, outside any timing.
    // Its exclusions are documented in the shared fingerprint module.
    let mesh_fingerprint = fingerprint::mesh_fingerprint(&result.meshes);
    let mut per_element: BTreeMap<u32, [u64; 3]> = BTreeMap::new();
    for mesh in &result.meshes {
        let counts = per_element.entry(mesh.express_id).or_default();
        counts[0] += 1;
        counts[1] += (mesh.positions.len() / 3) as u64;
        counts[2] += (mesh.indices.len() / 3) as u64;
    }
    let vertices: u64 = per_element.values().map(|v| v[1]).sum();
    let triangles: u64 = per_element.values().map(|v| v[2]).sum();
    let per_element: BTreeMap<_, _> = per_element.into_iter().map(|(id, v)| {
        (id, json!({ "meshes": v[0], "vertices": v[1], "triangles": v[2] }))
    }).collect();
    // Keep serialized default output alongside the narrower FNV. Native-only
    // instances are not serializable and were required empty above. Timings
    // and counters are deliberately outside this identity witness.
    let capture = json!({
        "entryPoint": "ifc_lite_processing::process_geometry (default options)",
        "frame": format!("{:?}", result.frame),
        "coordinateSpace": result.mesh_coordinate_space,
        "siteTransform": result.site_transform,
        "buildingTransform": result.building_transform,
        "metadata": result.metadata,
        "meshes": result.meshes,
    });
    let capture_bytes = serde_json::to_vec(&capture)?;
    // Atomic refusal protects the input and any existing output aliases.
    write_capture(Path::new(&args[1]), &capture_bytes)?;
    println!("{}", serde_json::to_string_pretty(&json!({
        "schemaVersion": 1,
        "diagnosticOnly": true,
        "scope": "Whole-fixture native canonical work; no elapsed-time or browser-pool verdict",
        "rayonWorkers": 1,
        "instrumented": cfg!(feature = "opening-perf-trace"),
        "inputBytes": content.len(),
        "inputSha256": format!("{:x}", Sha256::digest(&content)),
        "meshes": capture["meshes"].as_array().map_or(0, Vec::len),
        "vertices": vertices,
        "triangles": triangles,
        "instances": 0,
        "perExpressId": per_element,
        "geometryPayloadFnv1a64": mesh_fingerprint,
        "captureSha256": format!("{:x}", Sha256::digest(&capture_bytes)),
        "counters": counters,
    }))?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::write_capture;

    #[test]
    fn issue_6537_capture_refuses_existing_input_without_changing_its_bytes() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .expect("system clock").as_nanos();
        let path = std::env::temp_dir().join(format!("ifc-opening-capture-{}-{nonce}", std::process::id()));
        let original = b"existing IFC input must survive an aliased capture path";
        std::fs::write(&path, original).expect("create existing-input fixture");
        let error = write_capture(&path, b"new capture").expect_err("refuse existing target");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&path).expect("read input"), original);
        std::fs::remove_file(&path).expect("remove input fixture");
        write_capture(&path, b"new capture").expect("create fresh capture");
        assert_eq!(std::fs::read(&path).expect("read capture"), b"new capture");
        std::fs::remove_file(&path).expect("remove capture fixture");
    }
}
