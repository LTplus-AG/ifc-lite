// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! In-plane axes of a plane's oriented box.
//!
//! Vertical and sloped planes use the up axis: `v` is up (or the fall line of
//! a slope) and `u` horizontal, which is how walls and ramps are measured.
//! Horizontal planes have no such direction, so they get the minimum-area
//! rectangle of their projected voxel means (rotating calipers over the convex
//! hull): PCA axes would turn a square room's box by an arbitrary angle.
use super::normals::{canonical_sign, cross, dot, sub, unit, Vec3};
use super::refit::plane_basis;

type P2 = [f64; 2];

fn turn(o: P2, a: P2, b: P2) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Andrew's monotone chain; counter-clockwise, collinear points dropped.
fn convex_hull(mut points: Vec<P2>) -> Vec<P2> {
    points.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    points.dedup();
    if points.len() < 3 {
        return points;
    }
    let mut hull: Vec<P2> = Vec::with_capacity(2 * points.len());
    for pass in 0..2 {
        let start = hull.len();
        let iter: Box<dyn Iterator<Item = &P2>> =
            if pass == 0 { Box::new(points.iter()) } else { Box::new(points.iter().rev()) };
        for &p in iter {
            while hull.len() >= start + 2 && turn(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0. {
                hull.pop();
            }
            hull.push(p);
        }
        hull.pop();
    }
    hull
}

/// Unit direction (in the 2D frame) of the minimum-area enclosing rectangle's
/// first side; the hull edges are the only candidates.
fn min_area_direction(hull: &[P2]) -> P2 {
    let mut best = ([1., 0.], f64::INFINITY);
    for i in 0..hull.len() {
        let (a, b) = (hull[i], hull[(i + 1) % hull.len()]);
        let length = (b[0] - a[0]).hypot(b[1] - a[1]);
        if length <= 0. {
            continue;
        }
        let e = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for p in hull {
            let (s, t) = (p[0] * e[0] + p[1] * e[1], -p[0] * e[1] + p[1] * e[0]);
            lo = [lo[0].min(s), lo[1].min(t)];
            hi = [hi[0].max(s), hi[1].max(t)];
        }
        let area = (hi[0] - lo[0]) * (hi[1] - lo[1]);
        if area < best.1 {
            best = (e, area);
        }
    }
    best.0
}

/// (u, v) with u x v = normal.
pub(crate) fn axes(normal: Vec3, horizontal: bool, up: Vec3, members: impl Iterator<Item = Vec3>) -> (Vec3, Vec3) {
    if !horizontal {
        if let Some(v) = unit(sub(up, normal.map(|x| x * dot(up, normal)))) {
            return (cross(v, normal), v);
        }
    }
    let (u0, v0) = plane_basis(normal);
    let hull = convex_hull(members.map(|d| [dot(d, u0), dot(d, v0)]).collect());
    let e = min_area_direction(&hull);
    let u = canonical_sign(std::array::from_fn(|k| u0[k] * e[0] + v0[k] * e[1]));
    (u, cross(normal, u))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_6870_min_area_rectangle_follows_a_rotated_square() {
        let angle = 0.3_f64;
        let (c, s) = (angle.cos(), angle.sin());
        let square: Vec<P2> = (0..=20)
            .flat_map(|i| (0..=20).map(move |j| (i as f64 / 20., j as f64 / 20.)))
            .map(|(x, y)| [c * x - s * y, s * x + c * y])
            .collect();
        let hull = convex_hull(square);
        assert!(hull.len() >= 4 && hull.len() < 80, "boundary only: {}", hull.len());
        let e = min_area_direction(&hull);
        // Either side of the square: the direction is 0.3 rad modulo 90 degrees.
        let folded = e[1].atan2(e[0]).rem_euclid(std::f64::consts::FRAC_PI_2);
        assert!((folded - angle).abs() < 1e-9, "{folded}");
    }
}
