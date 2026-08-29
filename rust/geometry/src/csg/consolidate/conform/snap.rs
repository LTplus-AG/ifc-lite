// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Endpoint snapping for the cross-bucket seam conform — the residual gap
//! `conform_plans`' own "already carries" filter leaves behind.
//!
//! That filter drops a candidate seam vertex whenever this region already has
//! a ring vertex within `CONFORM_TOL` of it, on the (correct, when the two
//! positions are bit-identical) assumption that the corner is already shared.
//! When they are NOT bit-identical — this bucket's own union/weld/simplify
//! landed the same physical corner on a float a few µm from the seam's
//! canonical position — the filter still drops the candidate, so the two
//! buckets keep disagreeing on that corner by that residual amount. That
//! residual is exactly the T-junction the maintainer traced #3353's census
//! regressions to: too small for the coarse open-edge grids to see, real
//! enough that the exact triangulated topology does not close.
//!
//! Inserting a SECOND, near-duplicate vertex to fix it is not an option — a
//! sub-`CONFORM_TOL` pair is what the needle backstop in
//! [`super::super::tri_is_needle`] exists to drop, so a blind insertion here
//! would just reopen the edge it tried to close (the same failure mode
//! `conform_ring`'s own endpoint skip already avoids). Snapping the region's
//! own vertex onto the candidate's exact position instead closes the gap
//! without changing the vertex count, so it cannot create that needle and it
//! does not touch the never-lose-triangles guard's own threshold.
//!
//! # Why a snap must also clear an f32-visibility floor
//!
//! `region.changed` (set whenever this function moves anything) controls far
//! more than the moved vertex: [`super::emit_plans`] uses it to decide whether
//! to reuse pass 1's cached CDT or re-run
//! `triangulate_polygon_with_holes_refined` from scratch on the conformed
//! rings. That re-run is not guaranteed to reproduce the cached triangle set
//! bit-for-bit even when the ring is unchanged in every way that matters —
//! ear/diagonal choice and Ruppert refinement are sensitive to orientation
//! predicates near-degenerate configurations, and re-running it on regions
//! phase B left alone is exactly what caused a +61% geometry regression on
//! ISSUE_129 (see the caching comment in `emit.rs`). A run against
//! `ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc` hosts #528 and #1290
//! confirmed this directly: EVERY one of #528's 82 candidate snaps was a
//! same-corner disagreement of 2.1e-9 units or less — double-precision noise
//! from two independently-computed transform chains landing the same corner a
//! few ULPs apart, not a real seam gap — yet applying even the single
//! smallest of them still forced the re-triangulation and dropped a triangle
//! through the needle backstop. Host #1290 showed the same noise band
//! (≤1.7e-9) alongside genuine µm-scale corrections (≥2.8e-7); nothing fell
//! between the two, a ~140x gap. Skipping the snap whenever the candidate is
//! not distinguishable from the current position AT THE MESH'S OWN OUTPUT
//! PRECISION (`Mesh.positions` is f32) closes exactly that noise band: such a
//! move cannot change what a viewer ever sees, so refusing it costs nothing,
//! while a µm-scale correction remains f32-visible and still fires. This is
//! not a retune of `tri_is_needle` or `CONFORM_TOL` — both are untouched —
//! and it does not touch the never-lose-triangles guard.
//!
//! The f32-visibility check must be done in the frame that `Mesh::add_vertex`
//! actually quantizes: the absolute 3D position `emit_region` reconstructs via
//! `origin + u_axis * p.x + v_axis * p.y`, not the local 2D delta `v` and `q`
//! are expressed in here. f32 ULP scales with magnitude — near zero it is far
//! finer than `CONFORM_TOL`, but on a georeferenced host (`origin` at
//! ~1e6-scale easting/northing) it can exceed `CONFORM_TOL` by orders of
//! magnitude, so a local-delta comparison would almost never agree with what
//! the mesh actually emits. `snap_near_duplicates` therefore takes the
//! plane's own basis (`origin`, `u_axis`, `v_axis`) and lifts both `v` and `q`
//! through it before casting to f32.

use super::CONFORM_TOL;
use nalgebra::{Point2, Point3, Vector3};

/// Snap every vertex of `ring` that lies within `CONFORM_TOL` of some `cands`
/// entry — but is not already bit-identical to it, and would actually be
/// distinguishable once quantized to the mesh's own f32 output precision —
/// onto that candidate's exact position. Returns whether anything moved.
///
/// `origin`, `u_axis` and `v_axis` are the plane's own basis (the same fields
/// `emit_region` in `emit.rs` uses to lift a 2D point to 3D). The
/// f32-visibility check below reconstructs both `v` and `q` through that same
/// `origin + u_axis * p.x + v_axis * p.y` mapping before casting to f32,
/// because that reconstruction — not the local 2D delta — is what
/// `Mesh::add_vertex` actually quantizes.
///
/// A snap that would collapse a vertex onto ANY other ring vertex is refused —
/// not only its two ring-adjacent neighbours. A non-adjacent vertex can sit
/// within `CONFORM_TOL` of the same candidate once the ring has four or more
/// vertices, and the loop carries no cross-vertex state, so two non-adjacent
/// indices can otherwise choose one candidate independently. Refusing only the
/// adjacent case trades a zero-length edge for a duplicate ring vertex, which
/// `conform_regions` records as failing the CDT and dropping the whole region:
/// a hole in the mesh, strictly worse than the sub-visible crack this pass
/// exists to close.
///
/// That "any other ring vertex" guard reads a live, partially-mutated `ring`
/// as the pass proceeds: a vertex processed earlier in iteration order shows
/// its NEW (already-snapped) position to this check, while one not yet
/// reached still shows its ORIGINAL position. Two things follow from that,
/// and both make the result depend on which index the ring walk happens to
/// start or proceed from, not on the ring's actual geometry:
///
///   - two ring vertices can independently choose the exact same candidate
///     point (they need not be adjacent, or even collide with each other's
///     ORIGINAL position — only with the shared candidate). Applying both
///     would itself produce the duplicate this function exists to prevent,
///     so at most one may win, and which one must not depend on which was
///     visited first;
///   - whether a given vertex's candidate is "already taken" is decided by
///     scanning live state, so the same physical ring stored starting from a
///     different index can walk the candidates in a different order and
///     reach a different — but equally valid-looking — outcome.
///
/// Both guards below are therefore evaluated only against snapshots taken
/// before any vertex moves: every OTHER vertex's original position, and every
/// OTHER vertex's own independently-chosen candidate. A shared-candidate
/// collision is resolved by a fixed, order-independent tie-break — the vertex
/// strictly closer (by squared distance to its own original position) wins;
/// an exact tie means neither wins, since there is then no unambiguous winner
/// to pick without depending on iteration order.
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

    // Snapshot the ring before making any decision: every vertex's guards
    // below are evaluated against these ORIGINAL positions and against each
    // other vertex's own chosen candidate — never against another vertex's
    // already-applied move — so the result cannot depend on which index the
    // ring walk starts or proceeds from.
    let orig: Vec<Point2<f64>> = ring.to_vec();

    // Phase 1: pick each vertex's nearest in-tolerance, f32-visible candidate
    // independently of every other vertex's decision. Reads only `orig[i]`
    // and `cands`.
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
        // Below the mesh's own f32 output precision: the move is invisible in
        // anything this pipeline ever emits, so it cannot be the fix for a
        // real T-junction. Applying it anyway would only pay the cost below
        // (forcing emit_plans to discard the cached CDT and re-triangulate)
        // for zero visible benefit — see the module doc for the #528/#1290
        // measurement that this floor is calibrated against.
        //
        // The comparison happens in the SAME frame `Mesh::add_vertex` actually
        // quantizes: the absolute 3D reconstruction, not the local 2D delta.
        // f32 ULP scales with magnitude, and on a georeferenced host `origin`
        // can be ~1e6 units while every candidate here is within `CONFORM_TOL`
        // (1e-4) of `v` — comparing the local deltas as f32 would almost
        // always read as "distinguishable" even though the absolute position
        // this pipeline emits collides.
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

    // Phase 2: accept a chosen candidate only if it cannot create a
    // zero-length or duplicate-vertex edge. Both checks read only the
    // immutable `orig`/`chosen` snapshots — never a neighbour's
    // already-applied move — so neither depends on the order the ring is
    // walked in:
    //
    //   - against every OTHER vertex's ORIGINAL position, so a candidate that
    //     would duplicate any ring vertex is refused;
    //   - against every OTHER vertex's own chosen candidate: if two or more
    //     indices independently picked the exact same target point, only the
    //     one strictly closer to it (by squared distance to its own original
    //     position) may use it; an exact tie means none of them may, since
    //     there is then no unambiguous winner without depending on iteration
    //     order.
    let dist2_to = |i: usize, q: Point2<f64>| {
        let dx = q.x - orig[i].x;
        let dy = q.y - orig[i].y;
        dx * dx + dy * dy
    };
    let mut snapped = false;
    for i in 0..n {
        let Some(q) = chosen[i] else { continue };

        if (0..n).any(|j| j != i && orig[j] == q) {
            continue; // would duplicate another ring vertex's original position
        }

        let d2_i = dist2_to(i, q);
        let loses_the_tie_break =
            (0..n).any(|j| j != i && chosen[j] == Some(q) && dist2_to(j, q) <= d2_i);
        if loses_the_tie_break {
            continue; // another ring index is at least as close to this candidate
        }

        ring[i] = q;
        snapped = true;
    }
    snapped
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Identity basis (origin at zero, axes aligned with x/y): under this
    /// basis `lift` in `snap_near_duplicates` reduces to `Point3::new(p.x,
    /// p.y, 0.0)`, so a local 2D coordinate maps straight onto the same-valued
    /// absolute x/y — every pre-existing test below keeps its original
    /// meaning unchanged.
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

    #[test]
    fn snaps_a_near_duplicate_onto_the_candidate() {
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.000_02), // 20 µm off the seam's canonical y=0
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let cands = [Point2::new(2.0, 0.0)];
        assert!(snap_near_duplicates(
            &mut ring,
            &cands,
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        assert_eq!(ring[1], Point2::new(2.0, 0.0));
        // Everything else untouched.
        assert_eq!(ring[0], Point2::new(0.0, 0.0));
        assert_eq!(ring[2], Point2::new(2.0, 2.0));
    }

    #[test]
    fn bit_identical_and_out_of_tolerance_candidates_are_no_ops() {
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        // Already exact — nothing to snap.
        assert!(!snap_near_duplicates(
            &mut ring,
            &[Point2::new(2.0, 0.0)],
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        // Interior candidate is not near any vertex — no-op.
        assert!(!snap_near_duplicates(
            &mut ring,
            &[Point2::new(1.0, 1.0)],
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        // Beyond CONFORM_TOL — no-op.
        assert!(!snap_near_duplicates(
            &mut ring,
            &[Point2::new(2.001, 0.0)],
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        assert_eq!(
            ring,
            vec![
                Point2::new(0.0, 0.0),
                Point2::new(2.0, 0.0),
                Point2::new(2.0, 2.0),
                Point2::new(0.0, 2.0),
            ]
        );
    }

    #[test]
    fn refuses_a_snap_that_would_collapse_onto_a_neighbour() {
        // A degenerate ring where the candidate for vertex 1 equals vertex 0's
        // position exactly — snapping would zero out the edge between them.
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(0.000_02, 0.0), // 20 µm from vertex 0
            Point2::new(2.0, 2.0),
        ];
        let cands = [Point2::new(0.0, 0.0)];
        assert!(!snap_near_duplicates(
            &mut ring,
            &cands,
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        assert_eq!(
            ring[1],
            Point2::new(0.000_02, 0.0),
            "must not collapse onto neighbour"
        );
    }

    #[test]
    fn refuses_a_snap_invisible_at_f32_mesh_precision() {
        // v and q differ only in the low double-precision bits: as f32 (the
        // mesh's own output type) they are bit-identical, so the move can
        // never be seen and must not force emit_plans to re-triangulate.
        let v_x = 0.329_999_958f64;
        let q_x = v_x + 1.0e-12; // real double-precision gap, invisible in f32
        assert_eq!(
            v_x as f32, q_x as f32,
            "fixture must be f32-indistinguishable"
        );
        let mut ring = vec![
            Point2::new(v_x, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let cands = [Point2::new(q_x, 0.0)];
        assert!(!snap_near_duplicates(
            &mut ring,
            &cands,
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        assert_eq!(
            ring[0],
            Point2::new(v_x, 0.0),
            "f32-invisible move must be refused"
        );
    }

    #[test]
    fn applies_a_snap_visible_at_f32_mesh_precision() {
        // A µm-scale correction (1e-6) at this magnitude changes the f32
        // representation, so it must still fire.
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
        let cands = [Point2::new(q_x, 0.0)];
        assert!(snap_near_duplicates(
            &mut ring,
            &cands,
            ORIGIN(),
            U_AXIS(),
            V_AXIS()
        ));
        assert_eq!(ring[0], Point2::new(q_x, 0.0));
    }

    /// Reproduces the bug this fix closes: a candidate whose LOCAL 2D delta
    /// is well inside `CONFORM_TOL` (so it is nowhere near the local-frame
    /// f32 floor) but whose ABSOLUTE reconstruction — `origin.x + local.x`,
    /// the actual value `Mesh::add_vertex` quantizes — collides at f32 once
    /// `origin` sits at a realistic georeferenced-host magnitude (~2.6e6
    /// easting). The pre-fix, local-only comparison would have applied this
    /// snap (invisible to any viewer, paying the cached-CDT invalidation for
    /// nothing); the frame-correct comparison must refuse it.
    #[test]
    fn refuses_a_snap_invisible_at_f32_precision_only_once_lifted_to_the_georeferenced_frame() {
        let origin = Point3::new(2_600_000.0, 0.0, 0.0);
        let v_local = Point2::new(0.0, 0.0);
        let q_local = Point2::new(9.9e-5, 0.0); // within CONFORM_TOL (1e-4)

        // Sanity: LOCAL f32 values are distinguishable — the pre-fix guard
        // (`q.x as f32 == v.x as f32` on the raw local coordinates) would
        // NOT have refused this snap.
        assert_ne!(
            q_local.x as f32, v_local.x as f32,
            "fixture must be f32-distinguishable in the local frame"
        );
        // But the ABSOLUTE reconstruction this pipeline actually emits
        // collides at f32: origin.x + q_local.x and origin.x + v_local.x
        // round to the same f32 value at this magnitude.
        let v_abs_x = (origin.x + v_local.x) as f32;
        let q_abs_x = (origin.x + q_local.x) as f32;
        assert_eq!(
            v_abs_x, q_abs_x,
            "fixture must be f32-indistinguishable once reconstructed to the absolute frame"
        );

        let mut ring = vec![
            v_local,
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let cands = [q_local];
        assert!(
            !snap_near_duplicates(&mut ring, &cands, origin, U_AXIS(), V_AXIS()),
            "a snap invisible in the absolute (mesh-emitted) frame must be refused \
             even though it is visible in the local 2D frame"
        );
        assert_eq!(ring[0], v_local, "f32-invisible move must be refused");
    }

    #[test]
    fn refuses_a_snap_that_would_collapse_onto_a_non_adjacent_vertex() {
        // A pentagon (n = 5, so NOT every vertex is mutually adjacent).
        // ring[3] sits within CONFORM_TOL of ring[0]'s exact position but is
        // not bit-identical to it, so ring[0]'s position is an eligible snap
        // target for it. ring[3]'s ring-adjacent neighbours are ring[2] and
        // ring[4] — neither is ring[0] — so an adjacent-only guard never looks
        // at ring[0] and lets the snap through, producing a duplicate ring
        // vertex. `conform_regions` records that a duplicate fails the CDT and
        // drops the whole region, so this must be refused even though the two
        // vertices are two steps apart in winding order.
        let ring0 = Point2::new(0.0, 0.0);
        let ring1 = Point2::new(10.0, 0.0);
        let ring2 = Point2::new(10.0, 10.0);
        let ring3 = Point2::new(0.000_05, 0.000_03);
        let ring4 = Point2::new(0.0, 10.0);
        let mut ring = vec![ring0, ring1, ring2, ring3, ring4];
        let cands = [ring0];

        let moved = snap_near_duplicates(&mut ring, &cands, ORIGIN(), U_AXIS(), V_AXIS());

        assert!(
            !moved,
            "snapping ring[3] onto ring[0]'s position would duplicate a non-adjacent vertex"
        );
        assert_eq!(
            ring[3], ring3,
            "non-adjacent vertex must not be snapped onto ring[0]'s position"
        );
        assert_ne!(
            ring[3], ring[0],
            "ring must not end up with two bit-identical vertices"
        );
    }

    #[test]
    fn result_is_independent_of_ring_traversal_order() {
        // Physical ring (a square-ish quad): V0=(0,0), V1=(3e-5,0),
        // V2=(10,10), V3=(0,10). Two candidates: C_A is bit-identical to
        // V1's ORIGINAL position and is V0's nearest candidate; C_C is near
        // V1 (not bit-identical) and is V1's nearest candidate. Both are
        // within CONFORM_TOL of their nearest vertex; V2/V3 are far from
        // both and never match either candidate.
        //
        // Walking the ring forward, V0 is decided before V1, and vice versa
        // walking it starting from V1: a live-array duplicate check would
        // read one of the two vertices' NEW position instead of its
        // ORIGINAL one depending on which is visited first, and so accept
        // or refuse V0's snap onto C_A (which is bit-identical to V1's
        // ORIGINAL position) differently depending on storage order alone —
        // same physical ring, different result. This pins the fixed,
        // order-independent result instead.
        let v0 = Point2::new(0.0, 0.0);
        let v1 = Point2::new(3.0e-5, 0.0);
        let v2 = Point2::new(10.0, 10.0);
        let v3 = Point2::new(0.0, 10.0);
        let c_a = v1; // bit-identical to V1's original position
        let c_c = Point2::new(3.0e-5, 5.0e-5);
        let cands = [c_a, c_c];

        let mut forward = vec![v0, v1, v2, v3];
        snap_near_duplicates(&mut forward, &cands, ORIGIN(), U_AXIS(), V_AXIS());

        // Same physical ring (identical edge set), storage order reversed.
        let mut reversed = vec![v3, v2, v1, v0];
        snap_near_duplicates(&mut reversed, &cands, ORIGIN(), U_AXIS(), V_AXIS());

        // Map the reversed run's result back onto the same physical
        // positions as `forward`: index k in `forward` <-> index (n-1-k) in
        // `reversed`.
        let n = forward.len();
        let remapped: Vec<Point2<f64>> = (0..n).map(|k| reversed[n - 1 - k]).collect();

        assert_eq!(
            forward, remapped,
            "snap_near_duplicates must not depend on which index the ring \
             traversal starts from — both describe the same ring"
        );
        // Pin the actual expected geometry too, not just cross-order
        // agreement: V0 must stay put (its only candidate equals V1's own
        // original position) and V1 must snap to C_C.
        assert_eq!(forward, vec![v0, c_c, v2, v3]);
    }

    #[test]
    fn refuses_both_when_adjacent_vertices_pick_the_same_candidate() {
        // A and B are adjacent ring vertices 3e-5 apart; the single
        // candidate M sits EXACTLY between them, within CONFORM_TOL of
        // both, so both A and B independently pick M as their nearest
        // candidate and are exactly tied on distance to it. Applying either
        // would collapse the A-B edge to zero length, and the exact tie
        // leaves no unambiguous winner, so both must be refused.
        let a = Point2::new(0.0, 0.0);
        let b = Point2::new(3.0e-5, 0.0);
        let c = Point2::new(2.0, 2.0);
        let d = Point2::new(0.0, 2.0);
        let m = Point2::new(1.5e-5, 0.0); // equidistant from a and b

        let mut ring = vec![a, b, c, d];
        let moved = snap_near_duplicates(&mut ring, &[m], ORIGIN(), U_AXIS(), V_AXIS());

        assert!(
            !moved,
            "both candidates tie on distance and must be refused"
        );
        assert_eq!(ring, vec![a, b, c, d], "neither A nor B may move");
    }

    #[test]
    fn refuses_reuse_of_the_same_candidate_by_non_adjacent_vertices() {
        // A quad (n = 4): ring[0] and ring[2] are OPPOSITE corners, not ring
        // neighbours of each other. Both independently sit within
        // CONFORM_TOL of the single candidate `q` and are not bit-identical
        // to it, so both pass phase 1. A guard that only compared each
        // vertex's chosen candidate against its two ring-adjacent
        // neighbours would miss this collision entirely, since ring[0] and
        // ring[2] are not adjacent, and would let BOTH apply `q`, producing
        // a duplicate ring vertex. ring[0] is strictly closer to `q` than
        // ring[2] is, so the deterministic tie-break must let ring[0] win
        // and refuse ring[2].
        let v0 = Point2::new(0.0, 0.0);
        let v1 = Point2::new(10.0, 0.0);
        let v2 = Point2::new(0.000_03, 0.000_02);
        let v3 = Point2::new(10.0, 10.0);
        let q = Point2::new(0.000_01, 0.000_01);
        let mut ring = vec![v0, v1, v2, v3];
        let cands = [q];

        let moved = snap_near_duplicates(&mut ring, &cands, ORIGIN(), U_AXIS(), V_AXIS());

        assert!(
            moved,
            "the strictly closer vertex must still win the candidate"
        );
        assert_eq!(
            ring[0], q,
            "ring[0] is closer to q and must win the tie-break"
        );
        assert_eq!(
            ring[2], v2,
            "ring[2] lost the tie-break and must not also snap onto q"
        );
        assert_ne!(
            ring[0], ring[2],
            "ring must not end up with two bit-identical vertices"
        );
    }
}
