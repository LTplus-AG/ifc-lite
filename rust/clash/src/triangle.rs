// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Triangle-triangle intersection (SAT) and minimum-distance routines.
//!
//! Faithful port of `packages/clash/src/math/triangle-intersect.ts` and
//! `triangle-distance.ts`.

use crate::vec3::{add, cross, dist_sq, dot, scale, sub, Vec3};

const EPS: f64 = 1e-12;

/// Exact triangle-triangle intersection via the Separating Axis Theorem.
///
/// Tests the 2 face normals plus the up-to-9 edge-edge cross-product axes
/// (axes whose squared length is `<= eps` are skipped). Returns `true` only
/// when the triangle *interiors* overlap; bare touching (coincident
/// faces/edges/vertices) reports `false`. The `<=` comparison makes exact
/// contact count as separation (a touch), not interpenetration.
pub fn tri_tri_intersect(
    a0: Vec3,
    a1: Vec3,
    a2: Vec3,
    b0: Vec3,
    b1: Vec3,
    b2: Vec3,
) -> bool {
    let edges_a = [sub(a1, a0), sub(a2, a1), sub(a0, a2)];
    let edges_b = [sub(b1, b0), sub(b2, b1), sub(b0, b2)];

    let mut axes: Vec<Vec3> = Vec::with_capacity(11);
    axes.push(cross(edges_a[0], edges_a[1]));
    axes.push(cross(edges_b[0], edges_b[1]));
    for &ea in &edges_a {
        for &eb in &edges_b {
            let axis = cross(ea, eb);
            if dot(axis, axis) > EPS {
                axes.push(axis);
            }
        }
    }

    let va = [a0, a1, a2];
    let vb = [b0, b1, b2];

    for axis in axes {
        let mut min_a = f64::INFINITY;
        let mut max_a = f64::NEG_INFINITY;
        let mut min_b = f64::INFINITY;
        let mut max_b = f64::NEG_INFINITY;
        for &v in &va {
            let p = dot(v, axis);
            if p < min_a {
                min_a = p;
            }
            if p > max_a {
                max_a = p;
            }
        }
        for &v in &vb {
            let p = dot(v, axis);
            if p < min_b {
                min_b = p;
            }
            if p > max_b {
                max_b = p;
            }
        }
        // `<=` so exact contact counts as separation (touch), not interpenetration.
        if max_a <= min_b || max_b <= min_a {
            return false;
        }
    }

    true
}

#[inline]
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Closest points between two segments `[p1, q1]` and `[p2, q2]`.
///
/// Ericson, *Real-Time Collision Detection* §5.1.9. Returns squared distance
/// and the closest point on each segment.
pub fn closest_pt_seg_seg(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3) -> (f64, Vec3, Vec3) {
    let d1 = sub(q1, p1);
    let d2v = sub(q2, p2);
    let r = sub(p1, p2);
    let a = dot(d1, d1);
    let e = dot(d2v, d2v);
    let f = dot(d2v, r);

    let s;
    let mut t;

    if a <= EPS && e <= EPS {
        s = 0.0;
        t = 0.0;
    } else if a <= EPS {
        s = 0.0;
        t = clamp(f / e, 0.0, 1.0);
    } else {
        let c = dot(d1, r);
        if e <= EPS {
            t = 0.0;
            s = clamp(-c / a, 0.0, 1.0);
        } else {
            let b = dot(d1, d2v);
            let denom = a * e - b * b;
            s = if denom != 0.0 {
                clamp((b * f - c * e) / denom, 0.0, 1.0)
            } else {
                0.0
            };
            t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                // s recomputed below — shadow the outer binding.
                let s2 = clamp(-c / a, 0.0, 1.0);
                let c1 = add(p1, scale(d1, s2));
                let c2 = add(p2, scale(d2v, t));
                return (dist_sq(c1, c2), c1, c2);
            } else if t > 1.0 {
                t = 1.0;
                let s2 = clamp((b - c) / a, 0.0, 1.0);
                let c1 = add(p1, scale(d1, s2));
                let c2 = add(p2, scale(d2v, t));
                return (dist_sq(c1, c2), c1, c2);
            }
        }
    }

    let c1 = add(p1, scale(d1, s));
    let c2 = add(p2, scale(d2v, t));
    (dist_sq(c1, c2), c1, c2)
}

/// Closest point on triangle `(a, b, c)` to point `p`.
///
/// Ericson, *Real-Time Collision Detection* §5.1.5.
pub fn closest_pt_point_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }

    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return add(a, scale(ab, v));
    }

    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return add(a, scale(ac, w));
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return add(b, scale(sub(c, b), w));
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    add(a, add(scale(ab, v), scale(ac, w)))
}

/// Minimum distance between two triangles, with the closest point on each.
///
/// Correct for **disjoint** triangles; intersecting triangles must be detected
/// separately with [`tri_tri_intersect`]. Returns `(dist, pA, pB)`.
pub fn tri_tri_distance(
    a0: Vec3,
    a1: Vec3,
    a2: Vec3,
    b0: Vec3,
    b1: Vec3,
    b2: Vec3,
) -> (f64, Vec3, Vec3) {
    let ea = [(a0, a1), (a1, a2), (a2, a0)];
    let eb = [(b0, b1), (b1, b2), (b2, b0)];

    let mut best = f64::INFINITY;
    let mut p_a: Vec3 = a0;
    let mut p_b: Vec3 = b0;

    for &(s0, s1) in &ea {
        for &(t0, t1) in &eb {
            let (d2, c1, c2) = closest_pt_seg_seg(s0, s1, t0, t1);
            if d2 < best {
                best = d2;
                p_a = c1;
                p_b = c2;
            }
        }
    }

    for &v in &[a0, a1, a2] {
        let c = closest_pt_point_triangle(v, b0, b1, b2);
        let d2 = dist_sq(v, c);
        if d2 < best {
            best = d2;
            p_a = v;
            p_b = c;
        }
    }

    for &v in &[b0, b1, b2] {
        let c = closest_pt_point_triangle(v, a0, a1, a2);
        let d2 = dist_sq(v, c);
        if d2 < best {
            best = d2;
            p_a = c;
            p_b = v;
        }
    }

    (best.sqrt(), p_a, p_b)
}
