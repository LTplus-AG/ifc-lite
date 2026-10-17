// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared `[f64; 2]` plane predicates: line/segment intersection and exact
//! orientation. The plain-f64 kit (area, point-in-polygon, distances, bbox)
//! is [`v2`](super::v2).
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
//! `bool2d`'s `compute_signed_area` / `point_in_contour` take nalgebra
//! `Point2` contours and route through the same [`v2`](super::v2) loops.

/// Below this |cross| two lines are treated as parallel (the `space_dcel`
/// tolerance the function was written against).
const PARALLEL_EPS: f64 = 1e-9;

/// Intersection of the two infinite lines through `a1→b1` and `a2→b2`.
/// `None` when (near-)parallel.
pub(crate) fn line_intersection(a1: [f64; 2], b1: [f64; 2], a2: [f64; 2], b2: [f64; 2]) -> Option<[f64; 2]> {
    line_intersection_dir(a1, [b1[0] - a1[0], b1[1] - a1[1]], a2, [b2[0] - a2[0], b2[1] - a2[1]])
}

/// [`line_intersection`] for lines given as point + direction (`None` when
/// the directions are (near-)parallel).
pub(crate) fn line_intersection_dir(a1: [f64; 2], d1: [f64; 2], a2: [f64; 2], d2: [f64; 2]) -> Option<[f64; 2]> {
    let denom = d1[0] * d2[1] - d1[1] * d2[0];
    if denom.abs() < PARALLEL_EPS {
        return None;
    }
    let t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / denom;
    Some([a1[0] + t * d1[0], a1[1] + t * d1[1]])
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

/// Open segments `a-b` and `c-d` cross at a single interior point of both:
/// each segment's endpoints lie strictly on opposite sides of the other.
/// Touches, shared endpoints and collinear overlaps are *not* proper
/// crossings. Exact via [`orientation`].
pub(crate) fn segments_properly_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let (ab_c, ab_d) = (orientation(a, b, c), orientation(a, b, d));
    let (cd_a, cd_b) = (orientation(c, d, a), orientation(c, d, b));
    (ab_c > 0 && ab_d < 0 || ab_c < 0 && ab_d > 0) && (cd_a > 0 && cd_b < 0 || cd_a < 0 && cd_b > 0)
}

/// Closed segment intersection with exact predicates: proper crossings,
/// T-touches, shared endpoints and collinear overlaps all count.
pub(crate) fn segments_intersect(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let ab_c = orientation(a, b, c);
    let ab_d = orientation(a, b, d);
    let cd_a = orientation(c, d, a);
    let cd_b = orientation(c, d, b);
    segments_properly_cross(a, b, c, d)
        || ab_c == 0 && on_segment(a, b, c)
        || ab_d == 0 && on_segment(a, b, d)
        || cd_a == 0 && on_segment(c, d, a)
        || cd_b == 0 && on_segment(c, d, b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::v2::{point_in_polygon, polygon_area};

    /// The closed segment test both the scan outline repair and its test
    /// oracle (`assert_valid`) rely on, pinned on hand cases so a regression
    /// in it cannot hide behind the two agreeing (#6883 review).
    #[test]
    fn segments_intersect_covers_every_contact_kind() {
        let s = |a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]| segments_intersect(a, b, c, d);
        assert!(s([0.0, 0.0], [2.0, 2.0], [0.0, 2.0], [2.0, 0.0]), "proper crossing");
        assert!(s([0.0, 0.0], [2.0, 0.0], [1.0, 0.0], [1.0, 1.0]), "T-touch");
        assert!(s([0.0, 0.0], [1.0, 0.0], [1.0, 0.0], [1.0, 1.0]), "shared endpoint");
        assert!(s([0.0, 0.0], [2.0, 0.0], [1.0, 0.0], [3.0, 0.0]), "collinear overlap");
        assert!(!s([0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]), "collinear, apart");
        assert!(!s([0.0, 0.0], [1.0, 0.0], [0.0, 1e-12], [1.0, 1e-12]), "parallel, 1e-12 apart");
        assert!(!s([0.0, 0.0], [1.0, 1.0], [1.0, 0.0], [2.0, -1.0]), "would cross only when extended");
        // Exactness: a crossing far from the origin with tiny segments.
        let o = 1e7;
        assert!(s([o, o], [o + 1e-6, o + 1e-6], [o, o + 1e-6], [o + 1e-6, o]), "tiny crossing at 1e7");
    }

    #[test]
    fn point_in_polygon_and_area_agree_on_a_square() {
        let sq = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
        assert_eq!(polygon_area(&sq), 4.0);
        assert!(point_in_polygon([1.0, 1.0], &sq));
        assert!(!point_in_polygon([3.0, 1.0], &sq));
    }
}
