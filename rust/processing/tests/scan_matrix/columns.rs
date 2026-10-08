// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Scenes of the wide, faceted and fine-voxel column rows (#6893), and the
//! walls that must not pass for a column: bays, niches, corners, pilasters,
//! a rectangular column and a staircase core.
//!
//! The feature stands at `CENTRE` and is seen from -y (a scanner far in
//! front): "half" keeps the faces turned toward -y. `Size::Full` is a room
//! with 1.5 m (or more) of floor around the feature, all walls, floor and
//! ceiling; `Size::Compact` keeps the floor and the walls behind the feature
//! (low x, high y) within `reach` of it.
use super::{Scene, Size, Truth, Wall};
use std::f64::consts::{FRAC_PI_2, PI, TAU};

/// Plan position of every feature.
pub const CENTRE: [f64; 2] = [3., 2.];
/// The direction the visible side faces.
const FRONT: f64 = -FRAC_PI_2;
const HEIGHT: f64 = 2.7;

/// A polygonal column's truth: its circumscribed cylinder, face count and the
/// plan angle of one face's outward normal.
#[derive(Clone, Copy, Debug)]
pub struct PrismTruth {
    pub cylinder: Truth,
    pub faces: u32,
    pub face_angle: f64,
}

fn wrap(a: f64) -> f64 {
    (a + PI).rem_euclid(TAU) - PI
}

/// Box room around `CENTRE` reaching `reach` each way (Full: all walls,
/// floor and ceiling; Compact: floor and the two walls behind).
fn room(s: &mut Scene, size: Size, reach: f64, inside: &dyn Fn(f64, f64) -> bool) {
    let lo = [CENTRE[0] - reach, CENTRE[1] - reach];
    let hi = [CENTRE[0] + reach, CENTRE[1] + reach];
    match size {
        Size::Full => s.room_box(lo, hi, inside),
        Size::Compact => s.room_part(lo, hi, inside, false, &[Wall::XLo, Wall::YHi]),
    }
}

/// Vertical faces along a plan polyline, floor to `HEIGHT`.
fn walls(s: &mut Scene, path: &[[f64; 2]]) {
    for w in path.windows(2) {
        s.patch([w[0][0], w[0][1], 0.], [w[1][0] - w[0][0], w[1][1] - w[0][1], 0.], [0., 0., HEIGHT], &|_| true);
    }
}

/// Horizontal surface over the convex plan polygon `poly` at height `z`.
fn slab(s: &mut Scene, poly: &[[f64; 2]], z: f64) {
    let (lo, hi) = poly.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(lo, hi), p| {
        ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])])
    });
    let inside = |p: [f64; 3]| {
        let n = poly.len();
        let sides = (0..n).map(|i| {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        });
        let signs: Vec<f64> = sides.collect();
        signs.iter().all(|v| *v >= 0.) || signs.iter().all(|v| *v <= 0.)
    };
    s.patch([lo[0], lo[1], z], [hi[0] - lo[0], 0., 0.], [0., hi[1] - lo[1], 0.], &inside);
}

/// Round column of radius `r` at `CENTRE`, half (facing -y) or whole.
pub fn wide_column(size: Size, seed: u64, sigma: f64, r: f64, half: bool) -> (Vec<f32>, Truth) {
    wide_column_dense(size, seed, sigma, 4_000., r, half)
}

/// `wide_column` sampled at `density` points per m^2.
pub fn wide_column_dense(size: Size, seed: u64, sigma: f64, density: f64, r: f64, half: bool) -> (Vec<f32>, Truth) {
    let c = CENTRE;
    let mut s = Scene::new_with_density(seed, sigma, density);
    room(&mut s, size, r + if size == Size::Full { 1.5 } else { 0.8 }, &|x, y| (x - c[0]).hypot(y - c[1]) < r);
    s.column(c, &|_| r, 0., HEIGHT, &|a, _| !half || wrap(a - FRONT).abs() < FRAC_PI_2);
    (s.points, Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius: r })
}

/// Regular `n`-gon column of circumradius `r` at `CENTRE`, one corner at
/// plan angle `phi`; half keeps the faces turned toward -y.
pub fn polygon_column(size: Size, seed: u64, sigma: f64, n: usize, r: f64, phi: f64) -> (Vec<f32>, PrismTruth) {
    let c = CENTRE;
    let mut s = Scene::new(seed, sigma);
    let apothem = r * (PI / n as f64).cos();
    let corner = |k: usize| {
        let a = phi + TAU * k as f64 / n as f64;
        [c[0] + r * a.cos(), c[1] + r * a.sin()]
    };
    let inside = |x: f64, y: f64| {
        (0..n).all(|k| {
            let m = phi + TAU * (k as f64 + 0.5) / n as f64;
            (x - c[0]) * m.cos() + (y - c[1]) * m.sin() < apothem
        })
    };
    room(&mut s, size, r + if size == Size::Full { 1.5 } else { 0.8 }, &inside);
    for k in 0..n {
        let normal = phi + TAU * (k as f64 + 0.5) / n as f64;
        if wrap(normal - FRONT).abs() < FRAC_PI_2 {
            walls(&mut s, &[corner(k), corner(k + 1)]);
        }
    }
    let face_angle = phi + PI / n as f64;
    (s.points, PrismTruth { cylinder: Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius: r }, faces: n as u32, face_angle })
}

/// The back wall (y = `CENTRE[1]` + `reach`) with `bump` (plan points from
/// left to right, relative to the wall line's middle; +y is outward)
/// replacing its middle; the floor (and in Full the ceiling) runs into it.
fn wall_with(size: Size, seed: u64, sigma: f64, bump: &[[f64; 2]]) -> Vec<f32> {
    let reach = 1.5;
    let (x0, x1, y) = (CENTRE[0] - reach, CENTRE[0] + reach, CENTRE[1] + reach);
    let mut s = Scene::new(seed, sigma);
    let lo = [x0, CENTRE[1] - reach];
    let hi = [x1, y];
    let others: &[Wall] = if size == Size::Full { &[Wall::XLo, Wall::XHi, Wall::YLo] } else { &[Wall::XLo] };
    s.room_part(lo, hi, &|_, _| false, size == Size::Full, others);
    let mut path = vec![[x0, y]];
    path.extend(bump.iter().map(|p| [CENTRE[0] + p[0], y + p[1]]));
    path.push([x1, y]);
    walls(&mut s, &path);
    // The floor (and ceiling) inside the bump.
    let outline: Vec<[f64; 2]> = bump.iter().map(|p| [CENTRE[0] + p[0], y + p[1]]).collect();
    if outline.iter().any(|p| p[1] > y + 1e-9) {
        slab(&mut s, &outline, 0.);
        if size == Size::Full {
            slab(&mut s, &outline, HEIGHT);
        }
    }
    s.points
}

/// Decoy: a 135 degree bay window of three `width` faces, seen from the room.
pub fn bay_window(size: Size, seed: u64, sigma: f64, width: f64) -> Vec<f32> {
    let d = width / 2_f64.sqrt();
    let half = width / 2.;
    wall_with(size, seed, sigma, &[[-half - d, 0.], [-half, d], [half, d], [half + d, 0.]])
}

/// Decoy: a full-height niche `width` wide and `depth` deep in the back wall.
pub fn niche(size: Size, seed: u64, sigma: f64, width: f64, depth: f64) -> Vec<f32> {
    let h = width / 2.;
    wall_with(size, seed, sigma, &[[-h, 0.], [-h, depth], [h, depth], [h, 0.]])
}

/// Decoy: five faces of an octagon of circumradius `r` bulging out of the
/// back wall, seen from inside (an octagonal tower room).
pub fn polygonal_apse(size: Size, seed: u64, sigma: f64, r: f64) -> Vec<f32> {
    let points: Vec<[f64; 2]> = (0..=5)
        .map(|k| {
            let a = 9. * PI / 8. - k as f64 * PI / 4.;
            [r * a.cos(), r * (a.sin() + (PI / 8.).sin())]
        })
        .collect();
    wall_with(size, seed, sigma, &points)
}

/// Decoy: a half-round apse of radius `r` bulging out of the back wall, seen
/// from inside.
pub fn round_apse(size: Size, seed: u64, sigma: f64, r: f64) -> Vec<f32> {
    let steps = 90;
    let points: Vec<[f64; 2]> = (0..=steps)
        .map(|k| {
            let a = PI - PI * k as f64 / steps as f64;
            [r * a.cos(), r * a.sin()]
        })
        .collect();
    wall_with(size, seed, sigma, &points)
}

/// Decoy: a rectangular pilaster `width` x `depth` standing out of the back
/// wall into the room.
pub fn pilaster(size: Size, seed: u64, sigma: f64, width: f64, depth: f64) -> Vec<f32> {
    let h = width / 2.;
    wall_with(size, seed, sigma, &[[-h, 0.], [-h, -depth], [h, -depth], [h, 0.]])
}

/// Decoy: a pilaster with 45 degree chamfered corners: a `front` face and two
/// `chamfer` faces, standing `depth` out of the back wall.
pub fn chamfered_pilaster(size: Size, seed: u64, sigma: f64, front: f64, chamfer: f64, depth: f64) -> Vec<f32> {
    let (h, c) = (front / 2., chamfer / 2_f64.sqrt());
    wall_with(size, seed, sigma, &[[-h - c, 0.], [-h - c, -depth + c], [-h, -depth], [h, -depth], [h + c, -depth + c], [h + c, 0.]])
}

/// Decoy: free-standing wall pieces in front of the scanner along `path`
/// (plan offsets from `CENTRE`), floor around them: 2.2 m each way in the
/// full room, 0.8 m beyond the pieces in the compact one (the asserted tier
/// pays for every square metre).
fn free_standing(size: Size, seed: u64, sigma: f64, path: &[[f64; 2]], inside: &dyn Fn(f64, f64) -> bool) -> Vec<f32> {
    let mut s = Scene::new(seed, sigma);
    let extent = path.iter().flat_map(|p| p.iter()).fold(0_f64, |m, v| m.max(v.abs()));
    room(&mut s, size, if size == Size::Full { 2.2 } else { extent + 0.8 }, inside);
    let points: Vec<[f64; 2]> = path.iter().map(|p| [CENTRE[0] + p[0], CENTRE[1] + p[1]]).collect();
    walls(&mut s, &points);
    s.points
}

/// Decoy: the outside of an L corner (a wall end turning 90 degrees), 1 m
/// each way.
pub fn l_corner(size: Size, seed: u64, sigma: f64) -> Vec<f32> {
    free_standing(size, seed, sigma, &[[-1., 0.5], [0., -0.5], [1., 0.5]], &|_, _| false)
}

/// Decoy: a 135 degree bay window of three `width` faces seen from outside
/// (a facade scan): the facade runs 1 m on from each side, and the ground
/// stops at the building (nothing is scanned inside the bay).
pub fn bay_from_outside(_size: Size, seed: u64, sigma: f64, width: f64) -> Vec<f32> {
    let (d, h) = (width / 2_f64.sqrt(), width / 2.);
    let mut s = Scene::new(seed, sigma);
    let reach = h + d + 1.;
    let building = move |x: f64, y: f64| {
        let (lx, ly) = (x - CENTRE[0], y - CENTRE[1]);
        ly > d || (ly > 0. && lx.abs() < h + ly)
    };
    s.patch([CENTRE[0] - reach, CENTRE[1] - 2., 0.], [2. * reach, 0., 0.], [0., 2. + d, 0.], &|p| !building(p[0], p[1]));
    let path = [[-reach, d], [-h - d, d], [-h, 0.], [h, 0.], [h + d, d], [reach, d]];
    let points: Vec<[f64; 2]> = path.iter().map(|p| [CENTRE[0] + p[0], CENTRE[1] + p[1]]).collect();
    walls(&mut s, &points);
    s.points
}

/// Decoy: an outside corner with a `chamfer` wide 45 degree chamfer.
pub fn chamfered_corner(size: Size, seed: u64, sigma: f64, chamfer: f64) -> Vec<f32> {
    let c = chamfer / 2.;
    free_standing(size, seed, sigma, &[[-1., 0.5], [-c, -0.5 + c], [c, -0.5 + c], [1., 0.5]], &|_, _| false)
}

/// Decoy: a free-standing rectangular block `a` x `b` (a column, or a
/// staircase core), its front and left faces (`half`, as a scanner in front
/// and to the left sees it) or all four.
pub fn rectangular_column(size: Size, seed: u64, sigma: f64, a: f64, b: f64, half: bool) -> Vec<f32> {
    let (x, y) = (a / 2., b / 2.);
    let inside = move |px: f64, py: f64| (px - CENTRE[0]).abs() < x && (py - CENTRE[1]).abs() < y;
    let path: &[[f64; 2]] = if half { &[[-x, y], [-x, -y], [x, -y]] } else { &[[-x, y], [-x, -y], [x, -y], [x, y], [-x, y]] };
    free_standing(size, seed, sigma, path, &inside)
}
