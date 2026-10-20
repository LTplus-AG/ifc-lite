// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Necessary boundary certificate after the existing caller's public f32 weld.
//! This is not exact geometry closure, simplicity, or a signed-volume proof.
use crate::Mesh;
use rustc_hash::FxHashMap;

/// Use the SAME public f32 quantizer as the committed #3913 union caller.
/// Require nonempty indexed output and exactly1f/1r per welded edge. The
/// post-weld nonempty check intentionally strengthens NEW baseline-adoption
/// eligibility versus the old sweep's vacuous all-collapsed case. No geometric
/// collinearity/area predicate is added. The welded mesh is diagnostic ONLY.
pub(super) fn public_weld_closed(mesh: &Mesh) -> bool {
    if mesh.positions.is_empty() || !mesh.positions.len().is_multiple_of(3)
        || !mesh.indices.len().is_multiple_of(3)
        || mesh.positions.iter().any(|v| !v.is_finite())
        || mesh.indices.iter().any(|&i| i as usize >= mesh.positions.len() / 3)
    {
        return false;
    }
    let welded = mesh.welded_by_position(1.0e-4);
    if welded.indices.is_empty() {
        return false;
    }
    let mut edges: FxHashMap<(u32, u32), (u8, u8)> = FxHashMap::default();
    for triangle in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (triangle[k], triangle[(k + 1) % 3]);
            if a == b {
                return false;
            }
            let (edge, forward) = if a < b { ((a, b), true) } else { ((b, a), false) };
            let counts = edges.entry(edge).or_default();
            if forward { counts.0 += 1; } else { counts.1 += 1; }
            if counts.0 > 1 || counts.1 > 1 {
                return false;
            }
        }
    }
    edges.values().all(|&counts| counts == (1, 1))
}

#[cfg(test)]
#[path = "preservation_tests.rs"]
mod tests;

/// Keep the existing signed boundary readings at both established resolutions,
/// including partially open inputs for which neither strict closure bar fires.
pub(super) fn signed_boundary_worse(candidate: &Mesh, baseline: &Mesh) -> bool {
    [1.0e3, 1.0e4].into_iter().any(|scale|
        super::count_open_boundary_edges_at(candidate, scale)
            > super::count_open_boundary_edges_at(baseline, scale))
}

/// Does `candidate` leave boundary open anywhere other than along a retained
/// fold? A healthy fold keeps its own finite support, and that support may stay
/// open against the cleaned neighbours (#7292). An open edge that does not run
/// wholly along the edges of a fold or fold-support triangle is a tear the fold
/// did not need, and the fold-free result is the better host (#7949: the
/// ISSUE_068 opening-dense walls, where a noise-level fold turned the whole wall
/// into hairline cracks).
///
/// "Along the fold" is geometric and covers the whole edge, not its endpoints: a
/// peer seam conform splits a retained edge at a vertex the fold never owned
/// (the sub-edge still runs along it), while a chord through a fold's interior,
/// or an edge joining two separate fold regions, has both endpoints on a fold
/// and runs along none of its edges. The edge is covered when the fold edges
/// collinear with it, within tolerance, jointly span it end to end.
pub(super) fn tears_beyond_folds(
    candidate: &Mesh,
    buckets: &super::buckets::Buckets,
    supported: &super::supported_cells::Supported,
) -> bool {
    use nalgebra::Point3;
    const SCALE: f64 = 1.0e4;
    // Two grid cells, plus the f32 rounding of the candidate's positions, which
    // grows with the coordinate (about 1e-4 at 1000 units).
    const TOLERANCE: f64 = 2.0 / SCALE;
    const F32_ROUNDING: f64 = 3.0e-7;
    let mut fold_edges: Vec<[Point3<f64>; 2]> = Vec::new();
    for key in supported.folded_buckets.iter().chain(&supported.fold_support_buckets) {
        for tri in buckets.get(key).into_iter().flatten() {
            fold_edges.extend((0..3).map(|k| [tri.v[k], tri.v[(k + 1) % 3]]));
        }
    }
    super::open_edge_endpoints_at(candidate, SCALE).iter().any(|edge| {
        let [a, b] = edge.map(|e| Point3::new(e.0 as f64, e.1 as f64, e.2 as f64) / SCALE);
        let reach = TOLERANCE + F32_ROUNDING * a.coords.abs().max().max(b.coords.abs().max());
        !edge_covered_by(&a, &b, &fold_edges, reach)
    })
}

/// Is the segment `a`-`b` wholly within `reach` of the union of `edges`?
///
/// Each edge collinear with `a`-`b` (both its ends within `reach` of the line)
/// covers the parameter interval its ends project to; the segment is covered
/// when those intervals, each widened by `reach`, chain across [0, 1].
fn edge_covered_by(
    a: &nalgebra::Point3<f64>,
    b: &nalgebra::Point3<f64>,
    edges: &[[nalgebra::Point3<f64>; 2]],
    reach: f64,
) -> bool {
    let ab = b - a;
    let len2 = ab.norm_squared();
    let len = len2.sqrt();
    if len <= reach {
        // A degenerate open edge is a point: some fold edge must pass through it.
        return edges.iter().any(|[c, d]| {
            let cd = d - c;
            let l2 = cd.norm_squared();
            let t = if l2 > 0.0 { ((a - c).dot(&cd) / l2).clamp(0.0, 1.0) } else { 0.0 };
            (a - (c + cd * t)).norm() <= reach
        });
    }
    let line_distance = |p: &nalgebra::Point3<f64>| (ab.cross(&(p - a))).norm() / len;
    let param = |p: &nalgebra::Point3<f64>| (p - a).dot(&ab) / len2;
    let slack = reach / len;
    let mut spans: Vec<(f64, f64)> = edges
        .iter()
        .filter(|[c, d]| line_distance(c) <= reach && line_distance(d) <= reach)
        .map(|[c, d]| {
            let (tc, td) = (param(c), param(d));
            (tc.min(td), tc.max(td))
        })
        .filter(|&(lo, hi)| hi >= -slack && lo <= 1.0 + slack)
        .collect();
    spans.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut covered = 0.0_f64;
    for (lo, hi) in spans {
        if lo > covered + slack {
            return false;
        }
        covered = covered.max(hi);
        if covered >= 1.0 - slack {
            return true;
        }
    }
    covered >= 1.0 - slack
}
