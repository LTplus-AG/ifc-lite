// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plane vectors and ring primitives over `[f64; 2]`: the one home for the
//! 2D kit that `geom2d`, `bool2d`, `scan_outline`, the triangulator, the
//! export plates and the processing PDF/scan code each used to carry a copy
//! of (#7773). Every function is FMA-free with the op order written out; see
//! the [module conventions](super).
//!
//! Rings are *implicitly closed* (edge `i` runs `ring[i] -> ring[(i + 1) % n]`).
//! The `_by` forms take an index accessor instead of a slice so a flat
//! `[x0, y0, x1, y1, ..]` buffer, a nalgebra `Point2` contour or a half-edge
//! cycle run through the very same loop without being copied first.
//!
//! The exact (Shewchuk) predicates live in [`geom2d`](super::geom2d); nothing
//! here is adaptive.

/// A plane point or vector.
pub type P2 = [f64; 2];

#[inline]
pub fn add(a: P2, b: P2) -> P2 {
    [a[0] + b[0], a[1] + b[1]]
}

#[inline]
pub fn sub(a: P2, b: P2) -> P2 {
    [a[0] - b[0], a[1] - b[1]]
}

#[inline]
pub fn scale(a: P2, s: f64) -> P2 {
    [a[0] * s, a[1] * s]
}

/// `a0*b0 + a1*b1`, never fused.
#[inline]
pub fn dot(a: P2, b: P2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

/// The z component of the 3D cross product: `a0*b1 - a1*b0`, never fused.
#[inline]
pub fn cross(a: P2, b: P2) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

/// Euclidean length, `dot(a, a).sqrt()`.
#[inline]
pub fn norm(a: P2) -> f64 {
    dot(a, a).sqrt()
}

/// Distance via `hypot` (no intermediate overflow).
#[inline]
pub fn dist(a: P2, b: P2) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// Squared distance, `dx*dx + dy*dy`.
#[inline]
pub fn dist2(a: P2, b: P2) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

/// Twice the signed shoelace area of the closed ring `at(0..n)`: positive for
/// counter-clockwise. No degenerate guard (`n < 3` sums to zero or the
/// caller's own NaN); [`polygon_area`] adds it.
#[inline]
pub fn shoelace2_by(n: usize, at: impl Fn(usize) -> P2) -> f64 {
    shoelace2_edges((0..n).map(|i| (at(i), at((i + 1) % n))))
}

/// [`shoelace2_by`] over explicit directed edges `(from, to)`, for a cycle
/// that is not stored as a vertex array (a half-edge loop).
#[inline]
pub fn shoelace2_edges(edges: impl IntoIterator<Item = (P2, P2)>) -> f64 {
    let mut acc = 0.0;
    for (p, q) in edges {
        acc += p[0] * q[1] - q[0] * p[1];
    }
    acc
}

/// Area centroid of a ring whose signed area is `area` (non-zero): the
/// `(p + q) * cross` moment sum over six times the area. Non-finite when the
/// area is zero; the caller screens that.
pub fn area_centroid(poly: &[P2], area: f64) -> P2 {
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..poly.len() {
        let p = poly[i];
        let q = poly[(i + 1) % poly.len()];
        let cross = p[0] * q[1] - q[0] * p[1];
        cx += (p[0] + q[0]) * cross;
        cy += (p[1] + q[1]) * cross;
    }
    [cx / (6.0 * area), cy / (6.0 * area)]
}

/// Signed shoelace area of the closed ring `at(0..n)`; `0` below three
/// vertices. Non-finite coordinates propagate as NaN.
#[inline]
pub fn signed_area_by(n: usize, at: impl Fn(usize) -> P2) -> f64 {
    if n < 3 {
        return 0.0;
    }
    shoelace2_by(n, at) * 0.5
}

/// Signed shoelace area: positive for a counter-clockwise ring, `0` below
/// three vertices.
pub fn polygon_area(pts: &[P2]) -> f64 {
    signed_area_by(pts.len(), |i| pts[i])
}

/// Even-odd ray cast of `p` against the closed ring `at(0..n)`; `false` below
/// three vertices. A point on the boundary is decided by the half-open
/// crossing rule (an edge counts when exactly one endpoint is above `p.y` and
/// `p.x` is strictly left of the crossing), and a NaN comparison never counts
/// as a crossing.
#[inline]
pub fn point_in_ring_by(p: P2, n: usize, at: impl Fn(usize) -> P2) -> bool {
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (pi, pj) = (at(i), at(j));
        let (xi, yi) = (pi[0], pi[1]);
        let (xj, yj) = (pj[0], pj[1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Ray-cast point-in-polygon for an arbitrary simple ring.
pub fn point_in_polygon(p: P2, poly: &[P2]) -> bool {
    point_in_ring_by(p, poly.len(), |i| poly[i])
}

/// Bounding box `[min_x, min_y, max_x, max_y]` of `points`; the empty set
/// gives `[+INF, +INF, -INF, -INF]`. `f64::min`/`max` skip NaN, so a NaN
/// coordinate never poisons the box.
pub fn bbox(points: impl IntoIterator<Item = P2>) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in points {
        b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
    }
    b
}

/// Distance from `p` to the closed segment `a-b` (the point distance when
/// the segment is a point).
pub fn point_segment_distance(p: P2, a: P2, b: P2) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let q = [p[0] - a[0], p[1] - a[1]];
    let n = d[0] * d[0] + d[1] * d[1];
    let t = if n == 0. {
        0.
    } else {
        ((q[0] * d[0] + q[1] * d[1]) / n).clamp(0., 1.)
    };
    (q[0] - t * d[0]).hypot(q[1] - t * d[1])
}
