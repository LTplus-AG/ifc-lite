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
/// A snap that would collapse a vertex onto either of its own ring neighbours
/// is refused: that would leave a zero-length edge the CDT cannot
/// triangulate, trading one topological defect for another.
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
    let mut snapped = false;
    for i in 0..n {
        let v = ring[i];
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
        let prev = ring[(i + n - 1) % n];
        let next = ring[(i + 1) % n];
        if q == prev || q == next {
            continue; // would collapse this vertex onto a ring neighbour
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
}
