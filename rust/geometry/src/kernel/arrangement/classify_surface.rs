// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{coincident_planes, cross3, dot3, drop_axis_of, e, sub_f64, orient2d_any, orient3d, Sign, Tri};
use crate::kernel::{budget, near_band::NearBand, ImplicitPoint};
use super::finite_patch::{AdjacentFaces, near_shared_patch};
use std::cell::OnceCell;

/// If point `c` lies exactly on a triangle of `others` (coplanar AND inside it),
/// return that triangle's f64 normal — i.e. detect that a sub-triangle whose
/// centroid is `c` sits on a coplanar SHARED face of the other operand.
/// Exact in-plane containment: with `n` the un-normalised face normal of `t`, is
/// `c` strictly inside `t`'s outline projected onto the dropped axis? Shared by the
/// exact and near coplanar-surface tests; false for a degenerate projected `t`.
fn point_in_tri_proj(c: [f64; 3], t: &Tri, n: [f64; 3]) -> bool {
    symbolic_point_in_tri_proj(&e(c), t, n)
}

// Use the original interner point: materializing a rational boundary point can
// move it outside the exact projected edge (#7292).
pub(super) fn symbolic_point_in_tri_proj(c: &ImplicitPoint, t: &Tri, n: [f64; 3]) -> bool {
    let axis = drop_axis_of(n);
    let w0 = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
    if w0 == Sign::Zero {
        return false; // degenerate t in projection
    }
    crate::kernel::coplanar::point_in_tri(c, t, axis, w0)
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
pub(super) fn near_plane_normal(c: [f64; 3], t: &Tri, band: &NearBand) -> Option<[f64; 3]> {
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    let nn = dot3(n, n);
    if nn <= 0.0 || !nn.is_finite() { return None; }
    let d = dot3(sub_f64(c, t[0]), n);
    if d * d > band.scaled_band2(n, nn) { None } else { Some(n) }
}

fn near_on_surface_tri(c: [f64; 3], t: &Tri, band: &NearBand) -> Option<[f64; 3]> {
    near_plane_normal(c, t, band).filter(|&n| point_in_tri_proj(c, t, n))
}

pub(super) fn whole_cell_band(own: &Tri, other: &Tri, n: [f64; 3], band: &NearBand) -> bool {
    let nn = dot3(n, n);
    own.iter().all(|&p| {
        let d = dot3(sub_f64(p, other[0]), n);
        d * d <= band.scaled_band2(n, nn)
    })
}

/// First triangle of `others` that carries `c` on its face AND is near-parallel
/// to the sub-triangle whose raw normal is `n_own` ([`coincident_planes`]).
pub(super) fn on_surface_normal(c: [f64; 3], n_own: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    others
        .iter()
        .find_map(|t| on_surface_tri(c, t).filter(|n| coincident_planes(n_own, *n)))
}

/// The NEAR-coplanar analogue of [`on_surface_normal`], used for any
/// sub-triangle (A side via `BComponents::surface_normal`, B side via
/// `surface_normal_near_a`) whose centroid sits within the snap band of a face of the
/// other operand. Returns the covering `other` face's f64 normal when `c`
/// projects inside it and every vertex of the arranged triangle lies within
/// that plane's existing snap-scatter band AND its finite projected triangle.
/// Finite containment uses the original symbolic interner vertices, not their
/// rounded f64 materializations. Convexity makes three vertex checks sufficient. The whole-triangle check excludes
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
/// and the B-side one (`surface_normal_near_a`) both reach it for transversal cut
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
pub(super) fn near_on_surface_normal(c: [f64; 3], n_own: [f64; 3], own: &Tri, own_exact: [&ImplicitPoint; 3], others: &[Tri], paired_band: &NearBand, adjacency: &OnceCell<AdjacentFaces>) -> Option<[f64; 3]> {
    let mut band = *paired_band;
    band.observe_point(&c);
    others
        .iter()
        .enumerate()
        .find_map(|(i, _)| near_shared_patch(c, n_own, own, own_exact, others, i, &band, adjacency))
}

/// BVH-accelerated equivalent of `on_surface_normal(c, a).is_some() ||
/// near_on_surface_normal(c, a).is_some()` — does ANY triangle of `a` carry `c` on
/// its face (exactly or within the snap band)? `a_band` carries `a`'s per-axis
/// coordinate extents (hoisted once per arrangement, since only `c` varies per
/// call). The query radius is [`NearBand::radius`], the isotropic UPPER bound
/// over every plane normal — never the max-over-axes scalar, which is NOT such
/// a bound and could drop a candidate the per-triangle test would accept — so
/// candidates stay a superset and the exact per-triangle predicates decide; the
/// records whether every matching face is opposed. Mixed orientations retain
/// the established shared-copy rule rather than assigning ownership by order.
pub(super) fn surface_normal_near_a(
    c: [f64; 3],
    n_own: [f64; 3],
    own: &Tri,
    own_exact: [&ImplicitPoint; 3],
    a: &[Tri],
    bvh: &crate::kernel::broadphase::Bvh,
    a_band: &NearBand,
    scratch: &mut Vec<u32>,
    adjacency: &OnceCell<AdjacentFaces>,
) -> Option<([f64; 3], bool)> {
    let mut band = *a_band;
    band.observe_point(&c);
    scratch.clear();
    bvh.point_candidates(c, 2.0 * band.radius(), scratch);
    let mut first = None;
    let mut only_opposed = true;
    for &i in scratch.iter() {
        let t = &a[i as usize];
        if let Some(n) = on_surface_tri(c, t)
            .or_else(|| near_shared_patch(c, n_own, own, own_exact, a, i as usize, &band, adjacency))
            .filter(|&n| coincident_planes(n_own, n)) {
            first.get_or_insert(n);
            only_opposed &= dot3(n_own, n) < 0.0;
        }
    }
    first.map(|n| (n, only_opposed))
}


/// Mixed co-oriented/opposed candidates preserve the established flush policy.
pub(super) fn has_nonopposed_surface(c: [f64; 3], n_own: [f64; 3], own: &Tri, own_exact: [&ImplicitPoint; 3], others: &[Tri], paired_band: &NearBand, adjacency: &OnceCell<AdjacentFaces>) -> bool {
    let mut band = *paired_band;
    band.observe_point(&c);
    others.iter().enumerate().any(|(i, t)| on_surface_tri(c, t)
        .or_else(|| near_shared_patch(c, n_own, own, own_exact, others, i, &band, adjacency))
        .is_some_and(|n| coincident_planes(n_own, n) && dot3(n_own, n) >= 0.0))
}

/// A near shared face must fit the same plane band over its entire arranged
/// triangle and that SAME finite opposite triangle. A centroid alone can hide
/// an interior patch beside a tilted face or beyond its finite outline.
pub(super) fn near_shared_surface_tri(c: [f64; 3], own: &Tri, own_exact: [&ImplicitPoint; 3], other: &Tri, band: &NearBand) -> Option<[f64; 3]> {
    near_on_surface_tri(c, other, band).filter(|&n| {
        whole_cell_band(own, other, n, band) && own_exact.into_iter().all(|point| {
            !budget::tripped() && symbolic_point_in_tri_proj(point, other, n)
        })
    })
}

/// Finite opposite-side probes can straddle a nearby distinct boundary.
/// Use the actual arranged triangle's exact centroid: rounding its three
/// materialized f64 coordinates can move a legitimate centroid off its plane.
pub(super) struct BoundaryCentroid<'a> {
    source: [&'a crate::kernel::ImplicitPoint; 3],
    interval: Option<crate::kernel::interval::IvLam>,
    point: std::cell::OnceCell<[num_rational::BigRational; 3]>,
}

impl<'a> BoundaryCentroid<'a> {
    pub(super) fn new(arr: &'a super::Arrangement, tri: [super::Vid; 3]) -> Option<Self> {
        if budget::tripped() { return None; }
        Some(Self {
            source: tri.map(|v| arr.interner.get(v)),
            interval: centroid_interval(tri.map(|v| *arr.interner.lam_iv(v))),
            point: std::cell::OnceCell::new(),
        })
    }

    fn exact_point(&self) -> Option<&[num_rational::BigRational; 3]> {
        if budget::tripped() { return None; }
        if self.point.get().is_none() {
            // Charge actual exact centroid construction once. An interval
            // rejection needs neither rational coordinates nor an escalation.
            budget::note_escalation();
            if budget::tripped() { return None; }
            self.point.get_or_init(|| {
                let p = self.source.map(crate::kernel::rational::point_of);
                let three = num_rational::BigRational::from_integer(3.into());
                std::array::from_fn(|k| (&p[0][k] + &p[1][k] + &p[2][k]) / &three)
            });
        }
        self.point.get()
    }

    pub(super) fn on_surface(&self, others: &[Tri]) -> bool {
        use crate::kernel::rational::{orient2d_exact_pt, orient3d_exact_pt};
        for t in others {
            if budget::tripped() { return false; }
            // A definite nonzero interval sign proves the exact centroid is
            // off this plane. Zero/uncertainty always uses the exact predicate.
            if self.interval.as_ref().is_some_and(|c| centroid_outside_bounds(c, t)
                || centroid_plane_sign(c, t).is_some_and(|s| s != Sign::Zero)) { continue; }
            let Some(point) = self.exact_point() else { return false; };
            budget::note_escalation();
            if budget::tripped() { return false; }
            if orient3d_exact_pt(point, t[0], t[1], t[2]) != Sign::Zero { continue; }
            let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
            let axis = drop_axis_of(n);
            let winding = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
            if winding == Sign::Zero { continue; }
            let mut inside = true;
            for i in 0..3 {
                budget::note_escalation();
                if budget::tripped() { return false; }
                if orient2d_exact_pt(point, t[i], t[(i + 1) % 3], axis) == winding.flip() {
                    inside = false;
                    break;
                }
            }
            if inside { return true; }
        }
        false
    }
}

fn finite_interval(i: crate::kernel::interval::RnInterval) -> Option<crate::kernel::interval::RnInterval> {
    (i.lo.is_finite() && i.hi.is_finite() && i.lo <= i.hi).then_some(i)
}

/// Homogeneous centroid: sum(lambda_i * d_j * d_k) / (3*d0*d1*d2).
/// Every operation rounds outward; no materialized f64 point is averaged.
fn centroid_interval(points: [crate::kernel::interval::IvLam; 3]) -> Option<crate::kernel::interval::IvLam> {
    use crate::kernel::interval::RnInterval;
    for (lambda, d) in points {
        for i in lambda { finite_interval(i)?; }
        finite_interval(d)?;
        if !matches!(d.sign(), Some(Sign::Positive | Sign::Negative)) { return None; }
    }
    let weights = [
        finite_interval(points[1].1.mul(points[2].1))?,
        finite_interval(points[0].1.mul(points[2].1))?,
        finite_interval(points[0].1.mul(points[1].1))?,
    ];
    let d = finite_interval(finite_interval(points[0].1.mul(weights[0]))?.mul(RnInterval::point(3.0)))?;
    if !matches!(d.sign(), Some(Sign::Positive | Sign::Negative)) { return None; }
    let mut lambda = [RnInterval::point(0.0); 3];
    for k in 0..3 {
        let terms = [
            finite_interval(points[0].0[k].mul(weights[0]))?,
            finite_interval(points[1].0[k].mul(weights[1]))?,
            finite_interval(points[2].0[k].mul(weights[2]))?,
        ];
        lambda[k] = finite_interval(finite_interval(terms[0].add(terms[1]))?.add(terms[2]))?;
    }
    Some((lambda, d))
}

/// A strict homogeneous coordinate comparison can reject remote coplanar
/// triangles too. Uncertainty retains the candidate; there is no division,
/// rounded centroid, padding, or geometric tolerance in this AABB query.
fn centroid_outside_bounds(c: &crate::kernel::interval::IvLam, t: &Tri) -> bool {
    use crate::kernel::interval::RnInterval;
    let Some(denominator) = c.1.sign().filter(|s| *s != Sign::Zero) else { return false; };
    if finite_interval(c.1).is_none() { return false; }
    for k in 0..3 {
        if finite_interval(c.0[k]).is_none() || t.iter().any(|p| !p[k].is_finite()) { continue; }
        let lower = t.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min);
        let upper = t.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max);
        let compare = |bound| {
            let product = finite_interval(c.1.mul(RnInterval::point(bound)))?;
            let difference = finite_interval(c.0[k].sub(product))?;
            Some(crate::kernel::assemble_sign(difference.sign()?, &[denominator]))
        };
        if compare(lower) == Some(Sign::Negative) || compare(upper) == Some(Sign::Positive) { return true; }
    }
    false
}

fn centroid_plane_sign(c: &crate::kernel::interval::IvLam, t: &Tri) -> Option<Sign> {
    // The shared determinant includes products up to degree four in these
    // inputs. 64*m^4 bounds every intermediate (m>=1); if that bound overflows,
    // decline the filter rather than risk an infinity/NaN endpoint operation.
    if !matches!(c.1.sign(), Some(Sign::Positive | Sign::Negative)) { return None; }
    let mut m = 1.0_f64;
    for i in c.0.into_iter().chain([c.1]) {
        finite_interval(i)?;
        m = m.max(i.lo.abs()).max(i.hi.abs());
    }
    for p in t { for &v in p { if !v.is_finite() { return None; } m = m.max(v.abs()); } }
    let square = m * m;
    if !(64.0 * square * square).is_finite() { return None; }
    crate::kernel::interval::indirect_orient3d(&c.0, c.1, t[0], t[1], t[2])
}

#[cfg(test)]
#[path = "classify_surface_tests.rs"]
mod tests;
