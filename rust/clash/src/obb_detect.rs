// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Box RECOGNITION: deciding whether a triangle mesh is a rectangular box and
//! recovering its frame. Split out of `obb.rs` (which keeps the penetration
//! DEPTH half) when #5355 pushed that file past the module-size ratchet; the
//! two halves have no shared state and only `Obb`/`OBB_EPS` in common.
//!
//! Faithful port of the `detectObb` half of
//! `packages/clash/src/engine-ts/obb.ts`, kept bit-identical to it.

use super::{Obb, OBB_EPS};
use crate::vec3::{cross, dot, scale, sub, Vec3};

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
/// Bound, in radians, on the direction error of a face normal computed as
/// `cross(b - a, c - a)` from vertices that arrived as f32.
///
/// The vertices carry an absolute coordinate error of about
/// `max|coord| * 2^-22` (`depth::F32_ULP_SCALE`, the same f32-ULP bound the
/// penetration floor uses), so each edge does too. `|cross| = |e1||e2|sin t`,
/// and perturbing the edges by `d` tilts the normal by at most
/// `d * (|e1| + |e2|) / |cross|`. The denominator is what makes this a
/// property of the TRIANGLE's conditioning rather than a constant: a sliver,
/// or a face with one very short edge, resolves its normal far less sharply
/// than a well-shaped one at the same distance from the origin.
///
/// This is the quantity an absolute `OBB_EPS` was standing in for. A fixed
/// bound is simultaneously too loose near the origin and far too tight away
/// from it: a 0.05 m thick panel 1 km out resolves its normals to ~2.7e-4,
/// so `|dot|` between two genuinely perpendicular faces exceeded `1e-6` and
/// the box stopped being recognised as a box purely because it had been
/// translated (#5355).
fn normal_angle_error(a: Vec3, b: Vec3, c: Vec3) -> (f64, f64) {
    let e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let mut max_abs = 0.0f64;
    for v in [a, b, c] {
        for &k in &v {
            let k = k.abs();
            if k > max_abs {
                max_abs = k;
            }
        }
    }
    let coord_err = max_abs.max(1.0) * crate::depth::F32_ULP_SCALE;
    let n = cross(e1, e2);
    let n_len = dot(n, n).sqrt();
    if !(n_len > 0.0) {
        return (f64::INFINITY, coord_err);
    }
    let e1_len = dot(e1, e1).sqrt();
    let e2_len = dot(e2, e2).sqrt();
    (coord_err * (e1_len + e2_len) / n_len, coord_err)
}

/// Largest angle (radians) that f32 noise may widen a box-recognition
/// tolerance to (#5474). The noise bounds are worst cases: for a thin face
/// far from the origin they can exceed the 45 deg at which a box's
/// perpendicular face families stop being told apart at all. Noise may
/// widen a tolerance only up to this angle; data that disagrees by more is
/// not certified a box (the conservative outcome: the caller falls back to
/// the labelled AABB estimate). Exact data far out still certifies, because
/// the tests compare the MEASURED agreement against the tolerance.
const MAX_NOISE_ANGLE: f64 = 0.1;

pub fn detect_obb<M: MeshLike>(mesh: &M) -> Option<Obb> {
    let count = mesh.tri_count();
    if count == 0 {
        return None;
    }
    // Everything position-dependent is measured from a point ON the mesh, not
    // from the world origin (#5474). The box's centre used to be rebuilt as
    // `sum_i c_i * axis_i` from offsets `dot(v, axis_i)` of ABSOLUTE vertex
    // coordinates, so any error in the axes was multiplied by the element's
    // distance from the origin: a 0.05 m panel 123 m out reported a 23 mm
    // depth for a 20 mm overlap, and 1 km out a 65 mm one. Measured from
    // `p0`, the lever arm is the element's own size.
    let p0 = mesh.tri_verts(0)[0];
    let mut groups: Vec<Vec3> = Vec::with_capacity(3);
    // Per family: the direction error bound of its representative (the
    // first triangle's normal, used only to decide membership), and the
    // area-weighted sum of its triangles' normals with the numerator of that
    // sum's direction error bound (see `family_axis`).
    let mut rep_err: Vec<f64> = Vec::with_capacity(3);
    let mut sums: Vec<Vec3> = Vec::with_capacity(3);
    let mut err_num: Vec<f64> = Vec::with_capacity(3);
    let mut group_of_tri: Vec<i32> = vec![-1; count];
    let mut coord_err = 0.0f64;
    let mut reach = 0.0f64;
    // `t` also drives `mesh.tri_verts(t)`, not just `group_of_tri`, and must
    // keep the TS reference's iteration order, so an `enumerate()` over the
    // flag vec is not the shape we want here (mirrors `narrow.rs`).
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let [a, b, c] = mesh.tri_verts(t);
        for v in [a, b, c] {
            let d = sub(v, p0);
            let r = dot(d, d).sqrt();
            if r > reach {
                reach = r;
            }
        }
        let raw = cross(sub(b, a), sub(c, a));
        let n = match normalize(raw) {
            Some(n) => n,
            None => continue, // degenerate triangle: no face-normal evidence
        };
        let cn = canonical(n);
        let (err, tri_coord_err) = normal_angle_error(a, b, c);
        if tri_coord_err > coord_err {
            coord_err = tri_coord_err;
        }
        let mut gi: i32 = -1;
        for (g, rep) in groups.iter().enumerate() {
            // Two normals of the same face agree to within the sum of their
            // own direction errors (`1 - cos e <= e^2 / 2`). `OBB_EPS` stays
            // as the floor, so a mesh at the origin groups exactly as before;
            // far out, a thin face's triangles no longer split into a 4th
            // "family" and decertify a perfect box (#5474).
            let e = (rep_err[g] + err).min(MAX_NOISE_ANGLE);
            if 1.0 - dot(*rep, cn) <= OBB_EPS.max(0.5 * e * e) {
                gi = g as i32;
                break;
            }
        }
        if gi == -1 {
            if groups.len() >= 3 {
                return None; // a 4th face-normal family: not a box
            }
            groups.push(cn);
            rep_err.push(err);
            sums.push([0.0; 3]);
            err_num.push(0.0);
            gi = (groups.len() - 1) as i32;
        }
        let g = gi as usize;
        // `raw` is twice the triangle's area along its normal, so the sum is
        // area-weighted; oriented to the representative so opposite faces
        // add rather than cancel.
        let sign = if dot(raw, groups[g]) < 0.0 { -1.0 } else { 1.0 };
        for k in 0..3 {
            sums[g][k] += sign * raw[k];
        }
        err_num[g] += err * dot(raw, raw).sqrt();
        group_of_tri[t] = gi;
    }
    if groups.len() != 3 {
        return None;
    }
    let (axes, axis_err) = family_axes(&sums, &err_num)?;
    for i in 0..3 {
        for j in (i + 1)..3 {
            // The families' own normals must be perpendicular, to within the
            // sum of their direction errors; `OBB_EPS` stays as a FLOOR so a
            // mesh at the origin is judged as strictly as before #5355.
            let ni = scale(sums[i], 1.0 / dot(sums[i], sums[i]).sqrt());
            let nj = scale(sums[j], 1.0 / dot(sums[j], sums[j]).sqrt());
            let tol = (axis_err[i] + axis_err[j]).min(MAX_NOISE_ANGLE).max(OBB_EPS);
            if dot(ni, nj).abs() > tol {
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
            let o = dot(sub(v, p0), axes[gi]);
            if o < min_off[gi] {
                min_off[gi] = o;
            }
            if o > max_off[gi] {
                max_off[gi] = o;
            }
        }
    }
    // Reject a 3rd offset plane on any axis (e.g. an L-shaped footprint). A
    // vertex on one of the two planes is off it by its own f32 rounding
    // (`coord_err` bounds the difference of two vertices' roundings) plus the
    // axis's direction error across the mesh (`reach` from `p0`); the
    // relative `OBB_EPS` term is the floor that applied before #5474.
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let gi = group_of_tri[t];
        if gi == -1 {
            continue;
        }
        let gi = gi as usize;
        let [a, b, c] = mesh.tri_verts(t);
        let scale = 1.0f64.max(min_off[gi].abs()).max(max_off[gi].abs());
        let tol = (OBB_EPS * scale).max(coord_err + axis_err[gi].min(MAX_NOISE_ANGLE) * reach);
        for v in [a, b, c] {
            let o = dot(sub(v, p0), axes[gi]);
            let near_min = (o - min_off[gi]).abs() <= tol;
            let near_max = (o - max_off[gi]).abs() <= tol;
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
        p0[0] + c0[0] * axes[0][0] + c0[1] * axes[1][0] + c0[2] * axes[2][0],
        p0[1] + c0[0] * axes[0][1] + c0[1] * axes[1][1] + c0[2] * axes[2][1],
        p0[2] + c0[0] * axes[0][2] + c0[1] * axes[1][2] + c0[2] * axes[2][2],
    ];
    Some(Obb { center, axes, half })
}

/// The box frame from the three families' area-weighted normal sums, with a
/// direction error bound per axis (#5474).
///
/// Each family's sum is dominated by its largest faces, which resolve their
/// normal most sharply (`err_num / |sum|` is the area-weighted mean of the
/// triangles' `normal_angle_error`). The frame is then made EXACTLY
/// orthonormal, most precise family first: its axis is its own normalised
/// sum, the next is Gram-Schmidt'ed against it, the last is their cross
/// product. A thin panel's 5 cm side faces therefore inherit the precision
/// of its 3 m faces instead of contributing their own, and a centre rebuilt
/// from the frame cannot pick up a non-orthogonality error. Ties in
/// precision keep family order, so the frame is deterministic.
fn family_axes(sums: &[Vec3], err_num: &[f64]) -> Option<([Vec3; 3], [f64; 3])> {
    let mut err = [0.0f64; 3];
    for g in 0..3 {
        let len = dot(sums[g], sums[g]).sqrt();
        if !(len > 0.0) {
            return None;
        }
        err[g] = err_num[g] / len;
    }
    let mut order = [0usize, 1, 2];
    // Stable insertion sort on the error bound (3 elements).
    for i in 1..3 {
        let mut j = i;
        while j > 0 && err[order[j]] < err[order[j - 1]] {
            order.swap(j, j - 1);
            j -= 1;
        }
    }
    let [f0, f1, f2] = order;
    let a0 = normalize(sums[f0])?;
    let a1 = normalize(sub(sums[f1], scale(a0, dot(sums[f1], a0))))?;
    let mut a2 = cross(a0, a1);
    if dot(a2, sums[f2]) < 0.0 {
        a2 = scale(a2, -1.0);
    }
    let mut axes = [[0.0f64; 3]; 3];
    axes[f0] = a0;
    axes[f1] = a1;
    axes[f2] = a2;
    // An orthogonalised axis is as precise as the axes it was built from.
    let mut axis_err = [0.0f64; 3];
    axis_err[f0] = err[f0];
    axis_err[f1] = err[f0] + err[f1];
    axis_err[f2] = err[f0] + err[f1];
    Some((axes, axis_err))
}

#[cfg(test)]
#[path = "obb_detect_tests.rs"]
mod tests;
