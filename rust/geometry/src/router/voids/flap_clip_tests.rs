// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void-flap clipping + malformed-cutter recovery tests, plus the world-space
//! host-bbox diagnostic regression guards (PR #1564 review). Split out of
//! `voids/mod.rs` to keep that module under its size-ratchet budget, mirroring
//! the sibling `reveal_tests` module.

use super::*;

fn box_cutter_mesh(half: [f64; 3], garbage: &[[f64; 3]]) -> Mesh {
    // 8 corners of an axis-aligned box centred at origin + far garbage verts.
    let mut m = Mesh::new();
    for sx in [-1.0, 1.0] {
        for sy in [-1.0, 1.0] {
            for sz in [-1.0, 1.0] {
                m.positions.extend_from_slice(&[
                    (sx * half[0]) as f32,
                    (sy * half[1]) as f32,
                    (sz * half[2]) as f32,
                ]);
            }
        }
    }
    for g in garbage {
        m.positions
            .extend_from_slice(&[g[0] as f32, g[1] as f32, g[2] as f32]);
    }
    m
}

/// A cutter with far garbage "fins" is detected as malformed and its real
/// opening box is recovered (the fins are excluded).
#[test]
fn opening_obb_detects_malformed_and_recovers_box() {
    let cutter = box_cutter_mesh([1.0, 0.1, 1.2], &[[0.0, 9.0, 0.0], [0.0, -9.0, 0.0]]);
    let b = opening_obb_if_malformed(&cutter).expect("malformed cutter -> box");
    let mut half = b.half;
    half.sort_by(|a, c| a.partial_cmp(c).unwrap());
    assert!((half[0] - 0.1).abs() < 0.05, "thin half {:?}", b.half);
    assert!((half[1] - 1.0).abs() < 0.05, "mid half {:?}", b.half);
    assert!((half[2] - 1.2).abs() < 0.05, "long half {:?}", b.half);
}

/// A well-formed cutter (no far cluster) is NOT reshaped.
#[test]
fn opening_obb_skips_wellformed_cutter() {
    let cutter = box_cutter_mesh([1.0, 0.1, 1.2], &[]);
    assert!(opening_obb_if_malformed(&cutter).is_none());
}

/// A watertight TALL cutter — a roof/gable void authored as a closed prism
/// reaching far up (here ~900 m) to clip a wall down to the roofline — is a
/// VALID SOLID, so its far (top) vertices are STRUCTURAL, not garbage. The
/// closed-manifold gate must spare it: flagging it malformed re-cut every
/// roof-capped wall as a flat horizontal slab, slicing the gable off (the
/// #1440 false-positive). `aabb_box` welds to a closed box, mirroring the
/// `IfcClosedShell` roof cutters that triggered the regression.
#[test]
fn watertight_tall_roof_cutter_is_not_flagged_malformed() {
    let tall = aabb_box([0.6, 0.15, 450.0]);
    assert!(
        cutter_is_closed_manifold(&tall),
        "a closed box prism must read as a valid solid"
    );
    assert!(
        opening_obb_if_malformed(&tall).is_none(),
        "a watertight tall cutter must never be reshaped as 'malformed'"
    );
}

fn signed_volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum::<f64>()
        .abs()
}

/// An axis-aligned box mesh (helper) via the canonical corner order.
fn aabb_box(half: [f64; 3]) -> Mesh {
    let axes = [Vector3::x(), Vector3::y(), Vector3::z()];
    let bx = OpeningBox { center: Vector3::zeros(), axes, half };
    bx.extended_box_mesh([0.0; 3], 0.0)
}

/// `recut_malformed_openings` carves a clean through-opening AND preserves
/// the wall AROUND it — the regression where a plain triangle-drop also
/// removed the legitimate wall above/below the opening.
#[test]
fn recut_carves_opening_and_preserves_wall_around_it() {
    // Solid wall box: 4 (x) x 0.3 (y) x 3 (z) centred at origin.
    let mut host = aabb_box([2.0, 0.15, 1.5]);
    let host_vol = signed_volume(&host);
    // A 1 x 1 window through it (thin axis y; recut extends it through).
    let bx = OpeningBox {
        center: Vector3::zeros(),
        axes: [Vector3::x(), Vector3::y(), Vector3::z()],
        half: [0.5, 0.079, 0.5],
    };
    recut_malformed_openings(&mut host, std::slice::from_ref(&bx));
    assert!(!host.is_empty(), "recut emptied the wall");
    // Wall extent preserved on every face axis (no over-cut of the wall
    // above/below/beside the opening).
    let (lo, hi) = host.bounds();
    assert!((hi.z - 1.5).abs() < 0.02, "wall top removed (z max {})", hi.z);
    assert!((lo.z + 1.5).abs() < 0.02, "wall bottom removed (z min {})", lo.z);
    assert!((hi.x - 2.0).abs() < 0.02, "wall side removed (x max {})", hi.x);
    // The opening prism (~1 x 0.3 x 1 = 0.3 m^3) was actually carved out.
    let cut_vol = signed_volume(&host);
    assert!(
        cut_vol < host_vol - 0.2,
        "opening not carved (host {host_vol:.3}, cut {cut_vol:.3})"
    );
}

/// `world_host_bounds` folds `mesh.origin` back into the local AABB so the
/// per-host `bbox` diagnostic is WORLD-space (#1474 local-frame-consumer
/// bug class), not the near-zero local frame the wasm path stores.
#[test]
fn world_host_bounds_folds_the_origin_back_in() {
    let mut host = aabb_box([2.0, 0.15, 1.5]);
    // Local bounds are centred on zero; a nonzero origin is the wasm default.
    host.origin = [1000.0, 2000.0, 3000.0];
    let ((mnx, mny, mnz), (mxx, mxy, mxz)) = world_host_bounds(&host);
    // world = origin + local extent, not the ±2 / ±0.15 / ±1.5 local box.
    assert!((mnx - 998.0).abs() < 0.01, "min.x {mnx}");
    assert!((mxx - 1002.0).abs() < 0.01, "max.x {mxx}");
    assert!((mny - 1999.85).abs() < 0.01, "min.y {mny}");
    assert!((mxy - 2000.15).abs() < 0.01, "max.y {mxy}");
    assert!((mnz - 2998.5).abs() < 0.01, "min.z {mnz}");
    assert!((mxz - 3001.5).abs() < 0.01, "max.z {mxz}");
}

/// End-to-end: a host stored in a per-element local frame (nonzero
/// `mesh.origin`, the wasm default) reports a WORLD-space `bbox` in the
/// drained per-host diagnostic — NOT the near-zero local box. Regression
/// guard for the origin being cleared in `apply_void_context` before the
/// bounds were captured (PR #1564 review).
#[test]
fn nonzero_origin_host_records_world_space_bbox() {
    let router = GeometryRouter::new();
    let mut host = aabb_box([2.0, 0.15, 1.5]);
    host.origin = [1000.0, 2000.0, 3000.0];

    // A clean axis-aligned through-cut, expressed in WORLD coords (as real
    // Rectangular openings are); `apply_void_context` relativises it by the
    // host origin so it lands on the local box.
    let o = host.origin;
    let opening = OpeningType::Rectangular(
        Point3::new(o[0] - 0.5, o[1] - 0.5, o[2] - 0.5),
        Point3::new(o[0] + 0.5, o[1] + 0.5, o[2] + 0.5),
        None,
    );
    let ctx = VoidContext {
        merged_openings: vec![opening.clone()],
        openings: vec![opening],
        param: None,
    };

    let element_id = 4242u32;
    let _ = router.apply_void_context(host, &ctx, element_id);

    let diags = router.take_host_opening_diagnostics();
    let hd = diags.get(&element_id).expect("host cut effect recorded");
    let ((mnx, mny, mnz), (mxx, mxy, mxz)) =
        hd.host_bounds.expect("host_bounds captured on the cut path");
    // World coords (~1000/2000/3000), not the local ±2 box centred on zero.
    assert!(mnx > 900.0 && mxx < 1100.0, "x not world: [{mnx}, {mxx}]");
    assert!(mny > 1900.0 && mxy < 2100.0, "y not world: [{mny}, {mxy}]");
    assert!(mnz > 2900.0 && mxz < 3100.0, "z not world: [{mnz}, {mxz}]");
}
