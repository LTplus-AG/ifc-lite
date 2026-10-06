// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Floors and ceilings: which side of each horizontal plane is solid, and
//! the elevations wall and column ends snap to.
//!
//! A horizontal plane is a floor when the walls touching it stand on it and
//! a ceiling when they end under it: each vertical face whose plan footprint
//! reaches the plane's outline (within `levelSnapMetres`) and whose bottom
//! (or top) lies within half of `levelSnapMetres` of the plane votes with
//! its area. With no vote, a scanner-facing normal decides (down: a
//! ceiling); otherwise the plane is a floor when it lies below the interior
//! point.
use super::frame::{Face, V3};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Floor,
    Ceiling,
}

#[derive(Debug, Clone)]
pub(crate) struct Level {
    /// Index into the face list.
    pub face: usize,
    pub role: Role,
    pub z: f64,
}

/// Whether plan point `xy` lies within `margin` of the face's plan outline
/// (a convex quad; either winding).
pub(crate) fn plan_contains(face: &Face, xy: [f64; 2], margin: f64) -> bool {
    let c = face.corners.map(|p| [p[0], p[1]]);
    let mut twice_area = 0.;
    for i in 0..4 {
        let (a, b) = (c[i], c[(i + 1) % 4]);
        twice_area += a[0] * b[1] - b[0] * a[1];
    }
    let winding = if twice_area < 0. { -1. } else { 1. };
    (0..4).all(|i| {
        let (a, b) = (c[i], c[(i + 1) % 4]);
        let edge = [b[0] - a[0], b[1] - a[1]];
        let length = edge[0].hypot(edge[1]);
        if length < 1e-12 {
            return true;
        }
        // Positive inside for a counter-clockwise quad.
        let inside = winding * (edge[0] * (xy[1] - a[1]) - edge[1] * (xy[0] - a[0])) / length;
        inside >= -margin
    })
}

/// Plan points along a vertical face's base: both ends and the middle.
pub(crate) fn footprint(face: &Face) -> [[f64; 2]; 3] {
    let mut corners = face.corners;
    corners.sort_by(|a, b| a[2].total_cmp(&b[2]));
    let (a, b) = ([corners[0][0], corners[0][1]], [corners[1][0], corners[1][1]]);
    [a, b, [(a[0] + b[0]) / 2., (a[1] + b[1]) / 2.]]
}

pub(crate) fn classify(faces: &[Face], horizontal: &[usize], vertical: &[usize], interior: V3, snap: f64) -> Vec<Level> {
    let touch = snap / 2.;
    horizontal
        .iter()
        .map(|&h| {
            let face = &faces[h];
            let z = face.centroid[2];
            let (mut floor, mut ceiling) = (0., 0.);
            for &v in vertical {
                let wall = &faces[v];
                if !footprint(wall).iter().any(|&p| plan_contains(face, p, snap)) {
                    continue;
                }
                let (bottom, top) = wall.z_range();
                if (bottom - z).abs() <= touch {
                    floor += wall.area;
                }
                if (top - z).abs() <= touch {
                    ceiling += wall.area;
                }
            }
            let role = if floor > ceiling {
                Role::Floor
            } else if ceiling > floor {
                Role::Ceiling
            } else if face.scanner_facing {
                if face.normal[2] < 0. { Role::Ceiling } else { Role::Floor }
            } else if z <= interior[2] {
                Role::Floor
            } else {
                Role::Ceiling
            };
            Level { face: h, role, z }
        })
        .collect()
}

/// The nearest level of `role` within `snap` of `z` whose outline covers
/// `xy` (within `margin`), or `z` itself.
pub(crate) fn snap_to(levels: &[Level], faces: &[Face], role: Role, xy: [f64; 2], z: f64, snap: f64, margin: f64) -> f64 {
    levels
        .iter()
        .filter(|l| l.role == role && (l.z - z).abs() <= snap && plan_contains(&faces[l.face], xy, margin))
        .min_by(|a, b| (a.z - z).abs().total_cmp(&(b.z - z).abs()))
        .map_or(z, |l| l.z)
}
