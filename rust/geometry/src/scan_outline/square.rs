// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Square near-orthogonal edges against the dominant building direction.
//!
//! The dominant direction is the peak of a length-weighted histogram of edge
//! directions folded mod 90°, refined by the circular mean (of 4θ) of the
//! edges near the peak. An edge within the angle tolerance of that direction
//! or its perpendicular, or whose ends would move no more than the offset
//! tolerance, is turned about its midpoint onto it; vertices then move to
//! where consecutive lines meet. When two squared neighbours end up parallel
//! but offset (a jog the simplifier collapsed), the shorter keeps its line.

use super::fit::{edge_line, intersect, Line};
use super::ScanOutlineOptions;
use std::f64::consts::{FRAC_PI_2, PI};

/// Histogram resolution over the 90° fold.
const BINS: usize = 180;
/// Half-width (bins) of the circular smoothing window.
const SMOOTH: usize = 2;
/// Edges within this of the peak refine it.
const REFINE_WINDOW_RAD: f64 = 5.0 * PI / 180.0;
/// The offset criterion squares edges up to this multiple of the angle
/// tolerance, never a genuine diagonal.
const OFFSET_ANGLE_FACTOR: f64 = 4.0;

pub(super) struct Squared {
    pub rings: Vec<Vec<[f64; 2]>>,
    pub dominant_angle_deg: Option<f64>,
    pub squared_edges: usize,
}

pub(super) fn square_rings(rings: &[Vec<[f64; 2]>], cell: f64, opts: &ScanOutlineOptions) -> Squared {
    let Some(dominant) = dominant_direction(rings, 2.0 * cell) else {
        return Squared { rings: rings.to_vec(), dominant_angle_deg: None, squared_edges: 0 };
    };
    let tol = opts.square_angle_tolerance_deg.to_radians();
    let mut squared_edges = 0usize;
    let mut out = Vec::with_capacity(rings.len());
    for ring in rings {
        let n = ring.len();
        let mut lines: Vec<Line> = Vec::with_capacity(n);
        let mut squared = vec![false; n];
        for k in 0..n {
            let (a, b) = (ring[k], ring[(k + 1) % n]);
            let line = edge_line(a, b);
            let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            let angle = line.dir[1].atan2(line.dir[0]);
            let dev = fold_quarter(angle - dominant);
            let end_offset = 0.5 * len * dev.abs().sin();
            let qualifies = dev.abs() <= tol
                || (dev.abs() <= OFFSET_ANGLE_FACTOR * tol && end_offset <= opts.square_offset_tolerance);
            if qualifies && len > 0.0 {
                let target = angle - dev;
                lines.push(Line { point: line.point, dir: [target.cos(), target.sin()] });
                squared[k] = true;
            } else {
                lines.push(line);
            }
        }
        // Parallel-but-offset squared neighbours: release the shorter edge.
        // Bounded: each pass releases at least one edge or stops.
        for _ in 0..n {
            let mut released = false;
            for k in 0..n {
                let j = (k + 1) % n;
                if !(squared[k] && squared[j]) {
                    continue;
                }
                let (l0, l1) = (lines[k], lines[j]);
                let sine = (l0.dir[0] * l1.dir[1] - l0.dir[1] * l1.dir[0]).abs();
                let offset = ((l1.point[0] - l0.point[0]) * l0.dir[1] - (l1.point[1] - l0.point[1]) * l0.dir[0]).abs();
                if sine < 1e-9 && offset > 1e-6 {
                    let len = |e: usize| {
                        let (a, b) = (ring[e], ring[(e + 1) % n]);
                        (b[0] - a[0]).hypot(b[1] - a[1])
                    };
                    let shorter = if len(k) <= len(j) { k } else { j };
                    squared[shorter] = false;
                    lines[shorter] = edge_line(ring[shorter], ring[(shorter + 1) % n]);
                    released = true;
                }
            }
            if !released {
                break;
            }
        }
        squared_edges += squared.iter().filter(|&&s| s).count();
        out.push((0..n).map(|k| intersect(lines[(k + n - 1) % n], lines[k], ring[k])).collect());
    }
    let deg = dominant.to_degrees().rem_euclid(90.0);
    Squared { rings: out, dominant_angle_deg: Some(deg), squared_edges }
}

/// Signed difference folded into `[-45°, 45°)`.
fn fold_quarter(a: f64) -> f64 {
    (a + PI / 4.0).rem_euclid(FRAC_PI_2) - PI / 4.0
}

/// Dominant direction in `[0, π/2)` radians from edges at least `min_len`
/// long, or `None` when there are none.
pub(super) fn dominant_direction(rings: &[Vec<[f64; 2]>], min_len: f64) -> Option<f64> {
    let mut edges: Vec<(f64, f64)> = Vec::new(); // (angle mod 90°, length)
    let mut hist = [0.0f64; BINS];
    for ring in rings {
        let n = ring.len();
        for k in 0..n {
            let (a, b) = (ring[k], ring[(k + 1) % n]);
            let len = (b[0] - a[0]).hypot(b[1] - a[1]);
            if len < min_len || !len.is_finite() {
                continue;
            }
            let ang = (b[1] - a[1]).atan2(b[0] - a[0]).rem_euclid(FRAC_PI_2);
            let bin = ((ang / FRAC_PI_2) * BINS as f64).floor() as usize % BINS;
            hist[bin] += len;
            edges.push((ang, len));
        }
    }
    if edges.is_empty() {
        return None;
    }
    let mut best = (0.0f64, 0usize);
    for b in 0..BINS {
        let mut s = 0.0;
        for o in 0..=2 * SMOOTH {
            s += hist[(b + BINS + o - SMOOTH) % BINS];
        }
        if s > best.0 {
            best = (s, b);
        }
    }
    let peak = (best.1 as f64 + 0.5) / BINS as f64 * FRAC_PI_2;
    // Circular mean of 4θ over the edges near the peak.
    let (mut sx, mut sy) = (0.0, 0.0);
    for (ang, len) in &edges {
        if fold_quarter(ang - peak).abs() <= REFINE_WINDOW_RAD {
            sx += len * (4.0 * ang).cos();
            sy += len * (4.0 * ang).sin();
        }
    }
    let mean = if sx == 0.0 && sy == 0.0 { peak } else { sy.atan2(sx) / 4.0 };
    Some(mean.rem_euclid(FRAC_PI_2))
}
