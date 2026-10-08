// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::arrangement::segment_intersection_param;
use super::EPS;

// Shared plane primitives, moved to `crate::geom2d` (#6871) and re-exported
// so the sibling modules keep importing them from here.
pub(super) use crate::geom2d::{line_intersection, perp_distance, point_in_polygon, polygon_area};

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

/// A point that is genuinely INSIDE `poly`.
///
/// Callers classify a whole face by testing one point of it, which is only
/// sound if the point lies in the face. A centroid does not: for a concave
/// ring it sits in the notch, so an L-shaped corridor gets classified by a
/// point in the room next door, and a room with a stub wall in it by a point
/// inside that stub. Both then read as "wall interior" and the room is lost.
///
/// The area centroid is still tried first — it is exact for every convex ring
/// and cheap. Otherwise scan horizontal lines drawn BETWEEN adjacent vertex
/// heights, where no vertex can lie on the line and the crossings therefore
/// alternate outside/inside cleanly, and take the middle of the widest
/// interior span. That span is maximally far from the ring, so the answer does
/// not hinge on a tolerance.
pub(super) fn representative_point(poly: &[[f64; 2]]) -> Option<[f64; 2]> {
    if poly.len() < 3 {
        return None;
    }
    let area = polygon_area(poly);
    if area.abs() > EPS {
        let (mut cx, mut cy) = (0.0, 0.0);
        for i in 0..poly.len() {
            let p = poly[i];
            let q = poly[(i + 1) % poly.len()];
            let cross = p[0] * q[1] - q[0] * p[1];
            cx += (p[0] + q[0]) * cross;
            cy += (p[1] + q[1]) * cross;
        }
        let c = [cx / (6.0 * area), cy / (6.0 * area)];
        if c[0].is_finite() && c[1].is_finite() && point_in_polygon(c, poly) {
            return Some(c);
        }
    }
    let mut ys: Vec<f64> = poly.iter().map(|p| p[1]).collect();
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let mut best: Option<([f64; 2], f64)> = None;
    for w in ys.windows(2) {
        if w[1] - w[0] < EPS {
            continue;
        }
        let y = 0.5 * (w[0] + w[1]);
        let mut xs: Vec<f64> = Vec::new();
        for i in 0..poly.len() {
            let p = poly[i];
            let q = poly[(i + 1) % poly.len()];
            if (p[1] > y) != (q[1] > y) {
                xs.push(p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < xs.len() {
            let width = xs[k + 1] - xs[k];
            if best.is_none_or(|(_, b)| width > b) {
                best = Some(([0.5 * (xs[k] + xs[k + 1]), y], width));
            }
            k += 2;
        }
    }
    best.map(|(p, _)| p)
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
