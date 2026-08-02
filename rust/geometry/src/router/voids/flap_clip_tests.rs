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
        bool2d: None,
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

/// An axis-aligned box mesh centred at `cx` on X (0 on Y/Z) with the given half
/// extents, via the same `OpeningBox` corner order the router uses.
fn box_mesh_at(cx: f64, half: [f64; 3]) -> Mesh {
    OpeningBox {
        center: Vector3::new(cx, 0.0, 0.0),
        axes: [Vector3::x(), Vector3::y(), Vector3::z()],
        half,
    }
    .extended_box_mesh([0.0; 3], 0.0)
}

/// #1109 → #635 engulf-suppression correctness (the decided SKIP fix). When the
/// per-boolean escalation budget (#1109) trips while cutting a void whose AABB
/// ENGULFS the host, the router must NOT fall through to the destructive #635
/// AABB box-cut: that box covers the whole host, so it would DELETE the wall
/// (silent element loss). It leaves the host UN-CUT instead — a phantom solid is
/// strictly safer. The companion cut pins the OTHER quadrant: a NON-engulfing
/// opening under the SAME tripped cap MUST still take the #635 box-cut, proving
/// the dropped `!capped` term only affects the engulfing case.
#[test]
fn budget_tripped_engulfing_cutter_skips_aabb_fallback() {
    use crate::kernel::budget;

    // We trip via the per-ELEMENT budget, NOT the per-boolean cap. The
    // per-boolean cap is process-global and read by EVERY boolean on EVERY
    // thread, so lowering it here would false-trip the CSG that concurrent
    // (unlocked) sibling tests are running. The per-element cap only bites a
    // thread that has opened an element scope via `begin_element` — and within
    // this lib test binary only THIS test and budget.rs's own `per_element`
    // test (both hold the lock below, and neither runs a sibling's CSG) ever do
    // — so a per-element cap of 1 is invisible to every other test.
    //
    // Serialise against the other cap-mutating tests (they share this lock).
    let _cap_guard = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    // Restore BOTH global caps AND reset THIS worker thread's thread-local
    // element scope to unbounded on the way out (even on panic): thread-locals
    // persist across tests on a reused worker thread, so a left-armed element
    // cap would false-trip whatever CSG test cargo schedules next on it.
    struct RestoreBudget {
        cap: Option<u64>,
        ecap: Option<u64>,
    }
    impl Drop for RestoreBudget {
        fn drop(&mut self) {
            // Re-open an UNBOUNDED element scope on this thread (elem cap 0 ⇒
            // thread-local ELEM_CAP = u64::MAX, ELEM_COUNT = 0), matching a
            // thread that never opened a scope, THEN restore the globals.
            budget::set_element_cap(None);
            budget::begin_element();
            budget::set_cap(self.cap);
            budget::set_element_cap(self.ecap);
        }
    }
    let _restore = RestoreBudget {
        cap: budget::cap(),
        ecap: budget::element_cap(),
    };

    let router = GeometryRouter::new();

    // Box host wall: 2 m (x) × 0.3 m thick (y) × 2 m tall (z), centred at
    // origin. Every face stays well under the 8:1 sliver-refine threshold, so
    // the un-cut host passes through the post-loop refine/clip unchanged and its
    // triangle count is a stable "host present, un-cut" baseline.
    let host = aabb_box([1.0, 0.15, 1.0]);
    let host_tris = host.triangle_count();

    // ENGULFING cutter: two disjoint boxes flanking the host in X with a gap
    // straddling the host centre, merged into ONE cutter mesh. Their COMBINED
    // AABB covers the host on all three axes (engulf), yet the real solid
    // EXCLUDES the host centre (the X-gap) — so `opening_engulfs_host_solid` is
    // false (the host is NOT consumed as a containing void) and the cut reaches
    // the exact subtract. Each box's Y/Z faces sit a hair (~0.1 mm, off-grid)
    // beyond the host faces: near-coplanar overlaps that force the exact
    // predicate cascade off the interval filter, so an element cap of 1 trips.
    let dy = 1.3e-4;
    let dz = 1.7e-4;
    let cutter = {
        let mut m = box_mesh_at(-0.8, [0.5, 0.15 + dy, 1.0 + dz]); // x ∈ [-1.3, -0.3]
        m.merge(&box_mesh_at(0.8, [0.5, 0.15 + dy, 1.0 + dz])); //     x ∈ [ 0.3,  1.3]
        m
    };
    // The cutter welds to a closed manifold (two closed boxes), so the
    // malformed-cutter recut path never claims it and bypasses the target code.
    assert!(
        opening_obb_if_malformed(&cutter).is_none(),
        "engulfing cutter must be well-formed"
    );

    let (cmn, cmx) = cutter.bounds();
    let engulf_open = OpeningType::NonRectangular(
        cutter,
        Point3::new(cmn.x as f64, cmn.y as f64, cmn.z as f64),
        Point3::new(cmx.x as f64, cmx.y as f64, cmx.z as f64),
        None,
    );
    let engulf_ctx = VoidContext {
        merged_openings: vec![engulf_open.clone()],
        openings: vec![engulf_open],
        param: None,
        bool2d: None,
    };

    // Arm a per-element cap of 1 so the FIRST exact escalation trips the
    // element budget deterministically (the per-boolean cap stays at its
    // default, untouched, so concurrent tests are unaffected).
    budget::set_element_cap(Some(1));

    let engulf_id = 91_109_u32;
    budget::begin_element(); // fresh element scope; element cap 1 is the trip
    let engulf_result = router.apply_void_context(host.clone(), &engulf_ctx, engulf_id);

    // Host PRESENT and UN-CUT: the engulfing AABB box-cut was suppressed, so the
    // result is the original host, not an empty (deleted) mesh.
    assert!(
        !engulf_result.is_empty(),
        "engulfing cutter DELETED the host (box-cut fallback not suppressed)"
    );
    assert_eq!(
        engulf_result.triangle_count(),
        host_tris,
        "host must be left exactly un-cut (got {} tris, host {host_tris})",
        engulf_result.triangle_count(),
    );

    // Exactly ONE failure recorded for this element — the single tripped
    // boolean — with reason OperandTooLarge (the #1109 budget-trip signature).
    let failures = router.take_csg_failures();
    let engulf_fails = failures
        .get(&engulf_id)
        .expect("the tripped engulfing cut must record a failure");
    assert_eq!(
        engulf_fails.len(),
        1,
        "exactly one failure for the single tripped cut (got {engulf_fails:?})"
    );
    assert!(
        matches!(
            engulf_fails[0].reason,
            crate::diagnostics::BoolFailureReason::OperandTooLarge { .. }
        ),
        "the tripped cut must record OperandTooLarge (got {:?})",
        engulf_fails[0].reason,
    );

    // COMPANION (other quadrant): a small NON-engulfing opening centred in the
    // wall, under the SAME tripped cap, MUST still change the host — the #635
    // box-cut fires because `engulfs_host` is false, so dropping the `!capped`
    // term left this case untouched.
    let small = box_mesh_at(0.0, [0.15, 0.2, 0.15]); // 0.3 × 0.4 × 0.3, through the wall
    let small_open = OpeningType::NonRectangular(
        small,
        Point3::new(-0.15, -0.2, -0.15),
        Point3::new(0.15, 0.2, 0.15),
        None,
    );
    let small_ctx = VoidContext {
        merged_openings: vec![small_open.clone()],
        openings: vec![small_open],
        param: None,
        bool2d: None,
    };

    let small_id = 91_635_u32;
    budget::begin_element();
    let small_result = router.apply_void_context(host.clone(), &small_ctx, small_id);
    assert!(
        !small_result.is_empty(),
        "a non-engulfing cut must keep the wall"
    );
    assert_ne!(
        small_result.triangle_count(),
        host_tris,
        "a non-engulfing opening under the tripped cap must still cut the host (#635 box-cut)"
    );
}

// A non-finite vertex (e.g. from a degenerate upstream transform) reaching the
// malformed-opening OBB heuristic must not panic the partial_cmp sorts; the
// cutter is not worth reshaping, so it bails to None.
#[test]
fn opening_obb_if_malformed_bails_on_nan_vertex_not_panic() {
    let cutter = box_cutter_mesh([1.0, 1.0, 1.0], &[[f64::NAN, 0.0, 0.0]]);
    assert!(opening_obb_if_malformed(&cutter).is_none());
}
