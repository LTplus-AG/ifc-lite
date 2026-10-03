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

use ifc_lite_processing::{process_geometry, MeshData, ProcessingResult};
use serde::{ser::{SerializeMap, SerializeSeq}, Serialize, Serializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, io::{BufWriter, Write}, path::Path};

fn write_capture<T>(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<T>,
) -> std::io::Result<T> {
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    match write(&mut file) {
        Ok(result) => Ok(result),
        Err(error) => {
            drop(file);
            if let Err(cleanup) = std::fs::remove_file(path) {
                return Err(std::io::Error::new(error.kind(), format!(
                    "Capture write failed: {error}; partial capture cleanup failed: {cleanup}"
                )));
            }
            Err(error)
        }
    }
}

struct HashWriter<W> {
    inner: W,
    sha256: Sha256,
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.sha256.update(&bytes[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Preserve the original Value-based f32 formatting one mesh at a time.
/// A single large mesh Value remains possible; this is not a memory benchmark.
struct MeshValues<'a>(&'a [MeshData]);

impl Serialize for MeshValues<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for mesh in self.0 {
            let value = serde_json::to_value(mesh).map_err(serde::ser::Error::custom)?;
            sequence.serialize_element(&value)?;
        }
        sequence.end()
    }
}

struct Capture<'a>(&'a ProcessingResult);

impl Serialize for Capture<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let result = self.0;
        // Same lexical key order and Value formatting as the original json!.
        let mut map = serializer.serialize_map(Some(7))?;
        map.serialize_entry("buildingTransform", &json!(result.building_transform))?;
        map.serialize_entry("coordinateSpace", &json!(result.mesh_coordinate_space))?;
        map.serialize_entry("entryPoint", "ifc_lite_processing::process_geometry (default options)")?;
        map.serialize_entry("frame", &format!("{:?}", result.frame))?;
        map.serialize_entry("meshes", &MeshValues(&result.meshes))?;
        map.serialize_entry("metadata", &json!(result.metadata))?;
        map.serialize_entry("siteTransform", &json!(result.site_transform))?;
        map.end()
    }
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
    let input_bytes = content.len();
    let input_sha256 = format!("{:x}", Sha256::digest(&content));
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build()?;
    let (result, counters) = pool.install(|| process_and_drain(&content));
    drop(content);
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
    // Hash accepted serialized bytes while streaming; retain neither a complete
    // mesh Value copy nor a complete capture Vec. Flush failure returns no report
    // and removes only the newly-created target; existing files remain refused.
    let capture_sha256 = write_capture(Path::new(&args[1]), |file| {
        let mut writer = HashWriter { inner: BufWriter::new(file), sha256: Sha256::new() };
        serde_json::to_writer(&mut writer, &Capture(&result)).map_err(std::io::Error::other)?;
        writer.flush()?;
        Ok(format!("{:x}", writer.sha256.finalize()))
    })?;
    println!("{}", serde_json::to_string_pretty(&json!({
        "schemaVersion": 1,
        "diagnosticOnly": true,
        "scope": "Whole-fixture native canonical work; no elapsed-time or browser-pool verdict",
        "rayonWorkers": 1,
        "instrumented": cfg!(feature = "opening-perf-trace"),
        "inputBytes": input_bytes,
        "inputSha256": input_sha256,
        "meshes": result.meshes.len(),
        "vertices": vertices,
        "triangles": triangles,
        "instances": 0,
        "perExpressId": per_element,
        "geometryPayloadFnv1a64": mesh_fingerprint,
        "captureSha256": capture_sha256,
        "counters": counters,
    }))?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_6537_capture_refuses_existing_input_without_changing_its_bytes() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .expect("system clock").as_nanos();
        let path = std::env::temp_dir().join(format!("ifc-opening-capture-{}-{nonce}", std::process::id()));
        let original = b"existing IFC input must survive an aliased capture path";
        std::fs::write(&path, original).expect("create existing-input fixture");
        let error = write_capture(&path, |file| file.write_all(b"new capture"))
            .expect_err("refuse existing target");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&path).expect("read input"), original);
        std::fs::remove_file(&path).expect("remove input fixture");
        write_capture(&path, |file| file.write_all(b"new capture"))
            .expect("create fresh capture");
        assert_eq!(std::fs::read(&path).expect("read capture"), b"new capture");
        std::fs::remove_file(&path).expect("remove capture fixture");
    }

    #[test]
    fn issue_6537_failed_capture_write_removes_partial_file_and_allows_retry() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .expect("system clock").as_nanos();
        let path = std::env::temp_dir().join(format!("ifc-partial-capture-{}-{nonce}", std::process::id()));
        let error = write_capture(&path, |file| {
            file.write_all(b"partial capture")?;
            Err::<(), _>(std::io::Error::new(std::io::ErrorKind::WriteZero, "injected write failure"))
        }).expect_err("report failed write");
        assert_eq!(error.kind(), std::io::ErrorKind::WriteZero);
        assert!(!path.exists(), "remove the newly-created partial output");
        write_capture(&path, |file| file.write_all(b"complete retry")).expect("retry capture");
        assert_eq!(std::fs::read(&path).expect("read retry"), b"complete retry");
        std::fs::remove_file(&path).expect("remove retry fixture");
    }

    #[test]
    fn issue_6537_streamed_mesh_capture_preserves_value_float_format_and_hash() {
        // Direct f32 JSON emits a shorter decimal than the original Value/f64
        // capture. Keep that compatibility contract without copying all meshes.
        let meshes = vec![MeshData::new(1, "IfcWall".into(),
            vec![1.0 / 3.0, -0.0, 0.1], vec![0.0, 1.0, 0.0], vec![], [0.7; 4])];
        let mut writer = HashWriter { inner: Vec::new(), sha256: Sha256::new() };
        serde_json::to_writer(&mut writer, &MeshValues(&meshes)).expect("stream mesh values");
        writer.flush().expect("flush stream");
        let parsed: Value = serde_json::from_slice(&writer.inner).expect("parse capture");
        assert_eq!(parsed[0]["positions"][0].as_f64(), Some(f64::from(meshes[0].positions[0])));
        assert_eq!(writer.inner, serde_json::to_vec(&json!(meshes)).expect("original capture layout"));
        assert_eq!(format!("{:x}", writer.sha256.finalize()),
            format!("{:x}", Sha256::digest(&writer.inner)));
    }
}
