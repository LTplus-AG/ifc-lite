// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{coincident_planes, cross3, dot3, drop_axis_of, e, sub_f64, orient2d_any, orient3d, Sign, Tri};
use crate::kernel::{budget, near_band::NearBand};

/// If point `c` lies exactly on a triangle of `others` (coplanar AND inside it),
/// return that triangle's f64 normal — i.e. detect that a sub-triangle whose
/// centroid is `c` sits on a coplanar SHARED face of the other operand.
/// Exact in-plane containment: with `n` the un-normalised face normal of `t`, is
/// `c` strictly inside `t`'s outline projected onto the dropped axis? Shared by the
/// exact and near coplanar-surface tests; false for a degenerate projected `t`.
fn point_in_tri_proj(c: [f64; 3], t: &Tri, n: [f64; 3]) -> bool {
    let axis = drop_axis_of(n);
    let w0 = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
    if w0 == Sign::Zero {
        return false; // degenerate t in projection
    }
    let inside = |u: [f64; 3], v: [f64; 3]| orient2d_any(&e(u), &e(v), &e(c), axis) != w0.flip();
    inside(t[0], t[1]) && inside(t[1], t[2]) && inside(t[2], t[0])
}

/// Per-triangle exact coincident-face test (see [`on_surface_normal`]).
fn on_surface_tri(c: [f64; 3], t: &Tri) -> Option<[f64; 3]> {
    if orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(c)) != Sign::Zero {
        return None; // c not on t's plane
    }
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    point_in_tri_proj(c, t, n).then_some(n)
}

/// Per-triangle near-coplanar-flush test (see [`near_on_surface_normal`]); the
/// plane-gap tolerance is resolved from `band` against THIS triangle's own
/// normal, so an operand offset along an axis this face does not face cannot
/// widen it.
fn near_on_surface_tri(c: [f64; 3], t: &Tri, band: &NearBand) -> Option<[f64; 3]> {
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if nn <= 0.0 || !nn.is_finite() {
        return None; // degenerate t
    }
    let d = dot3(sub_f64(c, t[0]), n); // perp_dist · |n|, as `scaled_band2` is
    if d * d > band.scaled_band2(n, nn) {
        return None; // c not within the snap band of t's plane
    }
    point_in_tri_proj(c, t, n).then_some(n)
}

/// First triangle of `others` that carries `c` on its face AND is near-parallel
/// to the sub-triangle whose raw normal is `n_own` ([`coincident_planes`]).
pub(super) fn on_surface_normal(c: [f64; 3], n_own: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    others
        .iter()
        .find_map(|t| on_surface_tri(c, t).filter(|n| coincident_planes(n_own, *n)))
}

/// Canonical near-coplanar band (see [`near_on_surface_normal`]): the
/// `SNAP_GRID` scatter envelope plus the operands' per-axis extents projected
/// onto the plane under test, defined once in `near_band`.


/// The NEAR-coplanar analogue of [`on_surface_normal`], used for any
/// sub-triangle (A side via `BComponents::surface_normal`, B side via
/// `c_on_or_near_a`) whose centroid sits within the snap band of a face of the
/// other operand. Returns the covering `other` face's f64 normal when `c`
/// projects inside it and every vertex of the arranged triangle lies within
/// that plane's existing snap-scatter band. The whole-triangle check excludes
/// interior patches whose centroid alone happens to lie near a tilted face.
///
/// WHY this exists — the flush-cap defect (#1007 host #1112 openings #2150/#2154):
/// real IFC is f32, so an opening cap authored EXACTLY flush with a TILTED roof
/// surface is NOT exactly coplanar after `mesh_bridge`'s per-axis snap — each
/// operand scatters up to `SNAP_GRID·√3` off the shared tilted plane. The exact
/// [`on_surface_normal`] needs `orient3d == 0` (centroid bit-exactly on the other
/// face's plane), so it MISSES the flush cap; the sub-triangle then falls to the
/// fragile `solid_side` probe (regime 2) or the on-boundary centroid ray-cast
/// (regime 3), both undefined at a µm-flush interface ⇒ the inside-footprint host
/// sub-triangle is wrongly KEPT and bridges the opening.
///
/// DETERMINISM: the only inexactness vs. [`on_surface_normal`] is the perpendicular
/// plane-gap admitted over the whole arranged triangle (the `band` test);
/// the centroid's in-plane containment still uses the
/// EXACT `orient2d_any`. `band` is an absolute power-of-two multiple of `SNAP_GRID`
/// (≈ the 2-operand scatter envelope) widened only for far-from-origin operands
/// (coarser f32 import) — and only along the axes the tested face's normal weighs,
/// since [`NearBand`] projects the per-axis extents onto that normal: a 10 km X
/// offset leaves a Z-normal face at the floor instead of opening it to ~2.4 mm and
/// welding separate surfaces (`csg/world_frame_tests.rs`). Always THREE orders
/// below the smallest real feature edge (~0.2 m), so a distinct parallel face
/// can never be within it. All FMA-free f64 over input coords ⇒ byte-identical
/// native==wasm.
///
/// NOT GATED on the near-coplanar-parent flag (`coplanar_a`), despite what
/// this paragraph used to claim. The A-side caller (`BComponents::surface_normal`)
/// and the B-side one (`c_on_or_near_a`) both reach it for transversal cut
/// faces too. Gating the A-side call on the flag was measured as a fix for
/// #3353: it closes `sweep_261` and takes the union sweep 98 -> 77, but it
/// regresses 20 golden census hosts and breaks two pinned near-band invariants
/// in `clash_intersection_oracle.rs`
/// (`no_surviving_near_band_triangle_has_an_x_facing_normal` and
/// `the_near_band_shortfall_is_a_missing_face_pair_not_a_shape_dependent_wedge`),
/// both of which need this path ungated. See `issue_3353_vid_census_tests.rs`.
///
/// What IS required, per candidate face, is [`coincident_planes`] (#4439): the
/// sub-triangle's own plane must be near-parallel to the face its centroid
/// sits within the band of. A transversal sub-triangle whose centroid happens
/// to fall in the band — a needle hugging the two faces' intersection line
/// (#4439, #3353's `sweep_261`) — is not a coincident face and falls through
/// to the ray-cast. That is a per-face angle test, not a parent-flag gate, so
/// the discovery remains ungated. The whole-triangle band check (#7292) also
/// requires the proposed shared patch to fit that same plane envelope.
pub(super) fn near_on_surface_normal(c: [f64; 3], n_own: [f64; 3], own: &Tri, others: &[Tri]) -> Option<[f64; 3]> {
    let mut band = NearBand::default();
    band.observe_point(&c);
    band.observe_tris(others);
    others
        .iter()
        .find_map(|t| near_shared_surface_tri(c, own, t, &band).filter(|n| coincident_planes(n_own, *n)))
}

/// BVH-accelerated equivalent of `on_surface_normal(c, a).is_some() ||
/// near_on_surface_normal(c, a).is_some()` — does ANY triangle of `a` carry `c` on
/// its face (exactly or within the snap band)? `a_band` carries `a`'s per-axis
/// coordinate extents (hoisted once per arrangement, since only `c` varies per
/// call). The query radius is [`NearBand::radius`], the isotropic UPPER bound
/// over every plane normal — never the max-over-axes scalar, which is NOT such
/// a bound and could drop a candidate the per-triangle test would accept — so
/// candidates stay a superset and the exact per-triangle predicates decide; the
/// result is `any`, so it is candidate-order independent and byte-identical to
/// the linear scan.
pub(super) fn c_on_or_near_a(
    c: [f64; 3],
    n_own: [f64; 3],
    own: &Tri,
    a: &[Tri],
    bvh: &crate::kernel::broadphase::Bvh,
    a_band: &NearBand,
    scratch: &mut Vec<u32>,
) -> bool {
    let mut band = *a_band;
    band.observe_point(&c);
    scratch.clear();
    bvh.point_candidates(c, band.radius(), scratch);
    scratch.iter().any(|&i| {
        let t = &a[i as usize];
        on_surface_tri(c, t)
            .or_else(|| near_shared_surface_tri(c, own, t, &band))
            .is_some_and(|n| coincident_planes(n_own, n))
    })
}


/// A near shared face must fit the same plane band over its entire arranged
/// triangle. A centroid alone can hide an interior patch beside a tilted face.
fn near_shared_surface_tri(c: [f64; 3], own: &Tri, other: &Tri, band: &NearBand) -> Option<[f64; 3]> {
    near_on_surface_tri(c, other, band).filter(|&n| {
        let nn = dot3(n, n);
        own.iter().all(|&p| {
            let d = dot3(sub_f64(p, other[0]), n);
            d * d <= band.scaled_band2(n, nn)
        })
    })
}

/// Finite opposite-side probes can straddle a nearby distinct boundary.
/// Use the actual arranged triangle's exact centroid: rounding its three
/// materialized f64 coordinates can move a legitimate centroid off its plane.
pub(super) struct BoundaryCentroid {
    point: [num_rational::BigRational; 3],
}

impl BoundaryCentroid {
    pub(super) fn new(arr: &super::Arrangement, tri: [super::Vid; 3]) -> Option<Self> {
        if budget::tripped() { return None; }
        // One count for exact centroid construction, then one per exact_pt
        // predicate below: deterministic work from the same symbolic operands.
        budget::note_escalation();
        if budget::tripped() { return None; }
        let p = tri.map(|v| crate::kernel::rational::point_of(arr.interner.get(v)));
        let three = num_rational::BigRational::from_integer(3.into());
        Some(Self { point: std::array::from_fn(|k| (&p[0][k] + &p[1][k] + &p[2][k]) / &three) })
    }

    pub(super) fn on_surface(&self, others: &[Tri]) -> bool {
        use crate::kernel::rational::{orient2d_exact_pt, orient3d_exact_pt};
        for t in others {
            if budget::tripped() { return false; }
            budget::note_escalation();
            if budget::tripped() { return false; }
            if orient3d_exact_pt(&self.point, t[0], t[1], t[2]) != Sign::Zero {
                continue;
            }
            let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
            let axis = drop_axis_of(n);
            let winding = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
            if winding == Sign::Zero { continue; }
            let mut inside = true;
            for i in 0..3 {
                budget::note_escalation();
                if budget::tripped() { return false; }
                if orient2d_exact_pt(&self.point, t[i], t[(i + 1) % 3], axis) == winding.flip() {
                    inside = false;
                    break;
                }
            }
            if inside { return true; }
        }
        false
    }
}

#[cfg(test)]
#[path = "classify_surface_tests.rs"]
mod tests;
