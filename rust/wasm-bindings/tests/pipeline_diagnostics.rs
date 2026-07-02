// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! wasm round-trip smoke test for the `getPipelineDiagnostics` channel
//! (run with `wasm-pack test --node rust/wasm-bindings --test pipeline_diagnostics`).
//!
//! Loads a tiny inline IFC through the NORMAL load path
//! (`processGeometryBatch`) and asserts the getter returns a populated JS
//! object with the expected `schemaVersion`, then that a load reset
//! (`clearPrePassCache`) empties it again.

#![cfg(target_arch = "wasm32")]

use ifc_lite_wasm::IfcAPI;
use wasm_bindgen::JsValue;
use wasm_bindgen_test::wasm_bindgen_test;

/// One wall carrying a bare IfcTriangulatedFaceSet body (same neutral fixture
/// shape as rust/processing/tests/styling_default_colors.rs).
const TINY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('pipeline diagnostics smoke fixture'),'2;1');
FILE_NAME('tiny.ifc','2026-07-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#10=IFCWALL('1WallPipelineDiag0001',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Scan the fixture for geometry-bearing entities and return the
/// `(id, start, end)` triples `processGeometryBatch` expects.
fn jobs_flat(content: &[u8]) -> Vec<u32> {
    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    let mut jobs = Vec::new();
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if ifc_lite_core::has_geometry_by_name(type_name) {
            jobs.extend_from_slice(&[id, start as u32, end as u32]);
        }
    }
    jobs
}

fn get_u64(obj: &JsValue, key: &str) -> u64 {
    js_sys::Reflect::get(obj, &JsValue::from_str(key))
        .unwrap_or(JsValue::UNDEFINED)
        .as_f64()
        .unwrap_or_else(|| panic!("key {key} missing or not a number")) as u64
}

#[wasm_bindgen_test]
fn get_pipeline_diagnostics_round_trips_a_normal_load() {
    let api = IfcAPI::new();

    // Before any batch: undefined, so consumers can gate on presence.
    assert!(api.get_pipeline_diagnostics().is_undefined());

    let content = TINY_IFC.as_bytes();
    let jobs = jobs_flat(content);
    assert!(!jobs.is_empty(), "fixture must contain geometry jobs");

    // The NORMAL load path: one processGeometryBatch call, no RTC shift,
    // no voids/styles/materials.
    let collection = api.process_geometry_batch(
        content,
        &jobs,
        1.0,
        0.0,
        0.0,
        0.0,
        false,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
        None,
        None,
        None,
    );
    drop(collection);

    let diag = api.get_pipeline_diagnostics();
    assert!(!diag.is_undefined(), "diagnostics must be populated after a batch");
    assert_eq!(get_u64(&diag, "schemaVersion"), 1, "schemaVersion contract");
    assert_eq!(get_u64(&diag, "batches"), 1);
    assert_eq!(get_u64(&diag, "elementCount"), 1, "one wall job");
    assert!(get_u64(&diag, "meshCount") >= 1, "the wall must mesh");
    assert!(get_u64(&diag, "triangleCount") >= 4, "4-triangle tetrahedron body");
    // Counters exist even when zero (serde contract, not presence-optional).
    assert_eq!(get_u64(&diag, "totalCsgFailures"), 0);
    assert_eq!(get_u64(&diag, "backstopCount"), 0);
    let phase_ms = js_sys::Reflect::get(&diag, &JsValue::from_str("phaseMs")).unwrap();
    assert!(!phase_ms.is_undefined(), "phaseMs object present");
    // geometryMs is JS-clock measured; only assert it exists and is numeric.
    let _ = get_u64(&phase_ms, "geometryMs");

    // A second batch accumulates.
    let collection = api.process_geometry_batch(
        content,
        &jobs,
        1.0,
        0.0,
        0.0,
        0.0,
        false,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
        None,
        None,
        None,
    );
    drop(collection);
    let diag = api.get_pipeline_diagnostics();
    assert_eq!(get_u64(&diag, "batches"), 2);
    assert_eq!(get_u64(&diag, "elementCount"), 2);

    // clearPrePassCache is end-of-load cleanup (it runs in the JS load
    // wrapper's `finally`, after the last batch). Diagnostics MUST survive it
    // so a host can read the completed load's numbers; only the caches drop.
    api.clear_pre_pass_cache();
    let after_clear = api.get_pipeline_diagnostics();
    assert!(!after_clear.is_undefined(), "diagnostics survive end-of-load clearPrePassCache");
    assert_eq!(get_u64(&after_clear, "batches"), 2);

    // set_entity_index is the load START boundary (a new file) — it resets the
    // accumulator, so the next load begins fresh. A minimal one-entry index is
    // enough to pass its non-empty guard and reach the reset.
    api.set_entity_index(&[1u32], &[0u32], &[1u32]);
    assert!(
        api.get_pipeline_diagnostics().is_undefined(),
        "a new entity index (new load) resets diagnostics"
    );
}
