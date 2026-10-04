// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared `[f64; 2]` plane primitives: signed ring area, point-in-polygon,
//! line/segment intersection and exact orientation.
//!
//! These lived as private copies inside `space_dcel` (area, point-in-polygon,
//! line intersection, perpendicular distance) and `terrain_cdt` (exact
//! orientation and the closed segment-intersection test). The scan outline
//! tracer (#6871) needs the same set, so they moved here verbatim instead of
//! being copied a third time; both original callers import them from here.
//!
//! The exact `orientation` is also the one `cdt` and `contour_grid_guard`
//! use.
//!
//! Distinct from `bool2d`'s `compute_signed_area` / `point_in_contour`, which
//! take nalgebra `Point2` contours on the IFC profile path.

/// Below this |cross| two lines are treated as parallel (the `space_dcel`
/// tolerance the function was written against).
const PARALLEL_EPS: f64 = 1e-9;

/// Intersection of the two infinite lines through `a1→b1` and `a2→b2`.
/// `None` when (near-)parallel.
pub(crate) fn line_intersection(a1: [f64; 2], b1: [f64; 2], a2: [f64; 2], b2: [f64; 2]) -> Option<[f64; 2]> {
    let d1 = [b1[0] - a1[0], b1[1] - a1[1]];
    let d2 = [b2[0] - a2[0], b2[1] - a2[1]];
    let denom = d1[0] * d2[1] - d1[1] * d2[0];
    if denom.abs() < PARALLEL_EPS {
        return None;
    }
    let t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / denom;
    Some([a1[0] + t * d1[0], a1[1] + t * d1[1]])
}

/// Signed shoelace area: positive for a counter-clockwise ring.
pub(crate) fn polygon_area(pts: &[[f64; 2]]) -> f64 {
    if pts.len() < 3 {
        return 0.0;
    }
    let mut acc = 0.0;
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        acc += p[0] * q[1] - q[0] * p[1];
    }
    acc * 0.5
}

/// Ray-cast point-in-polygon for an arbitrary simple ring.
pub(crate) fn point_in_polygon(p: [f64; 2], poly: &[[f64; 2]]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Perpendicular distance of point `p` to the infinite line through `a` and `b`
/// (degenerates to the point distance when `a == b`).
pub(crate) fn perp_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < PARALLEL_EPS {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
}

/// Exact orientation of `c` against the directed line `a→b` (Shewchuk's
/// adaptive predicate): `1` left, `-1` right, `0` exactly collinear.
#[inline]
pub(crate) fn orientation(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> i32 {
    let value = geometry_predicates::orient2d(a, b, c);
    if value > 0.0 {
        1
    } else if value < 0.0 {
        -1
    } else {
        0
    }
}

/// `point` lies on the closed segment `a–b` (exactly collinear and inside its box).
pub(crate) fn on_segment(a: [f64; 2], b: [f64; 2], point: [f64; 2]) -> bool {
    orientation(a, b, point) == 0
        && (a[0] <= point[0] && point[0] <= b[0] || b[0] <= point[0] && point[0] <= a[0])
        && (a[1] <= point[1] && point[1] <= b[1] || b[1] <= point[1] && point[1] <= a[1])
}

/// Closed segment intersection with exact predicates: proper crossings,
/// T-touches, shared endpoints and collinear overlaps all count.
pub(crate) fn segments_intersect(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let ab_c = orientation(a, b, c);
    let ab_d = orientation(a, b, d);
    let cd_a = orientation(c, d, a);
    let cd_b = orientation(c, d, b);
    (ab_c != ab_d && ab_c != 0 && ab_d != 0 && cd_a != cd_b && cd_a != 0 && cd_b != 0)
        || ab_c == 0 && on_segment(a, b, c)
        || ab_d == 0 && on_segment(a, b, d)
        || cd_a == 0 && on_segment(c, d, a)
        || cd_b == 0 && on_segment(c, d, b)
}
