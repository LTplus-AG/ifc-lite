// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic, seeded synthetic scans for scan segmentation tests (#6870).
//!
//! Two box rooms side by side (Z up, metres), sharing a 0.2 m partition with a
//! door through it:
//!
//! - room A: x 0..6, y 0..4, ceiling 2.7; a door in its south wall
//!   (x 1..1.9, z 0..2.1) and a window in its north wall (x 2..3.5,
//!   z 0.9..2.1); a round column r 0.3 at (4.5, 2.5); a free-standing panel
//!   sloped 15 degrees about the y axis (x 2.5..4, y 0.6..2.1, z 0.3 rising).
//! - room B: x 6.2..10, y 0..4, ceiling 3.0; a round column r 0.15 at (8, 2).
//! - the partition (faces x = 6 and x = 6.2) has a door at y 2.5..3.4,
//!   z 0..2.1, and the floor runs through it, so both rooms share one floor.
//!
//! Opening reveals are not sampled (scan shadow). Points carry isotropic
//! Gaussian noise; a share of outliers is spread uniformly over the bounding
//! box; density falls off with distance to the nearest scanner, giving the
//! uneven density of a real station scan.
#![allow(dead_code)]

/// SplitMix64: tiny, seedable, and identical on every platform.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1_u64 << 53) as f64
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.uniform()
    }
    /// Standard normal by Box-Muller (one value per call; deterministic).
    pub fn gaussian(&mut self) -> f64 {
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        (-2. * u1.ln()).sqrt() * (2. * std::f64::consts::PI * u2).cos()
    }
    /// Fisher-Yates shuffle of whole xyz triples.
    pub fn shuffle_points(&mut self, positions: &mut [f32]) {
        let n = positions.len() / 3;
        for i in (1..n).rev() {
            let j = (self.next_u64() % (i as u64 + 1)) as usize;
            for a in 0..3 {
                positions.swap(i * 3 + a, j * 3 + a);
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Kind {
    Horizontal,
    Vertical,
    Sloped,
}

/// A planar surface the scan was sampled from, with its inward unit normal
/// (pointing into the room it belongs to), `normal . x + d = 0`.
#[derive(Clone, Debug)]
pub struct ExpectedPlane {
    pub name: &'static str,
    pub normal: [f64; 3],
    pub d: f64,
    /// Centre of the sampled surface's bounding rectangle.
    pub center: [f64; 3],
    /// Sampled area in m^2 (openings and column footprints removed).
    pub area: f64,
    /// In-plane extent: (horizontal or first axis length, second axis length).
    pub extent: (f64, f64),
    pub kind: Kind,
    /// Whether the room-A scanner sees the inward side (false for room B).
    pub in_room_a: bool,
}

/// A sampled cylinder surface: axis from `start` to `end`.
#[derive(Clone, Debug)]
pub struct ExpectedCylinder {
    pub start: [f64; 3],
    pub end: [f64; 3],
    pub radius: f64,
}

impl ExpectedCylinder {
    pub fn vertical(center: [f64; 2], radius: f64, z: (f64, f64)) -> Self {
        Self { start: [center[0], center[1], z.0], end: [center[0], center[1], z.1], radius }
    }
    /// Plan position of a vertical cylinder's axis.
    pub fn center(&self) -> [f64; 2] {
        [self.start[0], self.start[1]]
    }
}

pub struct ScanSpec {
    pub seed: u64,
    /// Points per m^2 next to a scanner; falls to `density_floor` of that far away.
    pub density: f64,
    pub density_floor: f64,
    pub noise_sigma: f64,
    pub outlier_fraction: f64,
}

impl Default for ScanSpec {
    fn default() -> Self {
        Self { seed: 6870, density: 4_000., density_floor: 0.35, noise_sigma: 0.003, outlier_fraction: 0.01 }
    }
}

pub struct SyntheticScan {
    pub positions: Vec<f32>,
    pub planes: Vec<ExpectedPlane>,
    pub columns: Vec<ExpectedCylinder>,
    /// Room A's station; room B has its own at (8.1, 1, 1.5).
    pub scanner: [f64; 3],
}

const SCANNERS: [[f64; 3]; 2] = [[3., 2., 1.5], [8.1, 1., 1.5]];

struct Sampler<'a> {
    rng: Rng,
    spec: &'a ScanSpec,
    out: Vec<f32>,
}

impl Sampler<'_> {
    /// Uniformly sample the parallelogram `origin + s*u + t*v` (s, t in 0..1),
    /// thinned by scanner distance and by `keep(s_metres, t_metres)`.
    fn patch(&mut self, origin: [f64; 3], u: [f64; 3], v: [f64; 3], keep: &dyn Fn(f64, f64) -> bool) {
        let (lu, lv) = (norm(u), norm(v));
        let count = (lu * lv * self.spec.density).round() as usize;
        for _ in 0..count {
            let (s, t) = (self.rng.uniform(), self.rng.uniform());
            let p: [f64; 3] = std::array::from_fn(|a| origin[a] + s * u[a] + t * v[a]);
            let accept = self.rng.uniform();
            if !keep(s * lu, t * lv) || accept > self.density_at(p) {
                continue;
            }
            self.push(p);
        }
    }
    /// Lateral surface of a cylinder, over `arc` radians of its circumference
    /// starting at angle 0 (the first in-plane axis).
    fn cylinder(&mut self, c: &ExpectedCylinder, arc: f64) {
        let axis = sub(c.end, c.start);
        let length = norm(axis);
        let a = axis.map(|v| v / length);
        let helper = if a[2].abs() < 0.9 { [0., 0., 1.] } else { [1., 0., 0.] };
        let u = unit(cross(helper, a));
        let v = cross(a, u);
        let area = arc * c.radius * length;
        for _ in 0..(area * self.spec.density).round() as usize {
            let (angle, t) = (self.rng.range(0., arc), self.rng.range(0., length));
            let p: [f64; 3] = std::array::from_fn(|k| {
                c.start[k] + t * a[k] + c.radius * (angle.cos() * u[k] + angle.sin() * v[k])
            });
            if self.rng.uniform() <= self.density_at(p) {
                self.push(p);
            }
        }
    }
    /// Sphere surface between latitudes `-band` and `band` (radians); pi/2 is
    /// the whole sphere.
    fn sphere(&mut self, center: [f64; 3], radius: f64, band: f64) {
        let (lo, hi) = (-band.sin(), band.sin());
        let area = 2. * std::f64::consts::PI * radius * radius * (hi - lo);
        for _ in 0..(area * self.spec.density).round() as usize {
            let z = self.rng.range(lo, hi);
            let angle = self.rng.range(0., 2. * std::f64::consts::PI);
            let r = (1. - z * z).sqrt();
            let p = [center[0] + radius * r * angle.cos(), center[1] + radius * r * angle.sin(), center[2] + radius * z];
            if self.rng.uniform() <= self.density_at(p) {
                self.push(p);
            }
        }
    }
    fn density_at(&self, p: [f64; 3]) -> f64 {
        let d = SCANNERS.iter().map(|s| norm(sub(p, *s))).fold(f64::INFINITY, f64::min);
        let floor = self.spec.density_floor;
        floor + (1. - floor) * (-d / 2.5).exp()
    }
    fn push(&mut self, p: [f64; 3]) {
        let sigma = self.spec.noise_sigma;
        for value in p {
            self.out.push((value + sigma * self.rng.gaussian()) as f32);
        }
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
fn norm(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    a.map(|v| v / n)
}

pub fn two_rooms(spec: &ScanSpec) -> SyntheticScan {
    let columns = vec![
        ExpectedCylinder::vertical([4.5, 2.5], 0.3, (0., 2.7)),
        ExpectedCylinder::vertical([8., 2.], 0.15, (0., 3.)),
    ];
    let mut s = Sampler { rng: Rng::new(spec.seed), spec, out: Vec::new() };
    let outside_columns = |x: f64, y: f64| {
        columns.iter().all(|c| (x - c.center()[0]).hypot(y - c.center()[1]) > c.radius)
    };
    let rect = |s0: f64, s1: f64, t0: f64, t1: f64| move |a: f64, b: f64| !(a > s0 && a < s1 && b > t0 && b < t1);
    // Floor across both rooms and the partition doorway (y 2.5..3.4 at x 6..6.2).
    s.patch([0., 0., 0.], [10., 0., 0.], [0., 4., 0.], &|x, y| {
        let in_partition = x > 6. && x < 6.2;
        (!in_partition || (y > 2.5 && y < 3.4)) && outside_columns(x, y)
    });
    s.patch([0., 0., 2.7], [6., 0., 0.], [0., 4., 0.], &|x, y| outside_columns(x, y));
    s.patch([6.2, 0., 3.], [3.8, 0., 0.], [0., 4., 0.], &|x, y| outside_columns(x + 6.2, y));
    // Room A walls.
    s.patch([0., 0., 0.], [0., 4., 0.], [0., 0., 2.7], &|_, _| true);
    s.patch([0., 0., 0.], [6., 0., 0.], [0., 0., 2.7], &rect(1., 1.9, -1., 2.1));
    s.patch([0., 4., 0.], [6., 0., 0.], [0., 0., 2.7], &rect(2., 3.5, 0.9, 2.1));
    s.patch([6., 0., 0.], [0., 4., 0.], [0., 0., 2.7], &rect(2.5, 3.4, -1., 2.1));
    // Room B walls.
    s.patch([6.2, 0., 0.], [0., 4., 0.], [0., 0., 3.], &rect(2.5, 3.4, -1., 2.1));
    s.patch([10., 0., 0.], [0., 4., 0.], [0., 0., 3.], &|_, _| true);
    s.patch([6.2, 0., 0.], [3.8, 0., 0.], [0., 0., 3.], &|_, _| true);
    s.patch([6.2, 4., 0.], [3.8, 0., 0.], [0., 0., 3.], &|_, _| true);
    // Sloped panel: 15 degrees about y, top face only.
    let slope = 15_f64.to_radians();
    let run = 1.5;
    s.patch([2.5, 0.6, 0.3], [run, 0., run * slope.tan()], [0., 1.5, 0.], &|_, _| true);
    for c in &columns {
        s.cylinder(c, 2. * std::f64::consts::PI);
    }
    // Outliers over the whole bounding box.
    let outliers = (s.out.len() as f64 / 3. * spec.outlier_fraction).round() as usize;
    for _ in 0..outliers {
        let p = [s.rng.range(-0.5, 10.5), s.rng.range(-0.5, 4.5), s.rng.range(-0.2, 3.2)];
        s.out.extend(p.map(|v| v as f32));
    }

    let column_area = |r: f64| std::f64::consts::PI * r * r;
    let (ca, cb) = (column_area(0.3), column_area(0.15));
    let (sn, cs) = (slope.sin(), slope.cos());
    let plane = |name, normal: [f64; 3], center: [f64; 3], area, extent, kind, in_room_a| {
        let d = -(normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2]);
        ExpectedPlane { name, normal, d, center, area, extent, kind, in_room_a }
    };
    let planes = vec![
        plane("floor", [0., 0., 1.], [5., 2., 0.], 40. - 0.2 * 4. + 0.9 * 0.2 - ca - cb, (10., 4.), Kind::Horizontal, true),
        plane("ceiling A", [0., 0., -1.], [3., 2., 2.7], 24. - ca, (6., 4.), Kind::Horizontal, true),
        plane("ceiling B", [0., 0., -1.], [8.1, 2., 3.], 15.2 - cb, (3.8, 4.), Kind::Horizontal, false),
        plane("wall A west", [1., 0., 0.], [0., 2., 1.35], 4. * 2.7, (4., 2.7), Kind::Vertical, true),
        plane("wall A south", [0., 1., 0.], [3., 0., 1.35], 6. * 2.7 - 0.9 * 2.1, (6., 2.7), Kind::Vertical, true),
        plane("wall A north", [0., -1., 0.], [3., 4., 1.35], 6. * 2.7 - 1.5 * 1.2, (6., 2.7), Kind::Vertical, true),
        plane("wall A east", [-1., 0., 0.], [6., 2., 1.35], 4. * 2.7 - 0.9 * 2.1, (4., 2.7), Kind::Vertical, true),
        plane("wall B west", [1., 0., 0.], [6.2, 2., 1.5], 4. * 3. - 0.9 * 2.1, (4., 3.), Kind::Vertical, false),
        plane("wall B east", [-1., 0., 0.], [10., 2., 1.5], 4. * 3., (4., 3.), Kind::Vertical, false),
        plane("wall B south", [0., 1., 0.], [8.1, 0., 1.5], 3.8 * 3., (3.8, 3.), Kind::Vertical, false),
        plane("wall B north", [0., -1., 0.], [8.1, 4., 1.5], 3.8 * 3., (3.8, 3.), Kind::Vertical, false),
        plane("sloped panel", [-sn, 0., cs], [3.25, 1.35, 0.3 + 0.75 * slope.tan()], 1.5 / cs * 1.5, (1.5 / cs, 1.5), Kind::Sloped, true),
    ];
    SyntheticScan { positions: s.out, planes, columns, scanner: SCANNERS[0] }
}

/// Uniform random points in a cube: no planar structure at all.
pub fn pure_noise(seed: u64, points: usize, side: f64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    (0..points * 3).map(|_| rng.range(0., side) as f32).collect()
}

/// One 4 x 2.7 m wall (y = 0, facing +y) with a horizontal band of missing
/// points at z 1.2..1.27 (a scan shadow): wide enough to leave a whole 3 cm
/// voxel layer empty even with noise, so region growing cannot cross it and the wall grows as two regions
/// that must merge into one plane.
pub fn banded_wall(spec: &ScanSpec) -> Vec<f32> {
    let mut s = Sampler { rng: Rng::new(spec.seed), spec, out: Vec::new() };
    s.patch([0., 0., 0.], [4., 0., 0.], [0., 0., 2.7], &|_, z| !(1.2..=1.27).contains(&z));
    s.out
}

/// `positions` moved by `offset` metres (computed in f64, stored as f32 like a
/// georeferenced scan decoded without a decode origin).
pub fn shifted(positions: &[f32], offset: [f64; 3]) -> Vec<f32> {
    positions.chunks_exact(3).flat_map(|p| [0, 1, 2].map(|a| (f64::from(p[a]) + offset[a]) as f32)).collect()
}

/// One room (x 0..6, y 0..4, z 0..2.7, no openings) holding the cylinder
/// cases of #6870. Two are real and must be found:
/// - a column r 0.3 at (4.5, 2.5), floor to ceiling;
/// - a horizontal pipe r 0.08 along x (1..4) at y 3.2, z 2.2.
///
/// Four are decoys that must be refused:
/// - a whole sphere r 0.25 at (0.8, 2.6, 0.8): no cylinder fits 60 % of it;
/// - an equatorial band of a sphere r 0.8 at (2, 1.4, 1.4), latitudes +-12
///   degrees (0.33 m tall, full circumference). A cylinder fits it within
///   2 cm, so only the sphere test refuses it;
/// - a stub r 0.15 on the floor at (3.6, 1), 0.2 m tall (too short);
/// - a 60 degree, r 0.4 curved panel, 2 m tall, around (5.2, 0.8) (too
///   narrow an arc).
pub struct CylinderScene {
    pub positions: Vec<f32>,
    pub cylinders: Vec<ExpectedCylinder>,
    pub scanner: [f64; 3],
}

pub fn cylinder_room(spec: &ScanSpec) -> CylinderScene {
    let column = ExpectedCylinder::vertical([4.5, 2.5], 0.3, (0., 2.7));
    let pipe = ExpectedCylinder { start: [1., 3.2, 2.2], end: [4., 3.2, 2.2], radius: 0.08 };
    let stub = ExpectedCylinder::vertical([3.6, 1.], 0.15, (0., 0.2));
    let panel = ExpectedCylinder::vertical([5.2, 0.8], 0.4, (0.2, 2.2));
    let mut s = Sampler { rng: Rng::new(spec.seed), spec, out: Vec::new() };
    let outside = |x: f64, y: f64| (x - 4.5).hypot(y - 2.5) > 0.3 && (x - 3.6).hypot(y - 1.) > 0.15;
    s.patch([0., 0., 0.], [6., 0., 0.], [0., 4., 0.], &outside);
    s.patch([0., 0., 2.7], [6., 0., 0.], [0., 4., 0.], &|x, y| (x - 4.5).hypot(y - 2.5) > 0.3);
    s.patch([0., 0., 0.], [0., 4., 0.], [0., 0., 2.7], &|_, _| true);
    s.patch([6., 0., 0.], [0., 4., 0.], [0., 0., 2.7], &|_, _| true);
    s.patch([0., 0., 0.], [6., 0., 0.], [0., 0., 2.7], &|_, _| true);
    s.patch([0., 4., 0.], [6., 0., 0.], [0., 0., 2.7], &|_, _| true);
    let full = 2. * std::f64::consts::PI;
    s.cylinder(&column, full);
    s.cylinder(&pipe, full);
    s.cylinder(&stub, full);
    s.cylinder(&panel, 60_f64.to_radians());
    s.sphere([0.8, 2.6, 0.8], 0.25, std::f64::consts::FRAC_PI_2);
    s.sphere([2., 1.4, 1.4], 0.8, 12_f64.to_radians());
    let outliers = (s.out.len() as f64 / 3. * spec.outlier_fraction).round() as usize;
    for _ in 0..outliers {
        let p = [s.rng.range(0., 6.), s.rng.range(0., 4.), s.rng.range(0., 2.7)];
        s.out.extend(p.map(|v| v as f32));
    }
    CylinderScene { positions: s.out, cylinders: vec![column, pipe], scanner: SCANNERS[0] }
}
