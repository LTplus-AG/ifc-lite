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

/// 30 axis-offset unit boxes — 180 face quads, comfortably above the legacy
/// BSP `MAX_CSG_POLYGONS_PER_MESH = 128` cap that the pre-flip kernel used
/// to reject with `OperandTooLarge`. The first box sits at the origin so a
/// unit-box operand at (0,0,0) overlaps it and `bounds_overlap` passes.
/// Kept as the regression fixture proving the no-cap exact kernel handles
/// operands the deleted BSP port refused (see the re-baseline note below).
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

// Kernel consolidation: the `*_records_operand_too_large`
// tests below used to assert the legacy BSP `MAX_CSG_POLYGONS_PER_MESH = 128`
// cap. The pure-Rust exact kernel (`kernel::mesh_bridge`) — now the ONLY
// kernel — has NO operand cap, so `OperandTooLarge` is unreachable from
// `subtract_mesh` / `union_mesh` / `intersection_mesh`. The tests pin that:
// the kernel must succeed past the legacy cap with zero failures.
// `BoolFailureReason::OperandTooLarge` survives only as void-router plumbing.

/// A host of overlapping boxes whose seams sit a few µm OFF the snap grid, so
/// adjacent faces are NEAR- (not exactly-) coplanar — the configuration that
/// drives the exact predicate cascade off the cheap interval filter (#1109).
/// Exactly-coplanar faces would resolve at the interval tier for free; the
/// off-grid drift is what forces escalation.
fn near_coplanar_overlapping_boxes() -> Mesh {
    let mut m = Mesh::new();
    for i in 0..24 {
        // 0.5 m step (boxes overlap) + cumulative off-grid drift.
        let off = i as f64 * 0.5 + i as f64 * 1.0e-5;
        m.merge(&unit_box_at(Point3::new(off, off * 0.5, 0.0)));
    }
    m
}

#[test]
fn subtract_trips_escalation_budget_and_falls_back_deterministically() {
    use ifc_lite_geometry::kernel::budget;
    let host = near_coplanar_overlapping_boxes();
    let cutter = unit_box_at(Point3::new(2.0, 1.0, 0.0));

    let restore = budget::cap();

    // Unbounded first: confirm this fixture actually exercises the exact tier,
    // or the trip assertion below would be vacuous.
    budget::set_cap(None);
    let p0 = ClippingProcessor::new();
    let _ = p0.subtract_mesh(&host, &cutter).expect("subtract ok");
    let escalations = budget::count();

    // Cap of 1 → trips on the first exact evaluation → host returned un-cut and
    // OperandTooLarge recorded. Deterministic: the same fixture trips at the same
    // point on every target (the #1109 parity-preserving guardrail).
    budget::set_cap(Some(1));
    let p1 = ClippingProcessor::new();
    let result = p1.subtract_mesh(&host, &cutter).expect("subtract ok");
    let failures = p1.take_failures();

    budget::set_cap(restore);

    assert!(escalations > 0, "fixture did not reach the exact tier — trip test is vacuous");
    assert_eq!(
        result.triangle_count(),
        host.triangle_count(),
        "a tripped boolean must return the host un-cut (→ #635 AABB fallback)"
    );
    assert!(
        failures.iter().any(|f| matches!(f.reason, BoolFailureReason::OperandTooLarge { .. })),
        "a tripped boolean must record OperandTooLarge (got {failures:?})"
    );
}

#[test]
fn subtract_past_legacy_cap_succeeds() {
    // 180 polygons of host vs a unit-box cutter — past the legacy BSP cap.
    // The pure-Rust exact kernel has no cap, so the operation must
    // succeed and record no failure.
    let host = many_boxes_above_cap();
    let void = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let result = p.subtract_mesh(&host, &void).expect("subtract_mesh ok");
    assert!(
        !result.is_empty(),
        "kernel must produce non-empty result past legacy cap"
    );
    assert!(
        result.triangle_count() < host.triangle_count(),
        "cutter coincides with the first box — it must actually be removed \
         (host {} tris, result {} tris)",
        host.triangle_count(),
        result.triangle_count()
    );
    assert_eq!(
        p.failure_count(),
        0,
        "no-cap kernel must not record OperandTooLarge"
    );
}

#[test]
fn union_past_legacy_cap_succeeds() {
    let a = many_boxes_above_cap();
    let b = unit_box_at(Point3::new(0.0, 0.0, 0.0));
    let p = ClippingProcessor::new();

    let result = p.union_mesh(&a, &b).expect("union_mesh ok");
    assert!(!result.is_empty());
    assert_eq!(
        p.failure_count(),
        0,
        "no-cap kernel union must not record cap failure"
    );
}

#[test]
fn intersection_past_legacy_cap_succeeds() {
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
    assert_eq!(
        p.failure_count(),
        0,
        "no-cap kernel intersection must not record cap failure"
    );
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
