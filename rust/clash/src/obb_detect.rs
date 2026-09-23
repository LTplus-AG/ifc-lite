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
use crate::vec3::{cross, dot, Vec3};

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
fn normal_angle_error(a: Vec3, b: Vec3, c: Vec3) -> f64 {
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
        return f64::INFINITY;
    }
    let e1_len = dot(e1, e1).sqrt();
    let e2_len = dot(e2, e2).sqrt();
    coord_err * (e1_len + e2_len) / n_len
}

pub fn detect_obb<M: MeshLike>(mesh: &M) -> Option<Obb> {
    let count = mesh.tri_count();
    if count == 0 {
        return None;
    }
    let mut groups: Vec<Vec3> = Vec::with_capacity(3);
    // Per-family bound on the representative normal's direction error.
    let mut group_err: Vec<f64> = Vec::with_capacity(3);
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
            // The representative IS this triangle's normal, so the bound that
            // applies to the orthogonality test below is this triangle's.
            group_err.push(normal_angle_error(a, b, c));
            gi = (groups.len() - 1) as i32;
        }
        group_of_tri[t] = gi;
    }
    if groups.len() != 3 {
        return None;
    }
    for i in 0..3 {
        for j in (i + 1)..3 {
            // Two unit normals each uncertain in direction by `group_err`
            // can read as non-perpendicular by up to the sum of those
            // angles (`|dot| = |cos(90 deg +/- e)| <= sin e_i + sin e_j
            // <= e_i + e_j`). `OBB_EPS` stays as a FLOOR so a mesh at the
            // origin, where the derived bound collapses towards zero, is
            // judged exactly as strictly as it was before #5355.
            let tol = (group_err[i] + group_err[j]).max(OBB_EPS);
            if dot(groups[i], groups[j]).abs() > tol {
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
