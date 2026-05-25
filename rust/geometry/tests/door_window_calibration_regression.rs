// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for the door/window calibration findings.
//!
//! Per the geometry-correctness calibration report, this defect class was
//! the worst single one in the report (~173 instances across duplex,
//! AC20-FZK-Haus, advanced_model). Symptoms cited: "vertex_ratio = 0.17",
//! "bbox IoU 0.03–0.15", and "leaf/panel is generated in the wrong
//! location relative to the host opening."
//!
//! Investigation result: against the current kernel, side-by-side dumps
//! against IfcOpenShell pip 0.8.2 (with `use-world-coords=True` and
//! `weld-vertices=True`) show:
//!
//! - Triangle counts match exactly element-by-element.
//! - Bounding boxes match exactly element-by-element when the router is
//!   constructed with `GeometryRouter::with_units(content, decoder)` so
//!   that `IfcSIUnit` length-unit-prefix conversion is applied.
//! - The vertex-count gap is the unwelded-triangle-soup factor flagged
//!   separately in the report (defect class 3 — every triangle is stored
//!   as 3 independent vertices on the ifc-lite side, while IOS welds).
//!
//! The "bbox IoU < 0.5" failure for advanced_model German doors is purely
//! the unit-scale: that file declares `IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,
//! .METRE.)`, so a router constructed without `with_units` emits raw
//! file-unit coordinates (millimetres) while the dumper compares against
//! IOS metres — a deterministic 1000× offset across every element.
//!
//! This test pins both halves of the finding so any future regression of
//! the unit-scale pathway or the per-element placement chain is caught.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

fn bbox(positions: &[f32]) -> Option<((f32, f32, f32), (f32, f32, f32))> {
    if positions.is_empty() {
        return None;
    }
    let mut mn = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut mx = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for c in positions.chunks_exact(3) {
        mn.0 = mn.0.min(c[0]);
        mn.1 = mn.1.min(c[1]);
        mn.2 = mn.2.min(c[2]);
        mx.0 = mx.0.max(c[0]);
        mx.1 = mx.1.max(c[1]);
        mx.2 = mx.2.max(c[2]);
    }
    Some((mn, mx))
}

fn approx(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}

/// `advanced_model.ifc` is authored in millimetres
/// (`IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`). Confirm that
/// `with_units` detects the prefix and that the resulting world-space
/// bbox lines up with IfcOpenShell's `use-world-coords=True` output to
/// within 1 mm. If this regresses, the calibration framework's German
/// door bbox-IoU failures will return.
#[test]
fn advanced_model_door_world_bbox_matches_ios_in_metres() {
    let path = "../../tests/models/ara3d/advanced_model.ifc";
    if !std::path::Path::new(path).exists() {
        eprintln!("skipping: fixture missing at {path}");
        return;
    }
    let content = std::fs::read_to_string(path).expect("read");
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    assert!(
        (router.unit_scale() - 0.001).abs() < 1e-12,
        "unit_scale must be 0.001 for advanced_model.ifc (uses MILLI metre); got {}",
        router.unit_scale()
    );

    // Drehflügel 1-flg - Stahlzarge #561323. IOS dump (pip 0.8.2,
    // use-world-coords + weld-vertices) gives bbox min ≈ (+12.27, +7.47,
    // +0.24) m and extent ≈ (0.934, 0.275, 2.134) m. The triangle count
    // is 600 in both engines.
    let door = decoder.decode_by_id(561323).expect("decode door");
    assert_eq!(door.ifc_type, IfcType::IfcDoor);
    let mesh = router.process_element(&door, &mut decoder).expect("process");

    let (mn, mx) = bbox(&mesh.positions).expect("non-empty mesh");
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);

    let tol = 0.001_f32; // 1 mm
    assert!(approx(mn.0, 12.267, tol), "min.x = {} (expected ≈ 12.267)", mn.0);
    assert!(approx(mn.1, 7.467, tol), "min.y = {} (expected ≈ 7.467)", mn.1);
    assert!(approx(mn.2, 0.244, tol), "min.z = {} (expected ≈ 0.244)", mn.2);
    assert!(approx(ext.0, 0.934, tol), "extent.x = {} (expected ≈ 0.934)", ext.0);
    assert!(approx(ext.1, 0.275, tol), "extent.y = {} (expected ≈ 0.275)", ext.1);
    assert!(approx(ext.2, 2.134, tol), "extent.z = {} (expected ≈ 2.134)", ext.2);

    let tri_count = mesh.indices.len() / 3;
    assert_eq!(tri_count, 600, "triangle count regression vs IOS ground truth");
}

/// `duplex.ifc` is authored in metres natively
/// (`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)` — no prefix), so the kernel
/// produces correct world bboxes whether `with_units` is used or not.
/// Pin the M_Fixed window's world bbox against the IfcOpenShell output
/// so the per-extrusion `IfcAxis2Placement3D` chain doesn't quietly
/// drift on a future change.
#[test]
fn duplex_m_fixed_window_world_bbox_matches_ios() {
    let path = "../../tests/models/ara3d/duplex.ifc";
    if !std::path::Path::new(path).exists() {
        eprintln!("skipping: fixture missing at {path}");
        return;
    }
    let content = std::fs::read_to_string(path).expect("read");
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    assert!(
        (router.unit_scale() - 1.0).abs() < 1e-12,
        "duplex.ifc uses METRE natively (no prefix); unit_scale must be 1.0"
    );

    let win = decoder.decode_by_id(6426).expect("decode window");
    assert_eq!(win.ifc_type, IfcType::IfcWindow);
    let mesh = router.process_element(&win, &mut decoder).expect("process");

    let (mn, mx) = bbox(&mesh.positions).expect("non-empty mesh");
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);

    // IOS ground truth: min=(3.548, -0.417, 0.100), extent=(4.835, 0.417, 2.420).
    let tol = 0.001_f32;
    assert!(approx(mn.0, 3.548, tol));
    assert!(approx(mn.1, -0.417, tol));
    assert!(approx(mn.2, 0.100, tol));
    assert!(approx(ext.0, 4.835, tol));
    assert!(approx(ext.1, 0.417, tol));
    assert!(approx(ext.2, 2.420, tol));

    // 108 triangles matches IOS exactly post-aspect-ratio-cap-fix.
    assert_eq!(mesh.indices.len() / 3, 108);
}
