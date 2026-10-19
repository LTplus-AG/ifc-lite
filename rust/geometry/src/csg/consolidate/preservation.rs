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
/// open against the cleaned neighbours (#7292). An open edge that touches no
/// fold or fold-support vertex is a tear the fold did not need, and the
/// fold-free result is the better host (#7949: the ISSUE_068 opening-dense
/// walls, where a noise-level fold turned the whole wall into hairline cracks).
pub(super) fn tears_beyond_folds(
    candidate: &Mesh,
    buckets: &super::buckets::Buckets,
    supported: &super::supported_cells::Supported,
) -> bool {
    const SCALE: f64 = 1.0e4;
    let grid = |v: f64| (f64::from(v as f32) * SCALE).round() as i64;
    let mut fold_points = rustc_hash::FxHashSet::default();
    for key in supported.folded_buckets.iter().chain(&supported.fold_support_buckets) {
        for tri in buckets.get(key).into_iter().flatten() {
            fold_points.extend(tri.v.iter().map(|p| (grid(p.x), grid(p.y), grid(p.z))));
        }
    }
    super::open_edge_endpoints_at(candidate, SCALE)
        .iter()
        .any(|edge| !edge.iter().all(|end| fold_points.contains(end)))
}
