// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Lines for the snapping and squaring stages: an edge's own line, a
//! total-least-squares fit of the scan points beside an edge, and the meeting
//! point of two consecutive lines.

use super::grid::PointIndex;
use crate::geom2d::line_intersection;

/// A refit may turn an edge by at most this much; beyond it the points
/// describe something other than this edge (a corner, clutter).
const MAX_FIT_TURN_RAD: f64 = 15.0 * std::f64::consts::PI / 180.0;
/// Lines closer to parallel than this (sine of the angle) are not
/// intersected; the vertex is projected onto them instead.
const PARALLEL_SINE: f64 = 0.035;

/// A line through `point` along unit `dir`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Line {
    pub point: [f64; 2],
    pub dir: [f64; 2],
}

/// The line an edge lies on, anchored at its midpoint.
pub(super) fn edge_line(a: [f64; 2], b: [f64; 2]) -> Line {
    let d = [b[0] - a[0], b[1] - a[1]];
    let len = (d[0] * d[0] + d[1] * d[1]).sqrt().max(1e-300);
    Line { point: [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5], dir: [d[0] / len, d[1] / len] }
}

/// Where `l0` and `l1` meet, or, when they are (near) parallel, `near`
/// projected onto both and averaged.
pub(super) fn intersect(l0: Line, l1: Line, near: [f64; 2]) -> [f64; 2] {
    let sine = (l0.dir[0] * l1.dir[1] - l0.dir[1] * l1.dir[0]).abs();
    if sine >= PARALLEL_SINE {
        let (p0, p1) = (l0.point, l1.point);
        if let Some(p) = line_intersection(p0, [p0[0] + l0.dir[0], p0[1] + l0.dir[1]], p1, [p1[0] + l1.dir[0], p1[1] + l1.dir[1]]) {
            return p;
        }
    }
    let (a, b) = (project(near, l0), project(near, l1));
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
}

fn project(p: [f64; 2], l: Line) -> [f64; 2] {
    let t = (p[0] - l.point[0]) * l.dir[0] + (p[1] - l.point[1]) * l.dir[1];
    [l.point[0] + t * l.dir[0], l.point[1] + t * l.dir[1]]
}

/// Fit the edge `a→b` to the points in a band of half-width `band` beside it.
/// Left of the edge is solid (outer rings run CCW, holes CW), and the surface
/// lies at or just inside the cell boundary, so the band reaches `band`
/// inward and three quarters of it outward. The ends are skipped (the
/// neighbouring surface's points sit there). `None` without enough evidence,
/// or when the fit turns the edge too far or scatters more than the band.
#[allow(clippy::too_many_arguments)]
pub(super) fn fit_edge(
    a: [f64; 2],
    b: [f64; 2],
    index: &PointIndex,
    xy: &[f32],
    band: f64,
    min_points: usize,
    stamp: &mut [u32],
    stamp_id: u32,
) -> Option<Line> {
    let geo = &index.geometry;
    let cell = geo.cell;
    let base = edge_line(a, b);
    let len = dist(a, b);
    let margin = band.max(cell);
    if len <= 2.0 * margin + cell {
        return None;
    }
    let normal = [-base.dir[1], base.dir[0]];
    let mut pts: Vec<[f64; 2]> = Vec::new();
    let reach = (band / cell).ceil() as isize + 1;
    let steps = (len / cell).ceil() as usize + 1;
    for s in 0..=steps {
        let t = (s as f64 / steps as f64) * len;
        let ci = ((a[0] + base.dir[0] * t - geo.x0) / cell).floor() as isize;
        let cj = ((a[1] + base.dir[1] * t - geo.y0) / cell).floor() as isize;
        for dj in -reach..=reach {
            for di in -reach..=reach {
                let (i, j) = (ci + di, cj + dj);
                if i < 0 || j < 0 || i as usize >= geo.width || j as usize >= geo.height {
                    continue;
                }
                let c = j as usize * geo.width + i as usize;
                if stamp[c] == stamp_id {
                    continue;
                }
                stamp[c] = stamp_id;
                for &id in index.cell_points(i, j) {
                    let q = [xy[id as usize * 2] as f64, xy[id as usize * 2 + 1] as f64];
                    let rel = [q[0] - a[0], q[1] - a[1]];
                    let along = rel[0] * base.dir[0] + rel[1] * base.dir[1];
                    let side = rel[0] * normal[0] + rel[1] * normal[1];
                    if along >= margin && along <= len - margin && side >= -band * 0.75 && side <= band {
                        pts.push(q);
                    }
                }
            }
        }
    }
    let first = tls_fit(&pts, min_points)?;
    // One refit on the inliers of the first fit.
    let tol = (2.5 * first.rms).clamp(0.25 * cell, cell);
    let inliers: Vec<[f64; 2]> = pts.iter().copied().filter(|q| line_distance(*q, first.line) <= tol).collect();
    let fit = tls_fit(&inliers, min_points)?;
    let turn = (fit.line.dir[0] * base.dir[1] - fit.line.dir[1] * base.dir[0]).abs().min(1.0).asin();
    if turn > MAX_FIT_TURN_RAD || fit.rms > band {
        return None;
    }
    // Keep the edge's direction sense.
    let dir = if fit.line.dir[0] * base.dir[0] + fit.line.dir[1] * base.dir[1] < 0.0 {
        [-fit.line.dir[0], -fit.line.dir[1]]
    } else {
        fit.line.dir
    };
    Some(Line { point: fit.line.point, dir })
}

/// Where the end face of a thin wall lies: the wall runs along `a` (solid on
/// its left) and back along `b`; among the points between the two lines whose
/// position along `a` falls in `[t_lo, t_hi]` (relative to `a.point`), the
/// 97th percentile of that position. `None` with fewer than `min_points`.
pub(super) fn cap_position(a: Line, b: Line, t_lo: f64, t_hi: f64, index: &PointIndex, xy: &[f32], min_points: usize) -> Option<f64> {
    let geo = &index.geometry;
    let cell = geo.cell;
    let normal = [-a.dir[1], a.dir[0]];
    let width = (b.point[0] - a.point[0]) * normal[0] + (b.point[1] - a.point[1]) * normal[1];
    let (s_lo, s_hi) = (width.min(0.0) - 0.5 * cell, width.max(0.0) + 0.5 * cell);
    let corner = |t: f64, s: f64| [a.point[0] + t * a.dir[0] + s * normal[0], a.point[1] + t * a.dir[1] + s * normal[1]];
    let cs = [corner(t_lo, s_lo), corner(t_lo, s_hi), corner(t_hi, s_lo), corner(t_hi, s_hi)];
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for c in cs {
        lo = [lo[0].min(c[0]), lo[1].min(c[1])];
        hi = [hi[0].max(c[0]), hi[1].max(c[1])];
    }
    let i0 = ((lo[0] - geo.x0) / cell).floor() as isize;
    let i1 = ((hi[0] - geo.x0) / cell).floor() as isize;
    let j0 = ((lo[1] - geo.y0) / cell).floor() as isize;
    let j1 = ((hi[1] - geo.y0) / cell).floor() as isize;
    // The region is a few cells across; bound it anyway.
    if (i1 - i0 + 1) * (j1 - j0 + 1) > 1 << 16 {
        return None;
    }
    let mut along: Vec<f64> = Vec::new();
    for j in j0..=j1 {
        for i in i0..=i1 {
            for &id in index.cell_points(i, j) {
                let q = [xy[id as usize * 2] as f64 - a.point[0], xy[id as usize * 2 + 1] as f64 - a.point[1]];
                let t = q[0] * a.dir[0] + q[1] * a.dir[1];
                let s = q[0] * normal[0] + q[1] * normal[1];
                if t >= t_lo && t <= t_hi && s >= s_lo && s <= s_hi {
                    along.push(t);
                }
            }
        }
    }
    if along.len() < min_points.max(2) {
        return None;
    }
    let k = ((along.len() - 1) as f64 * 0.97).round() as usize;
    Some(*along.select_nth_unstable_by(k, f64::total_cmp).1)
}

struct Fit {
    line: Line,
    rms: f64,
}

/// Total-least-squares line: through the centroid along the principal axis of
/// the 2×2 covariance (closed form).
fn tls_fit(pts: &[[f64; 2]], min_points: usize) -> Option<Fit> {
    if pts.len() < min_points.max(2) {
        return None;
    }
    let n = pts.len() as f64;
    let (mut cx, mut cy) = (0.0, 0.0);
    for p in pts {
        cx += p[0];
        cy += p[1];
    }
    cx /= n;
    cy /= n;
    let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
    for p in pts {
        let (dx, dy) = (p[0] - cx, p[1] - cy);
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    let line = Line { point: [cx, cy], dir: [theta.cos(), theta.sin()] };
    let sq: f64 = pts.iter().map(|p| line_distance(*p, line).powi(2)).sum();
    let rms = (sq / n).sqrt();
    rms.is_finite().then_some(Fit { line, rms })
}

fn line_distance(p: [f64; 2], l: Line) -> f64 {
    ((p[0] - l.point[0]) * l.dir[1] - (p[1] - l.point[1]) * l.dir[0]).abs()
}

#[inline]
fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}
