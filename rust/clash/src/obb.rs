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

fn normalize(v: Vec3) -> Option<Vec3> {
    let len = dot(v, v).sqrt();
    if !(len > OBB_EPS) {
        return None;
    }
    Some([v[0] / len, v[1] / len, v[2] / len])
}

/// Flip `n` so its largest-magnitude component is positive, so a face and its
/// antipodal opposite face collapse to the same canonical axis direction.
/// Ties broken in x, y, z order — identical to the TS `canonical`.
fn canonical(n: Vec3) -> Vec3 {
    let (ax, ay, az) = (n[0].abs(), n[1].abs(), n[2].abs());
    let mut idx = 0usize;
    if ay > ax && ay >= az {
        idx = 1;
    } else if az > ax && az > ay {
        idx = 2;
    }
    if n[idx] < 0.0 {
        [-n[0], -n[1], -n[2]]
    } else {
        n
    }
}

/// Minimal structural view of `TriMesh` this module needs.
pub trait MeshLike {
    fn tri_count(&self) -> usize;
    fn tri_verts(&self, t: usize) -> [Vec3; 3];
}

/// Detect whether `mesh` is a rectangular box. See the TS `detectObb` doc
/// comment for the full rationale — this is a faithful, bit-identical port.
pub fn detect_obb<M: MeshLike>(mesh: &M) -> Option<Obb> {
    let count = mesh.tri_count();
    if count == 0 {
        return None;
    }
    let mut groups: Vec<Vec3> = Vec::with_capacity(3);
    let mut group_of_tri: Vec<i32> = vec![-1; count];
    // `t` also drives `mesh.tri_verts(t)`, not just `group_of_tri`, and must
    // keep the TS reference's iteration order, so an `enumerate()` over the
    // flag vec is not the shape we want here (mirrors `narrow.rs`).
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let [a, b, c] = mesh.tri_verts(t);
        let n = match normalize(cross(
            [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        )) {
            Some(n) => n,
            None => continue, // degenerate triangle: no face-normal evidence
        };
        let cn = canonical(n);
        let mut gi: i32 = -1;
        for (g, rep) in groups.iter().enumerate() {
            if dot(*rep, cn) > 1.0 - OBB_EPS {
                gi = g as i32;
                break;
            }
        }
        if gi == -1 {
            if groups.len() >= 3 {
                return None; // a 4th face-normal family: not a box
            }
            groups.push(cn);
            gi = (groups.len() - 1) as i32;
        }
        group_of_tri[t] = gi;
    }
    if groups.len() != 3 {
        return None;
    }
    for i in 0..3 {
        for j in (i + 1)..3 {
            if dot(groups[i], groups[j]).abs() > OBB_EPS {
                return None;
            }
        }
    }

    let mut min_off = [f64::INFINITY; 3];
    let mut max_off = [f64::NEG_INFINITY; 3];
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let gi = group_of_tri[t];
        if gi == -1 {
            continue;
        }
        let gi = gi as usize;
        let [a, b, c] = mesh.tri_verts(t);
        for v in [a, b, c] {
            let o = dot(v, groups[gi]);
            if o < min_off[gi] {
                min_off[gi] = o;
            }
            if o > max_off[gi] {
                max_off[gi] = o;
            }
        }
    }
    // Reject a 3rd offset plane on any axis (e.g. an L-shaped footprint).
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let gi = group_of_tri[t];
        if gi == -1 {
            continue;
        }
        let gi = gi as usize;
        let [a, b, c] = mesh.tri_verts(t);
        for v in [a, b, c] {
            let o = dot(v, groups[gi]);
            let scale = 1.0f64.max(min_off[gi].abs()).max(max_off[gi].abs());
            let near_min = (o - min_off[gi]).abs() <= OBB_EPS * scale;
            let near_max = (o - max_off[gi]).abs() <= OBB_EPS * scale;
            if !near_min && !near_max {
                return None;
            }
        }
    }

    let mut half = [0.0f64; 3];
    let mut c0 = [0.0f64; 3];
    for i in 0..3 {
        half[i] = (max_off[i] - min_off[i]) / 2.0;
        c0[i] = (max_off[i] + min_off[i]) / 2.0;
        // Reject a zero-thickness "box": a face family whose triangles are
        // all coplanar passes the 2-plane test above (`min_off == max_off`,
        // so both `near_min` and `near_max` hold for every vertex) with no
        // positive extent along that axis. An open shell (a slab exported
        // without its top face, or partial `IfcTriangulatedFaceSet`
        // geometry) can produce exactly this. Faithful port of the same
        // guard in the TS `detectObb` (review: #2536).
        if !(half[i] > OBB_EPS) {
            return None;
        }
    }
    let center: Vec3 = [
        c0[0] * groups[0][0] + c0[1] * groups[1][0] + c0[2] * groups[2][0],
        c0[0] * groups[0][1] + c0[1] * groups[1][1] + c0[2] * groups[2][1],
        c0[0] * groups[0][2] + c0[1] * groups[1][2] + c0[2] * groups[2][2],
    ];
    Some(Obb {
        center,
        axes: [groups[0], groups[1], groups[2]],
        half,
    })
}

/// Bound, in f64 ulps, on the absolute error of one component of the cross
/// product of two UNIT vectors, with headroom for the normalisation and the
/// per-projection dot rounding it feeds. Same literal in the TS kernel's
/// `AXIS_NOISE_ULPS`.
pub const AXIS_NOISE_ULPS: f64 = 8.0;

/// Exact penetration depth between two oriented boxes: the minimum overlap
/// over the 15 canonical OBB-OBB separating-axis candidates. See the TS
/// `obbPenetrationDepth` doc comment for the full rationale, including the
/// scale-relative conditioning guard on cross-product candidates (review:
/// #2536): a candidate whose overlap verdict falls inside its own noise band
/// — `extent_sum * AXIS_NOISE_ULPS * EPS / len`, the projection error the
/// `1/len` normalisation can amplify at the operands' scale — is SKIPPED
/// (never a separation: dropping a SAT candidate can only fail to find a
/// separation, each remaining axis being a valid upper bound on the true
/// depth, so the result stays conservative; do not "harden" the skip into a
/// failure).
pub fn obb_penetration_depth(a: &Obb, b: &Obb) -> Option<f64> {
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
            return true;
        }
        if overlap <= 0.0 {
            return false;
        }
        if overlap < depth {
            depth = overlap;
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
        Some(depth)
    }
}

/// Projected radius of `o` onto unit axis `u`: half the length of `o`'s
/// shadow on `u`. The same per-axis projection `obb_penetration_depth`'s
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
/// doc comment for the full rationale: `obb_penetration_depth` reports the
/// minimum translation distance to separate the pair, which for this shape
/// is dominated by the piercing member's own extent along the piercing
/// axis, not by how much material it actually crossed.
///
/// Tests containment against EACH box's own axes independently (via
/// `pierces_along`'s general per-axis projection, the same projection
/// `obb_penetration_depth` already computes for its 15 SAT candidates) —
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
