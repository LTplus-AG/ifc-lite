// SPDX-License-Identifier: MPL-2.0
//! Pure geometry predicates shared across the HBJSON exporter (rooms, openings, shades,
//! adjacency): coordinate conversion, polygon normals/area, ring cleanup, footprint
//! simplicity / watertightness checks. No IFC or Honeybee types — just `[f64; 3]` math.

use std::collections::HashMap;

/// Minimum face area (m²) below which a face — and its room — is treated as degenerate.
const AREA_EPS: f64 = 1.0e-4;

// Thresholds of the HBJSON exporter (F2c, #7774). Everything here is in metres: the
// exporter works on geometry already scaled to metres, so these are physical distances.

/// An opening whose centre is farther than this from a wall's plane is not in that wall.
pub(crate) const OPENING_WALL_MAX_DISTANCE_M: f64 = 0.7;
/// An opening centre may lie this far outside a wall's in-plane extent and still belong
/// to it (reveals and corner openings sit just past the wall's footprint).
pub(crate) const OPENING_WALL_EDGE_MARGIN_M: f64 = 0.5;
/// An aperture is inset this far from the wall's edges, so it never touches the border.
pub(crate) const APERTURE_EDGE_INSET_M: f64 = 0.05;
/// An aperture narrower or shorter than this (after the inset) is dropped.
pub(crate) const APERTURE_MIN_SPAN_M: f64 = 0.1;
/// A shade ring is cleaned of vertices closer than this (0.1 mm).
pub(crate) const SHADE_RING_CLEAN_M: f64 = 1.0e-4;
/// A construction layer is never thinner than this (1 mm), so Honeybee accepts it.
pub(crate) const MIN_LAYER_THICKNESS_M: f64 = 0.001;
/// A polygon segment shorter than this has no direction (1 nm).
const DEGENERATE_SEGMENT_M: f64 = 1e-9;
/// The watertightness vertex-snap grid is never finer than this (1 µm), whatever the
/// caller's tolerance.
const WATERTIGHT_GRID_FLOOR_M: f64 = 1e-6;

/// Convert a WebGL Y-up point/direction to IFC/Honeybee Z-up: `(x, y, z) -> (x, -z, y)`.
pub(crate) fn zup(p: [f64; 3]) -> [f64; 3] {
    [p[0], -p[2], p[1]]
}

/// Transform a 2D profile point by the entity's column-major 4×4, then convert to Z-up.
/// All in f64: the translation is a survey-grid world position (#7684).
pub(crate) fn xf(t: &[f64; 16], px: f64, py: f64) -> [f64; 3] {
    let c = |r: usize, col: usize| t[col * 4 + r];
    zup([
        c(0, 0) * px + c(0, 1) * py + c(0, 3),
        c(1, 0) * px + c(1, 1) * py + c(1, 3),
        c(2, 0) * px + c(2, 1) * py + c(2, 3),
    ])
}

fn dist(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Merge vertices closer than `merge` (Euclidean), including a duplicate closing vertex.
/// `merge` carries a margin above the model tolerance so no kept edge lands in Honeybee's
/// degenerate band (which would collapse to a non-manifold edge).
pub(crate) fn clean_ring(ring: Vec<[f64; 3]>, merge: f64) -> Vec<[f64; 3]> {
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(ring.len());
    for p in ring {
        if out.last().is_none_or(|q| dist(&p, q) > merge) {
            out.push(p);
        }
    }
    if out.len() > 1 && dist(&out[0], out.last().unwrap()) <= merge {
        out.pop();
    }
    out
}

/// Newell's method: raw (area-weighted, un-normalised) polygon normal.
fn newell_raw(b: &[[f64; 3]]) -> [f64; 3] {
    let m = b.len();
    let mut n = [0.0_f64; 3];
    for i in 0..m {
        let c = b[i];
        let d = b[(i + 1) % m];
        n[0] += (c[1] - d[1]) * (c[2] + d[2]);
        n[1] += (c[2] - d[2]) * (c[0] + d[0]);
        n[2] += (c[0] - d[0]) * (c[1] + d[1]);
    }
    n
}

/// Unit polygon normal (zero vector if degenerate).
pub(crate) fn newell_normal(b: &[[f64; 3]]) -> [f64; 3] {
    let n = newell_raw(b);
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 { [n[0] / len, n[1] / len, n[2] / len] } else { [0.0, 0.0, 0.0] }
}

/// Planar polygon area (`|Newell| / 2`).
pub(crate) fn polygon_area(b: &[[f64; 3]]) -> f64 {
    let n = newell_raw(b);
    0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
}

/// Shortest edge length of a closed polygon.
fn min_edge(b: &[[f64; 3]]) -> f64 {
    let m = b.len();
    (0..m)
        .map(|i| {
            let c = b[i];
            let d = b[(i + 1) % m];
            ((c[0] - d[0]).powi(2) + (c[1] - d[1]).powi(2) + (c[2] - d[2]).powi(2)).sqrt()
        })
        .fold(f64::MAX, f64::min)
}

/// Max deviation of any vertex from the polygon's best-fit plane.
fn planarity_dev(b: &[[f64; 3]]) -> f64 {
    let n = newell_normal(b);
    if n == [0.0, 0.0, 0.0] {
        return f64::MAX;
    }
    let p0 = b[0];
    b.iter()
        .map(|p| ((p[0] - p0[0]) * n[0] + (p[1] - p0[1]) * n[1] + (p[2] - p0[2]) * n[2]).abs())
        .fold(0.0, f64::max)
}

/// A face Honeybee will accept: non-sliver, non-degenerate, planar within tolerance.
pub(crate) fn face_ok(b: &[[f64; 3]], tol: f64) -> bool {
    polygon_area(b) >= AREA_EPS && min_edge(b) > tol && planarity_dev(b) <= tol
}

/// 2D cross product (orientation) of `a→b` vs `a→c`.
fn orient2d(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// Proper crossing of segments `p1p2` and `p3p4` (shared endpoints don't count).
fn segments_cross(p1: (f64, f64), p2: (f64, f64), p3: (f64, f64), p4: (f64, f64)) -> bool {
    let d1 = orient2d(p3, p4, p1);
    let d2 = orient2d(p3, p4, p2);
    let d3 = orient2d(p1, p2, p3);
    let d4 = orient2d(p1, p2, p4);
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0)) && d1 != 0.0 && d2 != 0.0 && d3 != 0.0 && d4 != 0.0
}

/// True when edges `a1a2` and `b1b2` are collinear (within `tol`) and overlap by more than
/// `tol` along their shared line — i.e. the polygon doubles back over itself. Works for
/// segments that share an endpoint (a backtracking spike) — the touch point alone is not an
/// overlap, only a genuine doubling-back is.
fn collinear_overlap(a1: (f64, f64), a2: (f64, f64), b1: (f64, f64), b2: (f64, f64), tol: f64) -> bool {
    let dx = a2.0 - a1.0;
    let dy = a2.1 - a1.1;
    let len = (dx * dx + dy * dy).sqrt();
    if len < DEGENERATE_SEGMENT_M {
        return false;
    }
    let dev = tol * len; // |orient2d| ≤ dev ⇔ point within `tol` of the line a1a2
    if orient2d(a1, a2, b1).abs() > dev || orient2d(a1, a2, b2).abs() > dev {
        return false;
    }
    let t = |p: (f64, f64)| ((p.0 - a1.0) * dx + (p.1 - a1.1) * dy) / (len * len);
    let (tb1, tb2) = (t(b1), t(b2));
    let (blo, bhi) = if tb1 <= tb2 { (tb1, tb2) } else { (tb2, tb1) };
    let lo = 0.0_f64.max(blo);
    let hi = 1.0_f64.min(bhi);
    (hi - lo) * len > tol
}

/// True when the footprint ring is a simple polygon — no edge crossing, no vertex pinch
/// (two non-adjacent vertices coinciding), and no backtracking spike (an edge doubling back
/// over its neighbour). All three are topologically watertight once extruded but
/// geometrically invalid, and Honeybee rejects them as "not closed" / not solid.
pub(crate) fn is_simple_polygon(ring: &[[f64; 3]], tol: f64) -> bool {
    let n = newell_normal(ring);
    let (nx, ny, nz) = (n[0].abs(), n[1].abs(), n[2].abs());
    let (ax, ay): (usize, usize) = if nx >= ny && nx >= nz {
        (1, 2)
    } else if ny >= nx && ny >= nz {
        (0, 2)
    } else {
        (0, 1)
    };
    let p: Vec<(f64, f64)> = ring.iter().map(|q| (q[ax], q[ay])).collect();
    let m = p.len();
    if m < 3 {
        return false;
    }
    for i in 0..m {
        // Reject backtracking spikes: the edge INTO vertex i and the edge OUT of it are
        // collinear and overlap past their shared endpoint (the non-adjacent loops below
        // skip this adjacent pair, so it needs its own check).
        let prev = p[(i + m - 1) % m];
        if collinear_overlap(prev, p[i], p[i], p[(i + 1) % m], tol) {
            return false;
        }
        // Reject pinch points: any non-adjacent vertex coinciding with vertex i.
        for j in (i + 1)..m {
            if (j + 1) % m == i || (i + 1) % m == j {
                continue; // adjacent
            }
            if (p[i].0 - p[j].0).abs() <= tol && (p[i].1 - p[j].1).abs() <= tol {
                return false;
            }
        }
        // Reject crossings AND collinear partial overlaps between non-adjacent edges.
        let a1 = p[i];
        let a2 = p[(i + 1) % m];
        for j in (i + 1)..m {
            if (j + 1) % m == i || (i + 1) % m == j {
                continue;
            }
            let (b1, b2) = (p[j], p[(j + 1) % m]);
            if segments_cross(a1, a2, b1, b2) || collinear_overlap(a1, a2, b1, b2, tol) {
                return false;
            }
        }
    }
    true
}

/// True when the faces form a closed 2-manifold: every undirected edge (vertices snapped
/// to a `tol` grid) is shared by exactly two faces. Catches self-intersecting footprints
/// and any other non-watertight prism — the same naked-edge test Honeybee applies.
// The edge-key HashMap type is explicit on purpose; aliasing it would obscure
// the naked-edge bookkeeping.
#[allow(clippy::type_complexity)]
pub(crate) fn is_watertight(faces: &[(Vec<[f64; 3]>, &'static str)], tol: f64) -> bool {
    let grid = tol.max(WATERTIGHT_GRID_FLOOR_M);
    let key = |p: &[f64; 3]| {
        (
            (p[0] / grid).round() as i64,
            (p[1] / grid).round() as i64,
            (p[2] / grid).round() as i64,
        )
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i32> = HashMap::new();
    for (b, _) in faces {
        let m = b.len();
        for i in 0..m {
            let a = key(&b[i]);
            let c = key(&b[(i + 1) % m]);
            if a == c {
                return false;
            }
            let e = if a <= c { (a, c) } else { (c, a) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 2)
}

pub(crate) fn center(b: &[[f64; 3]]) -> [f64; 3] {
    let m = b.len().max(1) as f64;
    let mut c = [0.0; 3];
    for p in b {
        for k in 0..3 { c[k] += p[k]; }
    }
    [c[0] / m, c[1] / m, c[2] / m]
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(test)]
#[path = "geom_tests.rs"]
mod geom_tests;
