// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::arrangement::segment_intersection_param;
use super::EPS;

/// Intersection of the two infinite lines through `a1→b1` and `a2→b2`.
/// `None` when (near-)parallel.
pub(super) fn line_intersection(a1: [f64; 2], b1: [f64; 2], a2: [f64; 2], b2: [f64; 2]) -> Option<[f64; 2]> {
    let d1 = [b1[0] - a1[0], b1[1] - a1[1]];
    let d2 = [b2[0] - a2[0], b2[1] - a2[1]];
    let denom = d1[0] * d2[1] - d1[1] * d2[0];
    if denom.abs() < EPS {
        return None;
    }
    let t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / denom;
    Some([a1[0] + t * d1[0], a1[1] + t * d1[1]])
}

pub(super) fn polygon_area(pts: &[[f64; 2]]) -> f64 {
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

/// Ray-cast point-in-polygon for a wall rectangle (4 corners). A face centroid
/// inside any wall rect = a wall interior / junction overlap, not a room gap.
pub(super) fn point_in_quad(p: [f64; 2], quad: &[[f64; 2]; 4]) -> bool {
    let mut inside = false;
    let mut j = 3;
    for i in 0..4 {
        let (xi, yi) = (quad[i][0], quad[i][1]);
        let (xj, yj) = (quad[j][0], quad[j][1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Perpendicular distance of point `p` to the infinite line through `a` and `b`
/// (degenerates to the point distance when `a == b`). Used to judge whether a
/// degree-2 node is a redundant collinear point on its neighbours' chord.
pub(super) fn perp_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < EPS {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
}

/// Cheap self-intersection screen for edit feedback: O(n²) edge-pair test on a
/// single face boundary (faces are small). Not a robustness guarantee.
pub(super) fn is_simple_polygon(pts: &[[f64; 2]]) -> bool {
    let n = pts.len();
    if n < 4 {
        return n == 3;
    }
    for i in 0..n {
        let a1 = pts[i];
        let a2 = pts[(i + 1) % n];
        for j in (i + 1)..n {
            // Skip shared-endpoint neighbours.
            if j == i || (i + 1) % n == j || (j + 1) % n == i {
                continue;
            }
            let b1 = pts[j];
            let b2 = pts[(j + 1) % n];
            if segment_intersection_param(a1, a2, b1, b2).is_some() {
                return false;
            }
        }
    }
    true
}
