// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Scenes of the cylinder acceptance table (#6870): the review matrix that
//! guards every threshold in `scan_segmentation::cylinder`. Uniform density
//! (no scanner falloff), one feature per scene, in the full 6 x 4 x 2.7 m room
//! (`Size::Full`) or in a compact room: the floor and the walls behind the
//! feature within about a metre (the ceiling too where the feature hangs from
//! it), for the asserted table (`Size::Compact`).
#![allow(dead_code)]

use std::f64::consts::{FRAC_PI_2, PI, TAU};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn uniform(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1_u64 << 53) as f64
    }
    fn gaussian(&mut self) -> f64 {
        let a = self.uniform().max(1e-300);
        let b = self.uniform();
        (-2. * a.ln()).sqrt() * (TAU * b).cos()
    }
}

/// A scene under construction: seeded, 4,000 points per m^2, isotropic noise.
pub struct Scene {
    rng: Rng,
    pub points: Vec<f32>,
    density: f64,
    sigma: f64,
}

/// Plan angle difference in 0..=pi.
pub fn angle_between(a: f64, b: f64) -> f64 {
    ((a - b + PI).rem_euclid(TAU) - PI).abs()
}

/// The scanner of every scene, in plan.
pub const SCANNER: [f64; 2] = [3.5, 1.2];
/// The column position of the column scenes.
pub const COLUMN: [f64; 2] = [2., 2.5];

/// A wall of a box room: the low or high x or y side.
#[derive(Clone, Copy, Debug)]
pub enum Wall {
    XLo,
    XHi,
    YLo,
    YHi,
}

/// Full review room, or the compact room around the feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Size {
    Full,
    Compact,
}

impl Scene {
    /// The room of `size`: the full room, or over the plan box `lo..hi`
    /// around the feature only the floor, the `walls` beside it and, when
    /// asked, the ceiling.
    fn room_of(&mut self, size: Size, lo: [f64; 2], hi: [f64; 2], inside: &dyn Fn(f64, f64) -> bool, ceiling: bool, walls: &[Wall]) {
        match size {
            Size::Full => self.room(inside),
            Size::Compact => self.room_part(lo, hi, inside, ceiling, walls),
        }
    }
}

/// The compact rooms' walls: the two sides away from the scanner.
const BEHIND: [Wall; 2] = [Wall::XLo, Wall::YHi];

/// Plan box of the compact column rooms around `COLUMN`.
const COLUMN_BOX: ([f64; 2], [f64; 2]) = ([1., 1.5], [3., 3.5]);

pub fn facing_scanner(c: [f64; 2]) -> f64 {
    (SCANNER[1] - c[1]).atan2(SCANNER[0] - c[0])
}

impl Scene {
    pub fn new(seed: u64, sigma: f64) -> Self {
        Self { rng: Rng(seed), points: Vec::new(), density: 4_000., sigma }
    }
    fn push(&mut self, p: [f64; 3]) {
        for v in p {
            let noisy = v + self.sigma * self.rng.gaussian();
            self.points.push(noisy as f32);
        }
    }
    /// Parallelogram `o + s u + t v`, keeping points where `keep` holds.
    pub fn patch(&mut self, o: [f64; 3], u: [f64; 3], v: [f64; 3], keep: &dyn Fn([f64; 3]) -> bool) {
        let length = |w: [f64; 3]| (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
        for _ in 0..(length(u) * length(v) * self.density) as usize {
            let (s, t) = (self.rng.uniform(), self.rng.uniform());
            let p = std::array::from_fn(|k| o[k] + s * u[k] + t * v[k]);
            if keep(p) {
                self.push(p);
            }
        }
    }
    /// Room 6 x 4 x 2.7: walls, floor and ceiling, the last two without the
    /// plan footprint `inside`.
    pub fn room(&mut self, inside: &dyn Fn(f64, f64) -> bool) {
        self.room_box([0., 0.], [6., 4.], inside);
    }
    /// A 2.7 m tall box room over the plan rectangle `lo..hi`.
    pub fn room_box(&mut self, lo: [f64; 2], hi: [f64; 2], inside: &dyn Fn(f64, f64) -> bool) {
        self.room_part(lo, hi, inside, true, &[Wall::XLo, Wall::XHi, Wall::YLo, Wall::YHi]);
    }
    /// Part of a 2.7 m tall room over `lo..hi`: the floor, the ceiling when
    /// asked, and the listed walls.
    pub fn room_part(&mut self, lo: [f64; 2], hi: [f64; 2], inside: &dyn Fn(f64, f64) -> bool, ceiling: bool, walls: &[Wall]) {
        let (w, d) = (hi[0] - lo[0], hi[1] - lo[1]);
        self.patch([lo[0], lo[1], 0.], [w, 0., 0.], [0., d, 0.], &|p| !inside(p[0], p[1]));
        if ceiling {
            self.patch([lo[0], lo[1], 2.7], [w, 0., 0.], [0., d, 0.], &|p| !inside(p[0], p[1]));
        }
        let all = |_: [f64; 3]| true;
        for wall in walls {
            match wall {
                Wall::XLo => self.patch([lo[0], lo[1], 0.], [0., d, 0.], [0., 0., 2.7], &all),
                Wall::XHi => self.patch([hi[0], lo[1], 0.], [0., d, 0.], [0., 0., 2.7], &all),
                Wall::YLo => self.patch([lo[0], lo[1], 0.], [w, 0., 0.], [0., 0., 2.7], &all),
                Wall::YHi => self.patch([lo[0], hi[1], 0.], [w, 0., 0.], [0., 0., 2.7], &all),
            }
        }
    }
    /// Vertical column at `c` with radius `profile(angle)` from `z0` to `z1`,
    /// sampled where `keep(angle, z)` holds.
    pub fn column(&mut self, c: [f64; 2], profile: &dyn Fn(f64) -> f64, z0: f64, z1: f64, keep: &dyn Fn(f64, f64) -> bool) {
        for _ in 0..(TAU * profile(0.) * (z1 - z0) * self.density) as usize {
            let (a, z) = (self.rng.uniform() * TAU, z0 + (z1 - z0) * self.rng.uniform());
            if keep(a, z) {
                let r = profile(a);
                self.push([c[0] + r * a.cos(), c[1] + r * a.sin(), z]);
            }
        }
    }
    /// Horizontal pipe along x at (`y`, `z`), angle 0 toward +y, sampled
    /// where `keep(angle)` holds.
    pub fn x_pipe(&mut self, y: f64, z: f64, r: f64, x0: f64, x1: f64, keep: &dyn Fn(f64) -> bool) {
        for _ in 0..(TAU * r * (x1 - x0) * self.density) as usize {
            let (a, x) = (self.rng.uniform() * TAU, x0 + (x1 - x0) * self.rng.uniform());
            if keep(a) {
                self.push([x, y + r * a.cos(), z + r * a.sin()]);
            }
        }
    }
}

/// Expected cylinder: axis through `point` along `axis`, radius.
#[derive(Clone, Copy, Debug)]
pub struct Truth {
    pub point: [f64; 3],
    pub axis: [f64; 3],
    pub radius: f64,
}

/// A real-surface scene and its truth.
pub fn half_column(size: Size, seed: u64, sigma: f64, radius: f64) -> (Vec<f32>, Truth) {
    let c = COLUMN;
    let front = facing_scanner(c);
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, COLUMN_BOX.0, COLUMN_BOX.1, &|x, y| (x - c[0]).hypot(y - c[1]) < radius, false, &BEHIND);
    s.column(c, &|_| radius, 0., 2.7, &|a, _| angle_between(a, front) < FRAC_PI_2);
    (s.points, Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius })
}

pub fn full_column(size: Size, seed: u64, sigma: f64, radius: f64) -> (Vec<f32>, Truth) {
    let c = COLUMN;
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, COLUMN_BOX.0, COLUMN_BOX.1, &|x, y| (x - c[0]).hypot(y - c[1]) < radius, false, &BEHIND);
    s.column(c, &|_| radius, 0., 2.7, &|_, _| true);
    (s.points, Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius })
}

/// Half-visible elliptical column 0.3 x 0.27 m (an out-of-round column).
pub fn half_ellipse(size: Size, seed: u64, sigma: f64) -> (Vec<f32>, Truth) {
    let c = COLUMN;
    let front = facing_scanner(c);
    let ellipse = |a: f64| {
        let (p, q) = (0.3, 0.27);
        p * q / ((q * a.cos()).powi(2) + (p * a.sin()).powi(2)).sqrt()
    };
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, COLUMN_BOX.0, COLUMN_BOX.1, &|x, y| (x - c[0]).hypot(y - c[1]) < 0.3, false, &BEHIND);
    s.column(c, &ellipse, 0., 2.7, &|a, _| angle_between(a, front) < FRAC_PI_2);
    (s.points, Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius: 0.285 })
}

/// Half-visible r 0.3 column with a conduit (r 0.025) strapped 1 cm off its
/// face and a 0.3 x 0.4 m sign 3 cm in front of it.
pub fn strapped_column(size: Size, seed: u64, sigma: f64) -> (Vec<f32>, Truth) {
    let c = COLUMN;
    let front = facing_scanner(c);
    let half = |a: f64, _: f64| angle_between(a, front) < FRAC_PI_2;
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, COLUMN_BOX.0, COLUMN_BOX.1, &|x, y| (x - c[0]).hypot(y - c[1]) < 0.3, false, &BEHIND);
    s.column(c, &|_| 0.3, 0., 2.7, &half);
    let conduit = [c[0] + 0.335 * front.cos(), c[1] + 0.335 * front.sin()];
    s.column(conduit, &|_| 0.025, 0., 2.7, &half);
    let (n, t) = ([front.cos(), front.sin()], [-front.sin(), front.cos()]);
    let o = [c[0] + 0.33 * n[0] - 0.15 * t[0], c[1] + 0.33 * n[1] - 0.15 * t[1], 1.4];
    s.patch(o, [0.3 * t[0], 0.3 * t[1], 0.], [0., 0., 0.4], &|_| true);
    (s.points, Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius: 0.3 })
}

/// Column r 0.3: half visible above `z`, only `low` degrees below it.
pub fn occluded_column(size: Size, seed: u64, sigma: f64, z: f64, low: f64) -> (Vec<f32>, Truth) {
    let c = COLUMN;
    let front = facing_scanner(c);
    let h = low.to_radians() / 2.;
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, COLUMN_BOX.0, COLUMN_BOX.1, &|x, y| (x - c[0]).hypot(y - c[1]) < 0.3, false, &BEHIND);
    s.column(c, &|_| 0.3, 0., 2.7, &|a, zz| {
        if zz > z { angle_between(a, front) < FRAC_PI_2 } else { angle_between(a, front + FRAC_PI_2 - h) < h }
    });
    (s.points, Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius: 0.3 })
}

/// Pipe along x (1..5) at y 2, z 1.3; `half` keeps the -y-facing half only.
/// Compact: the pipe is 1.5 m long (1..2.5) in a 3 x 2 m room.
pub fn x_pipe(size: Size, seed: u64, sigma: f64, radius: f64, half: bool) -> (Vec<f32>, Truth) {
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, [0.5, 1.], [3., 3.], &|_, _| false, false, &BEHIND);
    let end = if size == Size::Full { 5. } else { 2.5 };
    s.x_pipe(2., 1.3, radius, 1., end, &|a| !half || angle_between(a, PI) < FRAC_PI_2);
    (s.points, Truth { point: [1., 2., 1.3], axis: [1., 0., 0.], radius })
}

/// Ceiling pipe r 0.1 along x at y 3.5, z 2.55, seen at grazing angles from a
/// scanner at (3.5, 1.2, 1.5): back faces are missing, and density falls with
/// incidence and with the square of distance.
/// Compact: 3 m of the pipe (x 2..5) nearest the scanner, under the ceiling
/// and beside the wall at y 4 of a room from x 1.5 to 5.5 and y 2.5 to 4. At
/// a 5 cm voxel r 0.1 is the two-voxel minimum radius, so the fit needs the
/// length.
pub fn grazing_ceiling_pipe(size: Size, seed: u64, sigma: f64) -> (Vec<f32>, Truth) {
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, [1.5, 2.5], [5.5, 4.], &|_, _| false, true, &[Wall::YHi]);
    let scanner = [3.5, 1.2, 1.5];
    let r = 0.1;
    let (x0, run) = if size == Size::Full { (0.25, 5.5) } else { (2., 3.) };
    for _ in 0..(TAU * r * run * 4_000.) as usize {
        let a = s.rng.uniform() * TAU;
        let x = x0 + run * s.rng.uniform();
        let p = [x, 3.5 + r * a.cos(), 2.55 + r * a.sin()];
        let to = [scanner[0] - p[0], scanner[1] - p[1], scanner[2] - p[2]];
        let d = (to[0] * to[0] + to[1] * to[1] + to[2] * to[2]).sqrt();
        let incidence = (a.cos() * to[1] + a.sin() * to[2]) / d;
        if incidence <= 0. || s.rng.uniform() > incidence * (2.5 / d).powi(2).min(1.) {
            continue;
        }
        s.push(p);
    }
    (s.points, Truth { point: [x0, 3.5, 2.55], axis: [1., 0., 0.], radius: r })
}

/// Decoy: two vertical flat strips `width` wide, 1.3 m tall, meeting at
/// (3, 2) with `opening` degrees between them.
pub fn facet_pair(size: Size, seed: u64, sigma: f64, opening: f64, width: f64) -> Vec<f32> {
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, [2., 1.], [4., 3.], &|_, _| false, false, &BEHIND);
    let half = (opening / 2.).to_radians();
    for sign in [-1., 1.] {
        let d = [half.cos(), sign * half.sin()];
        s.patch([3., 2., 0.5], [width * d[0], width * d[1], 0.], [0., 0., 1.3], &|_| true);
    }
    s.points
}

/// Decoy: three 0.1 m strips turning 45 degrees each (a chamfered pier).
pub fn three_facets(size: Size, seed: u64, sigma: f64) -> Vec<f32> {
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, [2., 1.], [4., 3.], &|_, _| false, false, &BEHIND);
    let mut p = [3., 2.];
    for k in 0..3 {
        let a = (k as f64 * 45_f64).to_radians();
        let d = [a.cos() * 0.1, a.sin() * 0.1];
        s.patch([p[0], p[1], 0.5], [d[0], d[1], 0.], [0., 0., 1.3], &|_| true);
        p = [p[0] + d[0], p[1] + d[1]];
    }
    s.points
}

/// Decoy: a 0.14 m 45 degree chamfer across the room corner, floor to ceiling.
pub fn corner_chamfer(size: Size, seed: u64, sigma: f64) -> Vec<f32> {
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, [0., 0.], [2., 2.], &|_, _| false, false, &[Wall::XLo, Wall::YLo]);
    s.patch([0.1, 0., 0.], [-0.1, 0.1, 0.], [0., 0., 2.7], &|_| true);
    s.points
}

/// A column r 0.3 (0..1.2 m) on which stands a coaxial r `upper` column
/// (1.4..2.7 m): two cylinders, not one.
pub fn plinth(size: Size, seed: u64, sigma: f64, upper: f64) -> (Vec<f32>, [Truth; 2]) {
    let c = COLUMN;
    let front = facing_scanner(c);
    let half = |a: f64, _: f64| angle_between(a, front) < FRAC_PI_2;
    let mut s = Scene::new(seed, sigma);
    s.room_of(size, COLUMN_BOX.0, COLUMN_BOX.1, &|x, y| (x - c[0]).hypot(y - c[1]) < 0.3, false, &BEHIND);
    s.column(c, &|_| 0.3, 0., 1.2, &half);
    s.column(c, &|_| upper, 1.4, 2.7, &half);
    let truth = |radius| Truth { point: [c[0], c[1], 0.], axis: [0., 0., 1.], radius };
    (s.points, [truth(0.3), truth(upper)])
}

/// Full pipe r 0.1 along x (1..5) at y 2, z 1.3; with `panel`, a scanned
/// horizontal sheet (x 0.5..5.5, y 1.6..2.4) runs through its axis.
/// Compact: 2 m of pipe in a 3 x 2 m room.
pub fn pierced_pipe(seed: u64, sigma: f64, panel: bool) -> (Vec<f32>, Truth) {
    let mut s = Scene::new(seed, sigma);
    s.room_part([0.5, 1.], [3.5, 3.], &|_, _| false, false, &BEHIND);
    s.x_pipe(2., 1.3, 0.1, 1., 3., &|_| true);
    if panel {
        s.patch([0.7, 1.6, 1.3], [2.6, 0., 0.], [0., 0.8, 0.], &|_| true);
    }
    (s.points, Truth { point: [1., 2., 1.3], axis: [1., 0., 0.], radius: 0.1 })
}
