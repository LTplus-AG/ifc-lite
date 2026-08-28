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

use super::CONFORM_TOL;
use nalgebra::Point2;

/// Snap every vertex of `ring` that lies within `CONFORM_TOL` of some `cands`
/// entry — but is not already bit-identical to it, and would actually be
/// distinguishable once quantized to the mesh's own f32 output precision —
/// onto that candidate's exact position. Returns whether anything moved.
///
/// A snap that would collapse a vertex onto either of its own ring neighbours
/// is refused: that would leave a zero-length edge the CDT cannot
/// triangulate, trading one topological defect for another.
pub(super) fn snap_near_duplicates(ring: &mut [Point2<f64>], cands: &[Point2<f64>]) -> bool {
    let n = ring.len();
    if n < 3 || cands.is_empty() {
        return false;
    }
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
        if q.x as f32 == v.x as f32 && q.y as f32 == v.y as f32 {
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

    #[test]
    fn snaps_a_near_duplicate_onto_the_candidate() {
        let mut ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.000_02), // 20 µm off the seam's canonical y=0
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let cands = [Point2::new(2.0, 0.0)];
        assert!(snap_near_duplicates(&mut ring, &cands));
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
        assert!(!snap_near_duplicates(&mut ring, &[Point2::new(2.0, 0.0)]));
        // Interior candidate is not near any vertex — no-op.
        assert!(!snap_near_duplicates(&mut ring, &[Point2::new(1.0, 1.0)]));
        // Beyond CONFORM_TOL — no-op.
        assert!(!snap_near_duplicates(&mut ring, &[Point2::new(2.001, 0.0)]));
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
        assert!(!snap_near_duplicates(&mut ring, &cands));
        assert_eq!(ring[1], Point2::new(0.000_02, 0.0), "must not collapse onto neighbour");
    }

    #[test]
    fn refuses_a_snap_invisible_at_f32_mesh_precision() {
        // v and q differ only in the low double-precision bits: as f32 (the
        // mesh's own output type) they are bit-identical, so the move can
        // never be seen and must not force emit_plans to re-triangulate.
        let v_x = 0.329_999_958f64;
        let q_x = v_x + 1.0e-12; // real double-precision gap, invisible in f32
        assert_eq!(v_x as f32, q_x as f32, "fixture must be f32-indistinguishable");
        let mut ring = vec![
            Point2::new(v_x, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let cands = [Point2::new(q_x, 0.0)];
        assert!(!snap_near_duplicates(&mut ring, &cands));
        assert_eq!(ring[0], Point2::new(v_x, 0.0), "f32-invisible move must be refused");
    }

    #[test]
    fn applies_a_snap_visible_at_f32_mesh_precision() {
        // A µm-scale correction (1e-6) at this magnitude changes the f32
        // representation, so it must still fire.
        let v_x = 0.329_999_958f64;
        let q_x = v_x + 1.0e-6;
        assert_ne!(v_x as f32, q_x as f32, "fixture must be f32-distinguishable");
        let mut ring = vec![
            Point2::new(v_x, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let cands = [Point2::new(q_x, 0.0)];
        assert!(snap_near_duplicates(&mut ring, &cands));
        assert_eq!(ring[0], Point2::new(q_x, 0.0));
    }
}
