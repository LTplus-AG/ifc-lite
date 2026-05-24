// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression tests for T1.3: `BoolFailure` plumbing through `ClippingProcessor`.
//!
//! Pre-T1.3, the CSG processor silently fell back to `host_mesh.clone()`
//! whenever it couldn't run an operation. These tests exercise the exact
//! fallback paths that issues #582 / #583 / #584 are hitting and assert that
//! a structured `BoolFailure` is now recorded.

use ifc_lite_geometry::{
    BoolFailureReason, BoolOp, ClippingProcessor, Mesh, Point3, Vector3,
};

/// Produce a unit-box mesh (12 triangles, axis-aligned, centred on `origin`).
fn unit_box_at(origin: Point3<f64>) -> Mesh {
    let mut m = Mesh::with_capacity(8, 36);
    let n = Vector3::new(0.0, 0.0, 0.0);
    let v = |dx: f64, dy: f64, dz: f64| {
        Point3::new(origin.x + dx, origin.y + dy, origin.z + dz)
    };
    let p = [
        v(0.0, 0.0, 0.0),
        v(1.0, 0.0, 0.0),
        v(1.0, 1.0, 0.0),
        v(0.0, 1.0, 0.0),
        v(0.0, 0.0, 1.0),
        v(1.0, 0.0, 1.0),
        v(1.0, 1.0, 1.0),
        v(0.0, 1.0, 1.0),
    ];
    for pt in &p {
        m.add_vertex(*pt, n);
    }
    let faces: [[u32; 6]; 6] = [
        [0, 2, 1, 0, 3, 2],
        [4, 5, 6, 4, 6, 7],
        [0, 4, 7, 0, 7, 3],
        [1, 2, 6, 1, 6, 5],
        [0, 1, 5, 0, 5, 4],
        [3, 7, 6, 3, 6, 2],
    ];
    for face in &faces {
        m.add_triangle(face[0], face[1], face[2]);
        m.add_triangle(face[3], face[4], face[5]);
    }
    m
}

/// Build a 36-triangle mesh by merging three unit boxes that all overlap
/// `unit_box_at(origin)` on every axis. Used to bust the
/// `MAX_CSG_POLYGONS_PER_MESH = 24` cap without losing bounds-overlap.
/// 30 axis-offset boxes — distinct positions so the coplanar pre-merge in
/// `ClippingProcessor::mesh_to_polygons` keeps each face as its own
/// polygon (180 polygons total, comfortably above the BSP
/// MAX_CSG_POLYGONS_PER_MESH = 128 cap). The first box sits at the origin
/// so a unit-box cutter at (0,0,0) overlaps it and bounds_overlap passes,
/// letting can_run_csg_operation fire OperandTooLarge.
fn many_boxes_above_cap() -> Mesh {
    let mut m = Mesh::new();
    for i in 0..30 {
        let off = i as f64 * 2.0;
        m.merge(&unit_box_at(Point3::new(off, off, off)));
    }
    m
}

#[test]
fn fresh_processor_has_no_failures() {
    let p = ClippingProcessor::new();
    assert_eq!(p.failure_count(), 0);
    assert!(p.take_failures().is_empty());
}

#[test]
fn subtract_records_no_bounds_overlap() {
    let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let void = unit_box_at(Point3::new(10.0, 10.0, 10.0));
    let p = ClippingProcessor::new();

    let result = p.subtract_mesh(&host, &void).expect("subtract_mesh ok");
    // Behaviour preserved — host returned un-cut.
    assert_eq!(result.triangle_count(), host.triangle_count());

    let failures = p.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].op, BoolOp::Difference);
    assert_eq!(failures[0].reason, BoolFailureReason::NoBoundsOverlap);
}

#[test]
fn subtract_records_empty_operand() {
    let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let void = Mesh::new();
    let p = ClippingProcessor::new();

    let result = p.subtract_mesh(&host, &void).expect("subtract_mesh ok");
    assert_eq!(result.triangle_count(), host.triangle_count());

    let failures = p.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].op, BoolOp::Difference);
    assert_eq!(failures[0].reason, BoolFailureReason::EmptyOperand);
}

#[test]
#[cfg(not(feature = "manifold-csg"))]
fn subtract_records_operand_too_large() {
    // 30 distinct-position boxes (180 face quads after the coplanar merge)
    // trip the BSP MAX_CSG_POLYGONS_PER_MESH = 128 cap. Cap path returns
    // host un-cut and logs OperandTooLarge.
    let host = many_boxes_above_cap();
    let void = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let result = p.subtract_mesh(&host, &void).expect("subtract_mesh ok");
    assert_eq!(result.triangle_count(), host.triangle_count());

    let failures = p.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].op, BoolOp::Difference);
    match &failures[0].reason {
        BoolFailureReason::OperandTooLarge { polys_a, polys_b } => {
            assert!(
                *polys_a > 128,
                "host polys must exceed cap (got {polys_a})"
            );
            assert!(
                *polys_b <= 128,
                "void polys should fit (got {polys_b})"
            );
        }
        other => panic!("expected OperandTooLarge, got {other:?}"),
    }
}

#[test]
#[cfg(feature = "manifold-csg")]
fn subtract_past_legacy_cap_succeeds_under_manifold() {
    // Same operands as the legacy cap test — 180 polygons of host vs a
    // unit-box cutter. With Manifold there is no cap, so the operation
    // must succeed and record no failure.
    let host = many_boxes_above_cap();
    let void = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let result = p.subtract_mesh(&host, &void).expect("subtract_mesh ok");
    assert!(!result.is_empty(), "Manifold must produce non-empty result past legacy cap");
    assert_eq!(p.failure_count(), 0, "Manifold path must not record OperandTooLarge");
}

#[test]
#[cfg(not(feature = "manifold-csg"))]
fn union_records_operand_too_large() {
    let a = many_boxes_above_cap();
    let b = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let _ = p.union_mesh(&a, &b).expect("union_mesh ok");
    let failures = p.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].op, BoolOp::Union);
    assert!(matches!(
        failures[0].reason,
        BoolFailureReason::OperandTooLarge { .. }
    ));
}

#[test]
#[cfg(feature = "manifold-csg")]
fn union_past_legacy_cap_succeeds_under_manifold() {
    let a = many_boxes_above_cap();
    let b = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let result = p.union_mesh(&a, &b).expect("union_mesh ok");
    assert!(!result.is_empty());
    assert_eq!(p.failure_count(), 0, "Manifold union must not record cap failure");
}

#[test]
#[cfg(not(feature = "manifold-csg"))]
fn intersection_records_operand_too_large() {
    let a = many_boxes_above_cap();
    let b = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let _ = p.intersection_mesh(&a, &b).expect("intersection_mesh ok");
    let failures = p.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].op, BoolOp::Intersection);
    assert!(matches!(
        failures[0].reason,
        BoolFailureReason::OperandTooLarge { .. }
    ));
}

#[test]
#[cfg(feature = "manifold-csg")]
fn intersection_past_legacy_cap_succeeds_under_manifold() {
    let a = many_boxes_above_cap();
    let b = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let result = p
        .intersection_mesh(&a, &b)
        .expect("intersection_mesh ok");
    assert!(
        !result.is_empty(),
        "intersection of overlapping boxes must be non-empty"
    );
    assert_eq!(p.failure_count(), 0, "Manifold intersection must not record cap failure");
}

#[test]
fn take_failures_drains_log() {
    let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let void = unit_box_at(Point3::new(10.0, 10.0, 10.0));
    let p = ClippingProcessor::new();

    let _ = p.subtract_mesh(&host, &void);
    let _ = p.subtract_mesh(&host, &Mesh::new());
    assert_eq!(p.failure_count(), 2);

    let drained = p.take_failures();
    assert_eq!(drained.len(), 2);
    assert_eq!(p.failure_count(), 0, "drain must clear the log");
}

#[test]
fn happy_path_records_no_failures() {
    // Small overlapping operands inside the cap — should succeed without
    // recording any failure.
    let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let void = unit_box_at(Point3::new(0.25, 0.25, 0.25));
    let p = ClippingProcessor::new();

    let _ = p.subtract_mesh(&host, &void).expect("subtract_mesh ok");
    assert_eq!(
        p.failure_count(),
        0,
        "small in-cap operands must not record failures"
    );
}
