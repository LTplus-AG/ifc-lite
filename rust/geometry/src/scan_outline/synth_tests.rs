// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic synthetic scan slabs for the outline tests, plus the
//! independent (brute-force) invariant checks they assert.
//!
//! A scene is a union of wall rectangles in a local frame, then rotated and
//! translated. Points are sampled only on the boundary of the union (a scanner
//! sees surfaces, never the inside of a wall or a joint between two walls),
//! with Gaussian noise, plus optional uniform clutter and far outliers.

use super::ScanOutline;
use crate::geom2d::{point_in_polygon, polygon_area, segments_intersect};

/// Seeded splitmix-based generator; portable and dependency-free.
pub(super) struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x5DEE_CE66_D1CE_4E5B)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        crate::geom_hash::mix64(self.0)
    }
    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn gauss(&mut self) -> f64 {
        let u1 = self.unit().max(1e-300);
        let u2 = self.unit();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
}

/// Axis-aligned wall rectangle `[x0, y0, x1, y1]` in the scene's local frame.
pub(super) type Rect = [f64; 4];

#[derive(Clone, Debug)]
pub(super) struct Scene {
    pub rects: Vec<Rect>,
    /// Rotation (radians) then translation applied to the local frame.
    pub angle: f64,
    pub offset: [f64; 2],
}

pub(super) struct SampleSpec {
    /// Points per metre of exposed surface.
    pub per_metre: f64,
    /// Gaussian noise (metres, each axis).
    pub sigma: f64,
    /// Uniform clutter points across the bounding box, as a fraction of the
    /// surface points.
    pub clutter_fraction: f64,
    /// Far outliers placed hundreds of metres away.
    pub far_outliers: usize,
    pub seed: u64,
}

impl Default for SampleSpec {
    fn default() -> Self {
        Self { per_metre: 300.0, sigma: 0.003, clutter_fraction: 0.0, far_outliers: 0, seed: 1 }
    }
}

impl Scene {
    pub fn new(rects: Vec<Rect>) -> Self {
        Self { rects, angle: 0.0, offset: [0.0, 0.0] }
    }

    pub fn placed(mut self, angle_deg: f64, offset: [f64; 2]) -> Self {
        self.angle = angle_deg.to_radians();
        self.offset = offset;
        self
    }

    fn to_world(&self, p: [f64; 2]) -> [f64; 2] {
        let (s, c) = self.angle.sin_cos();
        [c * p[0] - s * p[1] + self.offset[0], s * p[0] + c * p[1] + self.offset[1]]
    }

    fn to_local(&self, p: [f64; 2]) -> [f64; 2] {
        let (s, c) = self.angle.sin_cos();
        let q = [p[0] - self.offset[0], p[1] - self.offset[1]];
        [c * q[0] + s * q[1], -s * q[0] + c * q[1]]
    }

    /// Whether local point `p` is inside the wall union (closed).
    fn solid_local(&self, p: [f64; 2]) -> bool {
        self.rects.iter().any(|r| p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3])
    }

    /// Flat `[x, y, …]` points sampled on the union's boundary.
    pub fn sample(&self, spec: &SampleSpec) -> Vec<f32> {
        let mut rng = Rng::new(spec.seed);
        let mut out: Vec<f32> = Vec::new();
        let mut surface = 0usize;
        for r in &self.rects {
            // Sides as (start, end, outward normal).
            let sides = [
                ([r[0], r[1]], [r[2], r[1]], [0.0, -1.0]),
                ([r[2], r[1]], [r[2], r[3]], [1.0, 0.0]),
                ([r[2], r[3]], [r[0], r[3]], [0.0, 1.0]),
                ([r[0], r[3]], [r[0], r[1]], [-1.0, 0.0]),
            ];
            for (a, b, n) in sides {
                let len = (b[0] - a[0]).hypot(b[1] - a[1]);
                let count = (len * spec.per_metre).round() as usize;
                for _ in 0..count {
                    let t = rng.unit();
                    let p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                    // Exposed only if just outside it is empty.
                    if self.solid_local([p[0] + n[0] * 1e-6, p[1] + n[1] * 1e-6]) {
                        continue;
                    }
                    let q = [p[0] + spec.sigma * rng.gauss(), p[1] + spec.sigma * rng.gauss()];
                    let w = self.to_world(q);
                    out.extend_from_slice(&[w[0] as f32, w[1] as f32]);
                    surface += 1;
                }
            }
        }
        let b = self.local_bounds();
        let clutter = (surface as f64 * spec.clutter_fraction).round() as usize;
        for _ in 0..clutter {
            let p = [b[0] + rng.unit() * (b[2] - b[0]), b[1] + rng.unit() * (b[3] - b[1])];
            let w = self.to_world(p);
            out.extend_from_slice(&[w[0] as f32, w[1] as f32]);
        }
        for k in 0..spec.far_outliers {
            let ang = rng.unit() * std::f64::consts::TAU;
            let w = self.to_world([b[0] + 400.0 * ang.cos() + k as f64, b[1] + 400.0 * ang.sin()]);
            out.extend_from_slice(&[w[0] as f32, w[1] as f32]);
        }
        out
    }

    fn local_bounds(&self) -> [f64; 4] {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for r in &self.rects {
            b = [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[2]), b[3].max(r[3])];
        }
        b
    }

    /// Whether world point `p` is within `tol` of the union's boundary: some
    /// probe on a circle of radius `tol` around it is solid and some is empty.
    pub fn near_boundary(&self, p: [f64; 2], tol: f64) -> bool {
        let q = self.to_local(p);
        let (mut solid, mut empty) = (false, false);
        for k in 0..32 {
            let a = k as f64 * std::f64::consts::TAU / 32.0;
            for r in [tol * 0.5, tol] {
                if self.solid_local([q[0] + r * a.cos(), q[1] + r * a.sin()]) {
                    solid = true;
                } else {
                    empty = true;
                }
            }
        }
        solid && empty
    }
}

/// Room walls of thickness `t` around the interior `[x0, y0, x1, y1]`.
pub(super) fn room_walls(x0: f64, y0: f64, x1: f64, y1: f64, t: f64) -> Vec<Rect> {
    vec![
        [x0 - t, y0 - t, x1 + t, y0],
        [x0 - t, y1, x1 + t, y1 + t],
        [x0 - t, y0, x0, y1],
        [x1, y0, x1 + t, y1],
    ]
}

/// The outline must be closed, simple and pairwise disjoint, wound outer CCW
/// and holes CW, grouped by shape, and nested as `parents` says. Checked by
/// brute force, independently of the module's bucketed validator.
pub(super) fn assert_valid(outline: &ScanOutline) {
    let rings = &outline.rings;
    assert_eq!(outline.parents.len(), rings.len());
    for (r, ring) in rings.iter().enumerate() {
        assert!(ring.len() >= 3, "ring {r} has {} vertices", ring.len());
        assert!(ring.first() != ring.last(), "ring {r} repeats its closing vertex");
        assert!(ring.iter().all(|p| p[0].is_finite() && p[1].is_finite()), "ring {r} non-finite");
        let outer = outline.shape_offsets.contains(&r);
        let area = polygon_area(ring);
        assert!(if outer { area > 0.0 } else { area < 0.0 }, "ring {r} winding (area {area}, outer {outer})");
        if !outer {
            let shape = outline.shape_offsets.iter().rev().find(|&&o| o < r).copied();
            assert_eq!(outline.parents[r], shape, "hole {r} must follow and belong to its outer ring");
        }
    }
    // Every pair of non-adjacent edges is disjoint (touching counts).
    let mut edges = Vec::new();
    for (r, ring) in rings.iter().enumerate() {
        for k in 0..ring.len() {
            edges.push((r, k, ring[k], ring[(k + 1) % ring.len()]));
        }
    }
    for i in 0..edges.len() {
        for j in i + 1..edges.len() {
            let (ri, ki, a, b) = edges[i];
            let (rj, kj, c, d) = edges[j];
            let n = rings[ri].len();
            if ri == rj && ((ki + 1) % n == kj || (kj + 1) % n == ki) {
                continue;
            }
            assert!(!segments_intersect(a, b, c, d), "edges {ri}:{ki} and {rj}:{kj} intersect");
        }
    }
    // Innermost container equals the recorded parent.
    for (r, ring) in rings.iter().enumerate() {
        let probe = ring[0];
        let container = rings
            .iter()
            .enumerate()
            .filter(|(c, other)| *c != r && point_in_polygon(probe, other))
            .min_by(|a, b| polygon_area(a.1).abs().total_cmp(&polygon_area(b.1).abs()))
            .map(|(c, _)| c);
        assert_eq!(container, outline.parents[r], "ring {r} nesting");
    }
}

/// Every vertex lies within `tol` of the scene's true wall surfaces.
pub(super) fn assert_vertices_on_walls(outline: &ScanOutline, scene: &Scene, tol: f64) {
    for (r, ring) in outline.rings.iter().enumerate() {
        for (k, p) in ring.iter().enumerate() {
            assert!(scene.near_boundary(*p, tol), "ring {r} vertex {k} {p:?} is more than {tol} m from any wall surface");
        }
    }
}

/// Every edge at least `min_len` long runs along `angle_deg` or its
/// perpendicular to within `tol_deg`.
pub(super) fn assert_edges_squared(outline: &ScanOutline, angle_deg: f64, min_len: f64, tol_deg: f64) {
    for (r, ring) in outline.rings.iter().enumerate() {
        let n = ring.len();
        for k in 0..n {
            let (a, b) = (ring[k], ring[(k + 1) % n]);
            if (b[0] - a[0]).hypot(b[1] - a[1]) < min_len {
                continue;
            }
            let ang = (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees();
            let dev = (ang - angle_deg + 45.0).rem_euclid(90.0) - 45.0;
            assert!(dev.abs() <= tol_deg, "ring {r} edge {k} deviates {dev}° from {angle_deg}° mod 90");
        }
    }
}
