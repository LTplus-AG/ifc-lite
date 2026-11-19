// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! M1 native reference for the browser parity scaffold
//! (`rust/wasm-bindings/src/retained_browser/parity_tests.rs`): the same unit
//! rectangle extruded 1 m along +Z, evaluated by the real native SMLib worker.
//! The browser test reads it from `/smlib/m1-native-unit-rectangle.json`.
//! Nothing wrote that file before, so the browser test always skipped (#7955).
//! The volume is checked against the analytic oracle (1 m^3) before it is
//! written: the browser compares against a value that is itself verified.
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture, AnalyticStatus};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion};
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};

/// The browser test's request, byte for byte (`bridge_tests.rs` `request(RECTANGLE, ..)`).
const DATA: &str = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);\
#90=IFCCARTESIANPOINT((0.,0.,0.));#91=IFCAXIS2PLACEMENT3D(#90,$,$);\
#92=IFCDIRECTION((0.,0.,1.));#93=IFCEXTRUDEDAREASOLID(#4,#91,#92,1.);";

#[test]
fn m1_native_unit_rectangle_reference() {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "M1 requires the real SDK worker");
        eprintln!("SKIP M1 native reference: IFCLITE_SMLIB_WORKER absent; not qualification");
        return;
    };
    let mut worker = SmlibWorker::spawn(path).expect("configured worker must start");
    let mut decoder = EntityDecoder::with_index(DATA.as_bytes(), build_entity_index(DATA.as_bytes()));
    let entity = decoder.decode_by_id(93).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    assert_eq!(source.status, AnalyticStatus::Complete);
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion { source, length_unit_scale: 1. })
        .unwrap();
    let request = document.prepare_retained(definition, worker.incarnation()).unwrap();
    let realization = worker
        .evaluate_retained(request, 0.001, 5., MeshLimits::default())
        .unwrap();
    // The browser test's own measure: the signed triangle volume of the f64 mesh.
    let mesh = &realization.completion().tessellation;
    let p = |i: u32| {
        let i = i as usize * 3;
        [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]
    };
    let volume = mesh
        .indices
        .chunks_exact(3)
        .map(|t| {
            let [a, b, c] = [p(t[0]), p(t[1]), p(t[2])];
            (a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.
        })
        .sum::<f64>()
        .abs();
    assert!((volume - 1.).abs() <= 1e-9, "unit rectangle x 1 m: volume {volume}");
    let reference = serde_json::json!({ "fixture": "unit-rectangle-1m", "volume": volume });
    if let Some(out) = std::env::var_os("IFCLITE_M1_REFERENCE") {
        std::fs::write(out, serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    }
    eprintln!("sdk witness executed: m1_native_unit_rectangle_reference");
}
