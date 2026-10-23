// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust half of the empty-export pin (#7695, EXPORT-GEOM-9/15).
//!
//! Every from-bytes exporter runs over the shared vectors in
//! `tests/fixtures/empty_export_vectors.json`. Render-geometry formats must
//! refuse a model with nothing to draw (`NO_RENDER_GEOMETRY`); data formats
//! must export it, because an empty table or graph is still a valid document.
//! The wasm entry points (`scripts/lib/wasm-empty-export-contracts.mjs`) and
//! the TS policy table and content counters
//! (`packages/export/src/zero-content.parity.test.ts`) are held to the SAME
//! file.

use ifc_lite_export::*;
use serde_json::Value;

const VECTORS: &str = include_str!("fixtures/empty_export_vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("the vectors parse")
}

/// The case's IFC bytes: inline, or a git-tracked repo-relative path.
fn case_bytes(case: &Value) -> Vec<u8> {
    if let Some(ifc) = case["ifc"].as_str() {
        return ifc.as_bytes().to_vec();
    }
    let rel = case["path"].as_str().expect("a case has `ifc` or `path`");
    let abs = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&abs).unwrap_or_else(|e| panic!("{abs}: {e}"))
}

fn code<T>(r: Result<T, ExportError>) -> String {
    match r {
        Ok(_) => "ok".to_string(),
        Err(e) => e.code().to_string(),
    }
}

/// The outcome of one from-bytes exporter, as the code the vectors name.
fn outcome(format: &str, bytes: &[u8], isolate_none: bool) -> String {
    let isolated = isolate_none.then(Vec::new);
    let gltf = || GltfOptions::default().with_isolated(isolated.clone());
    match format {
        "glb" => code(try_export_glb(bytes, &gltf())),
        "gltf" => {
            let mut handed = 0usize;
            let r = export_gltf_streaming(bytes, &gltf(), 1 << 20, |_| handed += 1);
            if r.is_err() {
                assert_eq!(handed, 0, "a refused multi-buffer glTF handed the sink a buffer");
            }
            code(r)
        }
        "obj" => code(export_obj(bytes, &ObjOptions { isolated, ..ObjOptions::default() })),
        "usd" => code(export_usd(bytes, &UsdOptions::default())),
        // The data formats are infallible on an empty model by contract: each
        // returns a document, which is checked for being one.
        "csv" => {
            let csv = export_csv(bytes, CsvMode::Entities, &CsvOptions::default());
            assert!(!csv.is_empty(), "csv: an empty model still has a header row");
            "ok".into()
        }
        "json" => parsed(&export_json(bytes, &JsonOptions::default())),
        "jsonld" => parsed(&export_jsonld(bytes, &JsonLdOptions::default())),
        "ifcx" => parsed(&export_ifc5(bytes, &Ifc5Options::default())),
        "hbjson" => parsed(&export_hbjson(bytes, &HbjsonOptions::default())),
        "dfjson" => parsed(&export_dfjson(bytes, &DfjsonOptions::default())),
        "step" => match export_step(bytes, &StepOptions::default()) {
            Ok(step) => {
                assert!(step.contains("DATA;"), "step: a document");
                "ok".into()
            }
            Err(e) => format!("IO: {e}"),
        },
        other => panic!("the vectors name an unknown format {other:?}"),
    }
}

fn parsed(text: &str) -> String {
    serde_json::from_str::<Value>(text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"));
    "ok".into()
}

fn formats(doc: &Value, class: &str) -> Vec<String> {
    doc["policy"][class]["formats"]
        .as_array()
        .unwrap_or_else(|| panic!("policy.{class}.formats"))
        .iter()
        .map(|f| f.as_str().expect("a format name").to_string())
        .collect()
}

/// #7695: every from-bytes exporter answers each vector as pinned. Before the
/// fix the multi-buffer glTF, OBJ and USD returned an artifact (`ok`) where
/// the vectors say `NO_RENDER_GEOMETRY`.
#[test]
fn every_exporter_answers_the_shared_empty_vectors_7695() {
    let doc = vectors();
    let render = formats(&doc, "renderGeometry");
    let data = formats(&doc, "data");
    assert_eq!(doc["policy"]["renderGeometry"]["whenNone"], "NO_RENDER_GEOMETRY");
    assert_eq!(ExportError::NoRenderGeometry.code(), "NO_RENDER_GEOMETRY");
    let mut wrong = Vec::new();
    for case in doc["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("a case name");
        let bytes = case_bytes(case);
        let isolate_none = case["isolateNone"].as_bool().expect("isolateNone");
        for (format, want) in case["expect"].as_object().expect("expect") {
            assert!(render.contains(format) || data.contains(format), "{name}: {format} has no policy class");
            if data.contains(format) {
                assert_eq!(want, "ok", "{name}: a data format never refuses an empty model");
            }
            let got = outcome(format, &bytes, isolate_none);
            if got != *want {
                wrong.push(format!("{name}/{format}: got {got}, want {want}"));
            }
        }
    }
    assert!(wrong.is_empty(), "exports off the shared vectors:\n{}", wrong.join("\n"));
}

/// The data-only case really is data: the attribute exporters see its wall,
/// so "data-only" being refused by the render formats is about geometry,
/// not about an unreadable model.
#[test]
fn the_data_only_case_carries_data_7695() {
    let doc = vectors();
    let case = doc["cases"].as_array().unwrap().iter().find(|c| c["name"] == "data-only").expect("data-only");
    let at_least = case["dataRowsAtLeast"].as_u64().expect("dataRowsAtLeast") as usize;
    let json: Value = serde_json::from_str(&export_json(&case_bytes(case), &JsonOptions::default())).unwrap();
    let rows = json.as_array().expect("an entity array").len();
    assert!(rows >= at_least, "data-only exported {rows} JSON rows, want at least {at_least}");
}
