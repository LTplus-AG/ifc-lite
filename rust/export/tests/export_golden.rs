// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Export golden corpus (#7671, charter #7670 §2 T3, gate G8).
//!
//! Every export format over a small fixture set (the IFC-bytes exporters, and
//! the `*_from_meshes` GLB/COLLADA/KMZ writers over the native pipeline's
//! meshes), each output pinned as an
//! FNV-1a 64 hash in `golden/<format>.json`. A refactor (class R) must leave
//! every pin it can reach unchanged; a behaviour change (class X) re-pins only
//! the formats that moved and says why per case. See `support/golden.rs` for
//! the file format and the re-pin rule.
//!
//! Catalogued fixtures skip when absent and fail under
//! `IFC_LITE_REQUIRE_FIXTURES=1` (the shared `src/test_support.rs` rule);
//! the in-tree fixtures always run. Every input that could carry a clock is
//! fixed here (`STAMP`), so a pin moves only when the output does.

#[path = "../src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the unit tests; this file uses `fixture_opt` only
mod test_support;
#[path = "support/golden.rs"]
mod golden;

use std::path::Path;

use golden::Golden;
use ifc_lite_export::*;

/// Fixed `FILE_NAME` time stamp and LandXML date/time.
const STAMP: &str = "2026-01-01T00:00:00";

/// `(key, path)`: catalogued paths are under `tests/models/`, in-tree ones are
/// repo-relative and start with `rust/`.
const FIXTURES: &[(&str, &str)] = &[
    ("AC20-FZK-Haus", "ara3d/AC20-FZK-Haus.ifc"),
    ("IfcOpenHouse_IFC4", "ara3d/IfcOpenHouse_IFC4.ifc"),
    ("duplex", "ara3d/duplex.ifc"),
    ("bonsai-terrain", "landxml/federation/bonsai-topo-control-v1/terrain.ifc"),
    ("bath_csg_solid", "rust/geometry/tests/fixtures/bath_csg_solid.ifc"),
    ("mapped_instances_synthetic", "rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc"),
    ("wall_two_openings", "rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc"),
];

fn load(path: &str) -> Option<Vec<u8>> {
    if path.starts_with("rust/") {
        let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
        Some(std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}")))
    } else {
        test_support::fixture_opt(path)
    }
}

/// Every present fixture, in table order.
fn fixtures() -> Vec<(&'static str, Vec<u8>)> {
    FIXTURES.iter().filter_map(|(key, path)| load(path).map(|bytes| (*key, bytes))).collect()
}

fn golden(format: &'static str) -> Golden {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    // The test fn is the format name with `_` for `-`, so the command re-pins this format only.
    let test = format.replace('-', "_");
    Golden::new(&dir, format, &format!("cargo test -p ifc-lite-export --features parquet-bos --test export_golden -- --exact {test}"))
}

fn keys(suffixes: &[&str]) -> Vec<String> {
    FIXTURES.iter().flat_map(|(k, _)| suffixes.iter().map(move |s| format!("{k}{s}"))).collect()
}

/// A `Result` output: the bytes, or the refusal text, so a changed refusal moves the pin too.
fn bytes_or_refusal<E: std::fmt::Display>(r: Result<Vec<u8>, E>) -> Vec<u8> {
    r.unwrap_or_else(|e| format!("REFUSED: {e}").into_bytes())
}

/// `bytes` with the crate version replaced by a fixed token. USD's `generator`
/// and LandXML's `<Application version>` embed it, so without this every
/// release's version bump would move their pins with no output change. The
/// assertion keeps the normalisation from silently stopping to apply.
fn without_version(format: &str, bytes: Vec<u8>) -> Vec<u8> {
    let text = String::from_utf8(bytes).expect("a versioned output is text");
    let version = env!("CARGO_PKG_VERSION");
    assert!(text.contains(version), "{format}: the crate version {version} no longer appears; drop the normalisation");
    text.replace(version, "<CRATE_VERSION>").into_bytes()
}

/// One output per fixture.
fn per_fixture(format: &'static str, export: impl Fn(&[u8]) -> Vec<u8>) {
    let mut g = golden(format);
    for (key, bytes) in fixtures() {
        g.record(key, &export(&bytes));
    }
    g.finish(&keys(&[""]));
}

fn step_options(schema: Option<&str>) -> StepOptions {
    StepOptions { schema: schema.map(str::to_string), time_stamp: Some(STAMP.into()), ..StepOptions::default() }
}

/// The other schema family, so every fixture also crosses the converter.
fn other_schema(content: &[u8]) -> &'static str {
    let head = String::from_utf8_lossy(&content[..content.len().min(4096)]).to_ascii_uppercase();
    if head.contains("'IFC2X3'") { "IFC4" } else { "IFC2X3" }
}

#[test]
fn step() {
    let mut g = golden("step");
    for (key, bytes) in fixtures() {
        let preserve = export_step(&bytes, &step_options(None)).map(String::into_bytes);
        g.record(key, &bytes_or_refusal(preserve));
        let target = other_schema(&bytes);
        let converted = export_step(&bytes, &step_options(Some(target))).map(String::into_bytes);
        g.record(format!("{key}->{target}"), &bytes_or_refusal(converted));
    }
    let mut expected = keys(&[""]);
    expected.extend(keys(&["->IFC4", "->IFC2X3"]));
    g.finish(&expected);
}

/// The `#id` and type of each `#id=TYPE(` record line.
fn records(content: &[u8]) -> impl Iterator<Item = (u32, String, &[u8])> {
    content.split(|&b| b == b'\n').filter_map(|line| {
        let text = std::str::from_utf8(line).ok()?.trim_start();
        let (id, rest) = text.strip_prefix('#')?.split_once('=')?;
        let ty = rest.trim_start().split('(').next()?.trim().to_ascii_uppercase();
        Some((id.trim().parse().ok()?, ty, line))
    })
}

/// The project, else the first rooted non-relationship record, else the first
/// wall (`wall_two_openings` has no project and a 21-character GlobalId).
fn log_target(content: &[u8]) -> u32 {
    let all: Vec<_> = records(content).collect();
    let rooted = |(_, ty, line): &&(u32, String, &[u8])| !ty.starts_with("IFCREL") && leading_rooted_global_id(line).is_some();
    all.iter()
        .find(|(_, ty, _)| ty == "IFCPROJECT")
        .or_else(|| all.iter().find(rooted))
        .or_else(|| all.iter().find(|(_, ty, _)| ty.starts_with("IFCWALL")))
        .expect("every fixture has a project, a rooted record or a wall")
        .0
}

#[test]
fn step_log() {
    per_fixture("step-log", |bytes| {
        let id = log_target(bytes);
        let log = serde_json::json!({ "modelId": "golden", "mutations": [
            { "id": "m1", "type": "UPDATE_ATTRIBUTE", "entityId": id, "attributeName": "Name",
              "oldValue": null, "newValue": "golden renamed" },
            { "id": "m2", "type": "CREATE_PROPERTY", "entityId": id, "psetName": "Golden_Pset",
              "propName": "Pinned", "oldValue": null, "newValue": "yes", "valueType": 0 },
        ]});
        let log = MutationLog::from_json(&log.to_string()).expect("log parses");
        bytes_or_refusal(export_step_with_log(bytes, &step_options(None), &log).map(|(s, _)| s.into_bytes()))
    });
}

#[test]
fn merged_step() {
    let mut g = golden("merged-step");
    let present = fixtures();
    let model = |key: &str, content| MergedModel { content, id: key.to_string(), included: None };
    for (key, bytes) in &present {
        g.record(*key, export_merged_models(&[model(key, bytes)], &MergedOptions::default()).0.as_bytes());
    }
    // One federation: two authoring tools, the same schema.
    const PAIR: [&str; 2] = ["AC20-FZK-Haus", "IfcOpenHouse_IFC4"];
    let pair: Vec<_> = PAIR.iter().filter_map(|k| present.iter().find(|(p, _)| p == k)).collect();
    if pair.len() == 2 {
        let models: Vec<_> = pair.iter().map(|(k, b)| model(k, b)).collect();
        g.record(PAIR.join("+"), export_merged_models(&models, &MergedOptions::default()).0.as_bytes());
    }
    let mut expected = keys(&[""]);
    expected.push(PAIR.join("+"));
    g.finish(&expected);
}

#[test]
fn glb() {
    per_fixture("glb", |bytes| bytes_or_refusal(try_export_glb(bytes, &GltfOptions::default())));
}

#[test]
fn obj() {
    per_fixture("obj", |bytes| bytes_or_refusal(export_obj(bytes, &ObjOptions::default()).map(String::into_bytes)));
}

#[test]
fn usd() {
    per_fixture("usd", |bytes| without_version("usd", bytes_or_refusal(export_usd(bytes, &UsdOptions::default()).map(String::into_bytes))));
}

#[test]
fn csv() {
    const MODES: [(&str, CsvMode); 4] = [
        (":entities", CsvMode::Entities),
        (":properties", CsvMode::Properties),
        (":quantities", CsvMode::Quantities),
        (":spatial", CsvMode::SpatialHierarchy),
    ];
    let mut g = golden("csv");
    let opts = CsvOptions { include_properties: true, ..CsvOptions::default() };
    for (key, bytes) in fixtures() {
        for (suffix, mode) in MODES {
            g.record(format!("{key}{suffix}"), export_csv(&bytes, mode, &opts).as_bytes());
        }
    }
    g.finish(&keys(&MODES.map(|(s, _)| s)));
}

#[test]
fn json() {
    per_fixture("json", |bytes| export_json(bytes, &JsonOptions::default()).into_bytes());
}

/// `.bos` is behind the off-by-default `parquet-bos` feature, which CI runs in
/// `rust-full` (`cargo test -p ifc-lite-export --features parquet-bos`).
#[cfg(feature = "parquet-bos")]
#[test]
fn parquet_bos() {
    per_fixture("parquet-bos", |bytes| bytes_or_refusal(export_bos(bytes, &ParquetBosOptions::default())));
}

#[test]
fn hbjson() {
    per_fixture("hbjson", |bytes| export_hbjson(bytes, &HbjsonOptions::default()).into_bytes());
}

#[test]
fn dfjson() {
    per_fixture("dfjson", |bytes| export_dfjson(bytes, &DfjsonOptions::default()).into_bytes());
}

/// Only a fixture with an authored terrain TIN has anything to export; the
/// others would pin the same "no terrain" refusal seven times.
#[test]
fn landxml_terrain() {
    let mut g = golden("landxml-terrain");
    let (date, time) = STAMP.split_once('T').unwrap();
    for (key, bytes) in fixtures() {
        let ids: Vec<u32> =
            records(&bytes).filter(|(_, ty, _)| ty == "IFCGEOGRAPHICELEMENT").map(|(id, _, _)| id).collect();
        if ids.is_empty() {
            continue;
        }
        let export = try_export_landxml_terrain(&bytes, &ids, &LandXmlTerrainOptions::new(date, time));
        let xml = export.map(|e| without_version("landxml-terrain", e.xml.into_bytes()));
        g.record(key, &bytes_or_refusal(xml.map_err(|r| r.reason)));
    }
    g.finish(&["bonsai-terrain".to_string()]);
}

#[test]
fn jsonld() {
    per_fixture("jsonld", |bytes| export_jsonld(bytes, &JsonLdOptions::default()).into_bytes());
}

#[test]
fn ifcx() {
    per_fixture("ifcx", |bytes| export_ifc5(bytes, &Ifc5Options::default()).into_bytes());
}

/// The `*_from_meshes` exporters take the viewer's flattened mesh buffers, not
/// IFC bytes. The buffers here are the native pipeline's meshes (Z-up,
/// zero origins), flattened the way `exportGlbFromMeshes` / `exportKmzFromMeshes`
/// receive them: a byte oracle of the writers over realistic input, not of the
/// viewer's frame conversion.
struct MeshBuffers {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    vertex_counts: Vec<u32>,
    index_counts: Vec<u32>,
    colors: Vec<f32>,
    origins: Vec<f64>,
    express_ids: Vec<u32>,
}

fn mesh_buffers(content: &[u8]) -> MeshBuffers {
    let meshes = ifc_lite_processing::process_geometry(content).meshes;
    let mut b = MeshBuffers {
        positions: Vec::new(),
        normals: Vec::new(),
        indices: Vec::new(),
        vertex_counts: Vec::new(),
        index_counts: Vec::new(),
        colors: Vec::new(),
        origins: Vec::new(),
        express_ids: Vec::new(),
    };
    for m in &meshes {
        b.positions.extend_from_slice(&m.positions);
        b.normals.extend_from_slice(&m.normals);
        b.indices.extend_from_slice(&m.indices);
        b.vertex_counts.push((m.positions.len() / 3) as u32);
        b.index_counts.push(m.indices.len() as u32);
        b.colors.extend_from_slice(&m.color);
        b.origins.extend_from_slice(&[0.0; 3]);
        b.express_ids.push(m.express_id);
    }
    b
}

#[test]
fn glb_from_meshes() {
    per_fixture("glb-from-meshes", |bytes| {
        let b = mesh_buffers(bytes);
        let glb = try_export_glb_from_meshes(
            &b.positions, &b.normals, &b.indices, &b.vertex_counts, &b.index_counts, &b.colors, &b.origins,
            &b.express_ids, true, true, false, None,
        );
        bytes_or_refusal(glb.map(|(glb, _)| glb))
    });
}

#[test]
fn collada() {
    per_fixture("collada", |bytes| {
        let b = mesh_buffers(bytes);
        bytes_or_refusal(try_export_collada_from_meshes(
            &b.positions, &b.normals, &b.indices, &b.vertex_counts, &b.index_counts, &b.colors, &b.origins,
        ))
    });
}

#[test]
fn kmz() {
    // A fixed placement, so the KML carries a real location and heading.
    let opts = KmzOptions { latitude: 47.0, longitude: 8.0, altitude: 400.0, x_axis_abscissa: Some(0.6), x_axis_ordinate: Some(0.8), ..KmzOptions::default() };
    per_fixture("kmz", |bytes| {
        let b = mesh_buffers(bytes);
        bytes_or_refusal(try_export_kmz_collada_from_meshes(
            &b.positions, &b.normals, &b.indices, &b.vertex_counts, &b.index_counts, &b.colors, &b.origins, &opts,
        ))
    });
}
