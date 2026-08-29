// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Endpoint snapping for the cross-bucket seam conform: closes the residual
//! gap `conform_plans`' own "already carries" filter leaves behind when two
//! buckets' own union/weld/simplify land the same physical corner a few µm
//! apart instead of bit-identical (the T-junction #3353's census
//! regressions traced to). Snapping the region's own vertex onto the
//! candidate's exact position — rather than inserting a second,
//! near-duplicate vertex, which [`super::super::tri_is_needle`]'s needle
//! backstop would just drop again — closes the gap without changing the
//! vertex count.
//!
//! # Why a snap must also clear an f32-visibility floor
//!
//! `region.changed` decides whether [`super::emit_plans`] reuses pass 1's
//! cached CDT or re-runs triangulation from scratch — not guaranteed
//! bit-for-bit even on an unchanged ring, and the cause of a +61%
//! ISSUE_129 regression when it fired needlessly. A measured host found
//! EVERY candidate snap under ~2e-9 units was double-precision noise, not
//! a real seam gap, yet still forced a re-triangulation, while genuine
//! corrections started at ~3e-7 — a ~140x gap with nothing between.
//! Skipping an f32-invisible snap closes that noise band for free while a
//! µm-scale correction still fires; `tri_is_needle`/`CONFORM_TOL` are
//! untouched.
//!
//! The check compares in the frame `Mesh::add_vertex` actually quantizes —
//! `origin + u_axis * p.x + v_axis * p.y`, not the local 2D delta — since
//! f32 ULP scales with magnitude and a georeferenced `origin` (~1e6-scale)
//! can make the two frames disagree on visibility.

use super::CONFORM_TOL;
use nalgebra::{Point2, Point3, Vector3};

/// Snap every vertex of `ring` within `CONFORM_TOL` of some `cands` entry —
/// but not already bit-identical to it, and f32-visible once quantized —
/// onto that candidate's exact position. Returns whether anything moved.
/// `origin`/`u_axis`/`v_axis` are the plane's basis `emit_region` uses to
/// lift a 2D point to 3D, reused here for the f32-visibility check.
///
/// A snap onto any OTHER ring vertex within `CONFORM_TOL` is refused, not
/// only an adjacent or bit-identical one — `conform_regions` drops the
/// whole region on any such collapse. That guard, and the candidate each
/// vertex picks, are evaluated only against snapshots taken before any
/// vertex moves, never a live, partially-mutated `ring`, so the result
/// cannot depend on ring-walk order. When two vertices are both within
/// `CONFORM_TOL` of the same candidate, there is no arbitrary choice to
/// make deterministic: BOTH are refused. This falls straight out of the
/// same guard — each contender's own original position is, by
/// construction, within `CONFORM_TOL` of the shared candidate, so it
/// trips the other contender's collapse check too — and it makes
/// order-independence trivial, since refusing both is symmetric.
pub(super) fn snap_near_duplicates(
    ring: &mut [Point2<f64>],
    cands: &[Point2<f64>],
    origin: Point3<f64>,
    u_axis: Vector3<f64>,
    v_axis: Vector3<f64>,
) -> bool {
    let n = ring.len();
    if n < 3 || cands.is_empty() {
        return false;
    }
    let lift = |p: Point2<f64>| -> Point3<f64> { origin + u_axis * p.x + v_axis * p.y };

    // Snapshot: every guard below reads ORIGINAL positions, never an
    // already-applied move, so the result cannot depend on ring-walk order.
    let orig: Vec<Point2<f64>> = ring.to_vec();

    // Phase 1: each vertex's nearest in-tolerance, f32-visible candidate,
    // independent of every other vertex's decision.
    let mut chosen: Vec<Option<Point2<f64>>> = vec![None; n];
    for (i, &v) in orig.iter().enumerate() {
        let mut best: Option<(f64, Point2<f64>)> = None;
        for &q in cands {
            let dx = q.x - v.x;
            let dy = q.y - v.y;
            if dx == 0.0 && dy == 0.0 {
                continue; // already bit-identical — nothing to snap
            }
            if dx.abs() > CONFORM_TOL || dy.abs() > CONFORM_TOL {
                continue;
            }
            let d2 = dx * dx + dy * dy;
            let closer = match best {
                Some((bd, _)) => d2 < bd,
                None => true,
            };
            if closer {
                best = Some((d2, q));
            }
        }
        let Some((_, q)) = best else { continue };
        // Below the mesh's f32 output precision (see module doc), compared
        // in the SAME frame `Mesh::add_vertex` quantizes.
        let v_abs = lift(v);
        let q_abs = lift(q);
        if v_abs.x as f32 == q_abs.x as f32
            && v_abs.y as f32 == q_abs.y as f32
            && v_abs.z as f32 == q_abs.z as f32
        {
            continue;
        }
        chosen[i] = Some(q);
    }

    // Phase 2: reject a candidate that duplicates another vertex's ORIGINAL
    // position (within `CONFORM_TOL`) — reads only the immutable `orig`
    // snapshot, never a live, partially-mutated `ring`. This alone also
    // refuses a candidate two vertices both want: each contender's own
    // original position is within `CONFORM_TOL` of it by construction (that
    // is why it was chosen), so it trips this same check for the other.
    let near = |p: Point2<f64>, q: Point2<f64>| {
        (p.x - q.x).abs() <= CONFORM_TOL && (p.y - q.y).abs() <= CONFORM_TOL
    };
    let mut snapped = false;
    for i in 0..n {
        let Some(q) = chosen[i] else { continue };
        if (0..n).any(|j| j != i && near(orig[j], q)) {
            continue; // would create a degenerate or near-duplicate ring edge
        }
        ring[i] = q;
        snapped = true;
    }
    snapped
}

#[cfg(test)]
mod tests {
    use super::*;

    // Identity basis: `lift` reduces to `Point3::new(p.x, p.y, 0.0)`.
    #[allow(non_snake_case)]
    fn ORIGIN() -> Point3<f64> {
        Point3::new(0.0, 0.0, 0.0)
    }
    #[allow(non_snake_case)]
    fn U_AXIS() -> Vector3<f64> {
        Vector3::new(1.0, 0.0, 0.0)
    }
    #[allow(non_snake_case)]
    fn V_AXIS() -> Vector3<f64> {
        Vector3::new(0.0, 1.0, 0.0)
    }

    /// Identity-basis wrapper for every test but the georeferenced one.
    fn snap(ring: &mut [Point2<f64>], cands: &[Point2<f64>]) -> bool {
        snap_near_duplicates(ring, cands, ORIGIN(), U_AXIS(), V_AXIS())
    }

    #[test]
    fn snaps_a_near_duplicate_onto_the_candidate() {
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.000_02), // 20 µm off the seam's canonical y=0
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        assert!(snap(&mut ring, &[Point2::new(2.0, 0.0)]));
        assert_eq!(ring[1], Point2::new(2.0, 0.0));
        assert_eq!(ring[0], Point2::new(0.0, 0.0), "untouched");
        assert_eq!(ring[2], Point2::new(2.0, 2.0), "untouched");
    }

    #[test]
    fn bit_identical_and_out_of_tolerance_candidates_are_no_ops() {
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let before = ring.clone();
        assert!(!snap(&mut ring, &[Point2::new(2.0, 0.0)]), "already exact");
        assert!(
            !snap(&mut ring, &[Point2::new(1.0, 1.0)]),
            "not near any vertex"
        );
        assert!(
            !snap(&mut ring, &[Point2::new(2.001, 0.0)]),
            "beyond CONFORM_TOL"
        );
        assert_eq!(ring, before);
    }

    #[test]
    fn refuses_a_snap_that_would_collapse_onto_a_neighbour() {
        // Candidate for vertex 1 equals vertex 0's position exactly.
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(0.000_02, 0.0), // 20 µm from vertex 0
            Point2::new(2.0, 2.0),
        ];
        assert!(!snap(&mut ring, &[Point2::new(0.0, 0.0)]));
        assert_eq!(
            ring[1],
            Point2::new(0.000_02, 0.0),
            "must not collapse onto neighbour"
        );
    }

    #[test]
    fn refuses_a_snap_invisible_at_f32_mesh_precision() {
        // v/q differ only in low double-precision bits: bit-identical as f32.
        let v_x = 0.329_999_958f64;
        let q_x = v_x + 1.0e-12; // real double-precision gap, invisible in f32
        assert_eq!(v_x as f32, q_x as f32, "must be f32-indistinguishable");
        let mut ring = vec![
            Point2::new(v_x, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        assert!(!snap(&mut ring, &[Point2::new(q_x, 0.0)]));
        assert_eq!(
            ring[0],
            Point2::new(v_x, 0.0),
            "f32-invisible move must be refused"
        );
    }

    #[test]
    fn applies_a_snap_visible_at_f32_mesh_precision() {
        // A µm-scale correction (1e-6) changes the f32 representation.
        let v_x = 0.329_999_958f64;
        let q_x = v_x + 1.0e-6;
        assert_ne!(
            v_x as f32, q_x as f32,
            "fixture must be f32-distinguishable"
        );
        let mut ring = vec![
            Point2::new(v_x, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        assert!(snap(&mut ring, &[Point2::new(q_x, 0.0)]));
        assert_eq!(ring[0], Point2::new(q_x, 0.0));
    }

    /// `q_local`'s LOCAL delta is well inside `CONFORM_TOL`, but its
    /// ABSOLUTE reconstruction collides at f32 at a realistic
    /// georeferenced-host magnitude (~2.6e6 easting); only the
    /// frame-correct comparison refuses it.
    #[test]
    fn refuses_a_snap_invisible_at_f32_precision_only_once_lifted_to_the_georeferenced_frame() {
        let origin = Point3::new(2_600_000.0, 0.0, 0.0);
        let v_local = Point2::new(0.0, 0.0);
        let q_local = Point2::new(9.9e-5, 0.0); // within CONFORM_TOL (1e-4)

        // LOCAL f32 distinguishable, ABSOLUTE reconstruction collides.
        assert_ne!(q_local.x as f32, v_local.x as f32);
        assert_eq!((origin.x + v_local.x) as f32, (origin.x + q_local.x) as f32);

        let mut ring = vec![
            v_local,
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        assert!(!snap_near_duplicates(
            &mut ring,
            &[q_local],
            origin,
            U_AXIS(),
            V_AXIS()
        ));
        assert_eq!(ring[0], v_local, "f32-invisible move must be refused");
    }

    /// A pentagon (n = 5, not every vertex mutually adjacent): ring[3] sits
    /// within `CONFORM_TOL` of ring[0], a non-neighbour, without being
    /// bit-identical. Run once with the candidate exactly on ring[0] and
    /// once 9e-5 off it (inside tolerance, not equal).
    #[test]
    fn refuses_a_snap_that_would_collapse_onto_a_non_adjacent_vertex() {
        let ring0 = Point2::new(0.0, 0.0);
        let ring1 = Point2::new(10.0, 0.0);
        let ring2 = Point2::new(10.0, 10.0);
        let ring3 = Point2::new(0.000_05, 0.000_03);
        let ring4 = Point2::new(0.0, 10.0);
        let pentagon = || vec![ring0, ring1, ring2, ring3, ring4];

        for cands in [[ring0], [Point2::new(9.0e-5, 0.0)]] {
            let mut ring = pentagon();
            let moved = snap_near_duplicates(&mut ring, &cands, ORIGIN(), U_AXIS(), V_AXIS());
            assert!(!moved, "must not snap ring[3] near ring[0]: {cands:?}");
            assert_eq!(ring[3], ring3, "non-adjacent vertex must not move");
            assert_ne!(ring[3], ring[0], "ring must not end up bit-identical");
        }
    }

    /// Two non-adjacent vertices sit within `CONFORM_TOL` of the same
    /// candidate, exactly tied on distance; neither may take it.
    #[test]
    fn refuses_both_snaps_when_two_vertices_want_the_same_candidate() {
        let mut ring = vec![
            Point2::new(9.0e-5, 0.0), // within CONFORM_TOL of q
            Point2::new(5.0, 5.0),
            Point2::new(-9.0e-5, 0.0), // also within CONFORM_TOL of q
            Point2::new(5.0, -5.0),
        ];
        let before = ring.clone();
        assert!(
            !snap(&mut ring, &[Point2::new(0.0, 0.0)]),
            "neither vertex may take a candidate the other still sits near"
        );
        assert_eq!(ring, before);
    }

    /// A live-array check would read one vertex's NEW (already-snapped)
    /// position instead of its ORIGINAL one once that vertex's own turn in
    /// the loop had passed — so whether ring[3]'s candidate collides with
    /// ring[0]'s ORIGINAL position would depend on whether ring[0] was
    /// visited (and moved) before ring[3] or after, which flips between the
    /// two storage orders below. ring[0] has its own, uncontested candidate
    /// and always snaps; ring[3]'s candidate sits within `CONFORM_TOL` of
    /// ring[0]'s ORIGINAL position and must be refused in BOTH orders —
    /// this pins the fixed, order-independent refusal, not a winner.
    #[test]
    fn result_is_independent_of_ring_traversal_order() {
        let v0 = Point2::new(0.0, 0.0);
        let v1 = Point2::new(5.0, 5.0); // filler, never in tolerance of anything
        let v2 = Point2::new(10.0, 10.0); // filler, never in tolerance of anything
        let v3 = Point2::new(0.000_095, 0.000_06);
        let c0 = Point2::new(-0.000_02, -0.000_02); // ring[0]'s own, uncontested candidate
        let c3 = Point2::new(0.000_09, 0.0); // within CONFORM_TOL of ring[0]'s ORIGINAL (0,0)
        let cands = [c0, c3];

        let mut forward = vec![v0, v1, v2, v3];
        snap(&mut forward, &cands);

        // Same physical ring (identical edge set), storage order reversed.
        let mut reversed = vec![v3, v2, v1, v0];
        snap(&mut reversed, &cands);

        // index k in `forward` <-> index (n-1-k) in `reversed`.
        let n = forward.len();
        let remapped: Vec<Point2<f64>> = (0..n).map(|k| reversed[n - 1 - k]).collect();

        assert_eq!(
            forward, remapped,
            "snap_near_duplicates must not depend on which index the ring \
             traversal starts from — both describe the same ring"
        );
        assert_eq!(
            forward,
            vec![c0, v1, v2, v3],
            "ring[0] snaps to its own candidate; ring[3]'s candidate is \
             refused in both orders, not won"
        );
    }

    /// A, B adjacent, 3e-5 apart; candidate M sits exactly between them,
    /// exactly tied on distance — no unambiguous winner, so both refused.
    #[test]
    fn refuses_both_when_adjacent_vertices_pick_the_same_candidate() {
        let a = Point2::new(0.0, 0.0);
        let b = Point2::new(3.0e-5, 0.0);
        let c = Point2::new(2.0, 2.0);
        let d = Point2::new(0.0, 2.0);
        let m = Point2::new(1.5e-5, 0.0); // equidistant from a and b

        let mut ring = vec![a, b, c, d];
        assert!(
            !snap(&mut ring, &[m]),
            "both candidates tie on distance and must be refused"
        );
        assert_eq!(ring, vec![a, b, c, d], "neither A nor B may move");
    }

    /// ring[0]/ring[2] are OPPOSITE (non-adjacent) corners, both within
    /// CONFORM_TOL of `q`; an adjacent-only guard would miss this. Neither
    /// is a bit-identical duplicate of the other, so this is the
    /// non-adjacent counterpart of #3400's own
    /// `refuses_both_snaps_when_two_vertices_want_the_same_candidate`
    /// (which pins the adjacent case): both are refused, not just the
    /// farther one.
    #[test]
    fn refuses_reuse_of_the_same_candidate_by_non_adjacent_vertices() {
        let v0 = Point2::new(0.0, 0.0);
        let v1 = Point2::new(10.0, 0.0);
        let v2 = Point2::new(0.000_03, 0.000_02);
        let v3 = Point2::new(10.0, 10.0);
        let q = Point2::new(0.000_01, 0.000_01);
        let mut ring = vec![v0, v1, v2, v3];

        assert!(
            !snap(&mut ring, &[q]),
            "both non-adjacent vertices want the same candidate and neither may take it"
        );
        assert_eq!(
            ring,
            vec![v0, v1, v2, v3],
            "neither ring[0] nor ring[2] may move"
        );
    }
}
