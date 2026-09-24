// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact penetration depth for the one shape family it can be exact for:
//! rectangular boxes.
//!
//! Faithful port of `packages/clash/src/engine-ts/obb.ts`. `TriMesh::
//! max_penetration_into` (removed) measured the distance from the nearest
//! crossing-triangle VERTEX to the other surface — an O(edge length) sampling
//! artifact that converges to 0 as a mesh is retessellated, the opposite of
//! what a depth metric should do (see the analytic-oracle fixtures in
//! `tests.rs`).
//!
//! This module instead detects when both meshes ARE (within tolerance)
//! rectangular boxes and, only then, reports the minimum translation distance
//! along a separating axis — the classical two-OBB penetration depth, exact
//! for boxes and, because it is derived from the box's face-plane geometry
//! rather than its triangulation, unchanged by retessellation. When either
//! mesh is not confirmed to be a box, the caller falls back to the AABB
//! estimate (never a wrong `Mesh` label).

use crate::vec3::{cross, dot, Vec3};

#[path = "obb_detect.rs"]
mod obb_detect;
pub use obb_detect::{detect_obb, MeshLike};

#[cfg(test)]
#[path = "obb_tests.rs"]
mod obb_tests;

/// Tolerance for normal-direction dedup and offset-plane clustering. Same
/// literal in the TS kernel's `OBB_EPS`.
pub const OBB_EPS: f64 = 1e-6;

/// An oriented box: center, 3 mutually orthogonal unit axes, half-extent
/// along each axis (indices match `axes`).
#[derive(Clone, Copy)]
pub struct Obb {
    pub center: Vec3,
    pub axes: [Vec3; 3],
    pub half: [f64; 3],
}

/// Bound, in f64 ulps, on the absolute error of one component of the cross
/// product of two UNIT vectors, with headroom for the normalisation and the
/// per-projection dot rounding it feeds. Same literal in the TS kernel's
/// `AXIS_NOISE_ULPS`.
pub const AXIS_NOISE_ULPS: f64 = 8.0;

/// An OBB-OBB minimum translation depth and its unit axis.
#[derive(Clone, Copy, Debug)]
pub struct ObbPenetration {
    pub depth: f64,
    pub axis: Vec3,
}

/// Exact penetration depth between two oriented boxes: the minimum overlap
/// over the 15 canonical OBB-OBB separating-axis candidates. See the TS
/// `obbPenetration` doc comment for the full rationale, including the
/// scale-relative conditioning guard on cross-product candidates (review:
/// #2536): a candidate whose overlap verdict falls inside its own noise band
/// — `extent_sum * AXIS_NOISE_ULPS * EPS / len`, the projection error the
/// `1/len` normalisation can amplify at the operands' scale — is never
/// allowed to SEPARATE (dropping a SAT candidate can only fail to find a
/// separation, so the boolean result stays conservative; do not "harden" the
/// skip into a failure). It still contributes a depth candidate of ZERO,
/// because the depth is a minimum and an unresolvable axis is the smallest
/// candidate present — see the guard body and #5355.
///
/// Returns the depth with the UNIT axis it was measured along: the depth's
/// precision floor is the pair's f32 noise projected onto that axis (#5405).
pub fn obb_penetration(a: &Obb, b: &Obb) -> Option<ObbPenetration> {
    let t: Vec3 = [
        b.center[0] - a.center[0],
        b.center[1] - a.center[1],
        b.center[2] - a.center[2],
    ];
    // Operand scale for the per-axis noise bound: the SUMMED half-extents of
    // both boxes plus the center offset — not the projected radii of the
    // axis under test, because an extent nearly perpendicular to the axis
    // projects to ~0 yet contributes its full magnitude of direction-error
    // noise. See the TS `extentSum` comment for the derivation.
    let extent_sum = a.half[0]
        + a.half[1]
        + a.half[2]
        + b.half[0]
        + b.half[1]
        + b.half[2]
        + t[0].abs()
        + t[1].abs()
        + t[2].abs();
    let mut depth = f64::INFINITY;
    let mut depth_axis: Vec3 = [0.0, 0.0, 0.0];

    let mut test_axis = |l: Vec3| -> bool {
        let len = dot(l, l).sqrt();
        // Exactly parallel axes: the candidate is spanned by the remaining
        // axes (classical SAT redundancy), so skipping is exact — and it
        // avoids 0/0 below.
        if !(len > 0.0) {
            return true;
        }
        let u: Vec3 = [l[0] / len, l[1] / len, l[2] / len];
        let r_a = a.half[0] * dot(a.axes[0], u).abs()
            + a.half[1] * dot(a.axes[1], u).abs()
            + a.half[2] * dot(a.axes[2], u).abs();
        let r_b = b.half[0] * dot(b.axes[0], u).abs()
            + b.half[1] * dot(b.axes[1], u).abs()
            + b.half[2] * dot(b.axes[2], u).abs();
        let dist = dot(t, u).abs();
        let overlap = r_a + r_b - dist;
        // Scale-relative conditioning guard — bit-identical to the TS
        // `testAxis` (review: #2536); rationale in the TS doc comment.
        let noise = extent_sum * ((AXIS_NOISE_ULPS * f64::EPSILON) / len);
        if overlap.abs() <= noise {
            // Not a separation (see the doc comment) — but this axis IS a
            // depth candidate, and it must be CLAMPED IN rather than dropped
            // (#5355). The MTD is a MINIMUM over candidates, so an axis whose
            // overlap is indistinguishable from zero is the smallest
            // candidate there is. Dropping it hands the minimum to the
            // next-smallest axis, which for two boxes in flush face contact
            // is a FACE DIMENSION of one of them: a 0.05 m curtain-wall panel
            // meeting a mullion reported 0.85 m of "penetration".
            //
            // "Each remaining axis is a valid upper bound, so the result
            // stays conservative" is true of the BOOLEAN verdict and false of
            // the DEPTH: deleting the minimising axis can only over-report.
            if depth > 0.0 {
                depth = 0.0;
                depth_axis = u;
            }
            return true;
        }
        if overlap <= 0.0 {
            return false;
        }
        if overlap < depth {
            depth = overlap;
            depth_axis = u;
        }
        true
    };

    for i in 0..3 {
        if !test_axis(a.axes[i]) {
            return None;
        }
    }
    for i in 0..3 {
        if !test_axis(b.axes[i]) {
            return None;
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            if !test_axis(cross(a.axes[i], b.axes[j])) {
                return None;
            }
        }
    }
    if depth == f64::INFINITY {
        None
    } else {
        Some(ObbPenetration {
            depth,
            axis: depth_axis,
        })
    }
}

/// Projected radius of `o` onto unit axis `u`: half the length of `o`'s
/// shadow on `u`. The same per-axis projection `obb_penetration`'s
/// `test_axis` computes for the 15-candidate SAT — factored out here so the
/// through-penetration containment test below can reuse it for ANY axis,
/// not only one drawn from a frame shared by both boxes.
fn proj_radius(o: &Obb, u: Vec3) -> f64 {
    o.half[0] * dot(o.axes[0], u).abs()
        + o.half[1] * dot(o.axes[1], u).abs()
        + o.half[2] * dot(o.axes[2], u).abs()
}

/// Whether `p`'s own axes reveal a through-penetration of `p` piercing `q` —
/// `p`'s footprint, in the plane perpendicular to one of `p`'s OWN axes,
/// fits inside `q`'s cross-section there (edges included), while along that axis
/// `p` extends beyond `q` and out the far side. `q`'s extent along any of
/// `p`'s axes is `proj_radius(q, axis)` — the general SAT projection, valid
/// whether or not `q`'s own axes align with `p`'s — so this needs no shared
/// frame.
fn pierces_along(p: &Obb, q: &Obb, center_delta: Vec3) -> bool {
    let margin = |h: f64| OBB_EPS * 1.0f64.max(h);
    for k in 0..3 {
        let i = (k + 1) % 3;
        let j = (k + 2) % 3;
        let axis_k = p.axes[k];
        let axis_i = p.axes[i];
        let axis_j = p.axes[j];
        let off_k = dot(center_delta, axis_k);
        let off_i = dot(center_delta, axis_i);
        let off_j = dot(center_delta, axis_j);
        let r_q_k = proj_radius(q, axis_k);
        let r_q_i = proj_radius(q, axis_i);
        let r_q_j = proj_radius(q, axis_j);
        // P's footprint on the other two axes fits inside Q's, edges
        // INCLUDED — the tolerance opens the test up rather than tightening
        // it. An earlier version demanded a real margin (`r_q_i -
        // margin(r_q_i)`) so that two slabs sharing a footprint would not
        // read as a piercing member; but what actually disqualifies that
        // pair is the `k`-axis test below, and the strict form instead
        // rejected the commonest configuration in any building — two walls
        // crossing at an X-junction, where each pierces the other clean
        // through in thickness but the shared height TIES. That pair
        // reported the full 3 m wall height as a certified `Mesh`
        // penetration (review: #2536 — `main` reported the honest 0.200 m).
        // The strict form was also discontinuous: tilting one wall by 1e-6
        // rad flipped it back to `true`, so a hair of rotation moved the
        // reported depth from 3.000 m to 0.200 m.
        let p_inside_q = off_i.abs() + p.half[i] <= r_q_i + margin(r_q_i)
            && off_j.abs() + p.half[j] <= r_q_j + margin(r_q_j);
        // "Exits the far side" along k means P's interval extends past Q's
        // on BOTH ends, not merely that P's half-extent is the bigger
        // number — a footing embedded 75 mm into a slab from ABOVE is
        // longer than the slab along Z (it does not fit inside it) but only
        // pokes out the TOP, not the bottom, so it is a partial overlap,
        // not a through-penetration. Requiring `p.half[k] > r_q_k +
        // |off_k|` is exactly "P's interval strictly contains Q's interval
        // on axis k", i.e. P pokes out past Q on both sides.
        if p_inside_q && p.half[k] > r_q_k + off_k.abs() + margin(r_q_k) {
            return true;
        }
    }
    false
}

/// Whether `a` and `b` are in a THROUGH-PENETRATION configuration: one box's
/// cross-section, in the plane perpendicular to one of ITS OWN axes, fits
/// inside the other's footprint there, while along that axis it
/// extends beyond the other and out the far side — a thin member piercing
/// clean through a wall/slab, not a partial overlap. The relation is checked
/// BOTH ways, so it also holds for the MUTUAL case: two walls crossing at an
/// X-junction, each piercing the other clean through in thickness.
///
/// Faithful port of the TS `isThroughPenetration` (review: #2536) — see its
/// doc comment for the full rationale: `obb_penetration` reports the
/// minimum translation distance to separate the pair, which for this shape
/// is dominated by the piercing member's own extent along the piercing
/// axis, not by how much material it actually crossed.
///
/// Tests containment against EACH box's own axes independently (via
/// `pierces_along`'s general per-axis projection, the same projection
/// `obb_penetration` already computes for its 15 SAT candidates) —
/// unlike an earlier version restricted to a frame shared by both boxes'
/// axes up to sign, this also catches a member piercing through at a
/// generic relative rotation (review: #2536 follow-up).
pub fn is_through_penetration(a: &Obb, b: &Obb) -> bool {
    let d: Vec3 = [
        b.center[0] - a.center[0],
        b.center[1] - a.center[1],
        b.center[2] - a.center[2],
    ];
    let neg_d: Vec3 = [-d[0], -d[1], -d[2]];
    pierces_along(a, b, d) || pierces_along(b, a, neg_d)
}
