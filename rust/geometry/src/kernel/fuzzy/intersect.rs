// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plain-f64 triangle–triangle intersection SEGMENT (the fuzzy tier's
//! constraint generator), FMA-free and deterministic.
//!
//! Method (Möller interval form): the two triangle planes meet in a line
//! `L = n_a × n_b`. Each triangle, if it straddles the OTHER's plane, crosses it
//! in a segment lying on `L`; the triangles overlap iff those two collinear
//! segments overlap, and their common part is the intersection segment.
//!
//! Only TRANSVERSAL crossings are emitted. Parallel/coplanar pairs (`|L| ≈ 0`)
//! and vertex-on-plane degeneracies (a triangle that does not cross in exactly
//! two edges) return `None` — the fuzzy result is then either legitimately
//! seam-free there or, if not, rejected by the caller's watertight/volume
//! self-check and handled by the exact kernel. All FMA-free f64 over the input
//! (already snap-grid) coordinates ⇒ byte-identical native==wasm.

use super::super::arrangement::Tri;
use super::{cross, dot, sub, tri_normal};

/// An intersection segment: two f64 endpoints on the shared intersection line.
pub(super) type Seg = ([f64; 3], [f64; 3]);

/// Unit normal of a triangle, or `None` for a degenerate (zero-area) one.
fn unit_normal(t: &Tri) -> Option<[f64; 3]> {
    let n = tri_normal(t);
    let len2 = dot(n, n);
    if len2 <= 0.0 || !len2.is_finite() {
        return None;
    }
    let len = len2.sqrt();
    Some([n[0] / len, n[1] / len, n[2] / len])
}

/// Signed distances of `t`'s three vertices to the plane `(n·(x−p0)=0)`.
fn plane_dists(t: &Tri, n: [f64; 3], p0: [f64; 3]) -> [f64; 3] {
    [dot(sub(t[0], p0), n), dot(sub(t[1], p0), n), dot(sub(t[2], p0), n)]
}

/// The two points where triangle `t` crosses a plane, given its per-vertex
/// signed distances `d`. Only STRICT sign changes count as crossings; a
/// well-formed transversal straddle produces exactly two, else `None`.
fn crossing_points(t: &Tri, d: [f64; 3]) -> Option<[[f64; 3]; 2]> {
    let mut pts: [[f64; 3]; 2] = [[0.0; 3]; 2];
    let mut n = 0usize;
    for (i, j) in [(0usize, 1usize), (1, 2), (2, 0)] {
        let (di, dj) = (d[i], d[j]);
        let crosses = (di < 0.0 && dj > 0.0) || (di > 0.0 && dj < 0.0);
        if crosses {
            if n >= 2 {
                return None; // >2 crossings ⇒ numerically ill-formed; defer
            }
            let s = di / (di - dj);
            pts[n] = [
                t[i][0] + s * (t[j][0] - t[i][0]),
                t[i][1] + s * (t[j][1] - t[i][1]),
                t[i][2] + s * (t[j][2] - t[i][2]),
            ];
            n += 1;
        }
    }
    if n == 2 {
        Some(pts)
    } else {
        None
    }
}

/// Intersection segment of triangles `ta` and `tb`, or `None` when they don't
/// cross transversally. `ext` is the operand coordinate magnitude (sizes the
/// parallel-plane and interval-overlap epsilons).
pub(super) fn tri_tri_segment(ta: &Tri, tb: &Tri, ext: f64) -> Option<Seg> {
    let na = unit_normal(ta)?;
    let nb = unit_normal(tb)?;
    // Line direction; if the planes are (near-)parallel there is no transversal
    // segment (coplanar overlap is deliberately deferred to the exact kernel).
    let dir = cross(na, nb);
    let dir_len2 = dot(dir, dir);
    if dir_len2 <= 1.0e-14 {
        return None;
    }
    // Each triangle must straddle the other's plane in exactly two edges.
    let db = plane_dists(tb, na, ta[0]); // tb vs plane A
    let da = plane_dists(ta, nb, tb[0]); // ta vs plane B
    // A perpendicular-gap floor scaled to the operand: distances below it are
    // treated as "on plane" (not a strict crossing) so a flush face doesn't
    // fabricate a spurious hairline segment.
    let eps = (1.0e-9 * ext).max(1.0e-12);
    let snap = |v: [f64; 3]| [zero_if(v[0], eps), zero_if(v[1], eps), zero_if(v[2], eps)];
    let seg_b = crossing_points(tb, snap(db))?; // segment of tb on line L
    let seg_a = crossing_points(ta, snap(da))?; // segment of ta on line L

    // Parametrise all four endpoints along `dir`; intersect the two intervals.
    let param = |p: [f64; 3]| dot(p, dir);
    let (a0, a1) = order(seg_a[0], seg_a[1], param);
    let (b0, b1) = order(seg_b[0], seg_b[1], param);
    // overlap [lo, hi]: start = the later of the two lows, end = the earlier high
    let (lo_pt, lo_t) = if param(a0) >= param(b0) { (a0, param(a0)) } else { (b0, param(b0)) };
    let (hi_pt, hi_t) = if param(a1) <= param(b1) { (a1, param(a1)) } else { (b1, param(b1)) };
    // Reject an empty or degenerate (point) overlap. The tolerance is an
    // in-line length scaled by |dir| (== 1 for unit normals unless the planes
    // are near-parallel, already screened above).
    let len_eps = (1.0e-9 * ext).max(1.0e-12) * dir_len2.sqrt();
    if hi_t - lo_t <= len_eps {
        return None;
    }
    Some((lo_pt, hi_pt))
}

#[inline]
fn zero_if(x: f64, eps: f64) -> f64 {
    if x.abs() <= eps {
        0.0
    } else {
        x
    }
}

/// Order two points by their `param`, returning `(low, high)`.
#[inline]
fn order(p: [f64; 3], q: [f64; 3], param: impl Fn([f64; 3]) -> f64) -> ([f64; 3], [f64; 3]) {
    if param(p) <= param(q) {
        (p, q)
    } else {
        (q, p)
    }
}
