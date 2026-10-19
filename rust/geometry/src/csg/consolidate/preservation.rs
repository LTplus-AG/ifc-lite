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
/// open against the cleaned neighbours (#7292). An open edge that is not wholly
/// on a fold or fold-support triangle is a tear the fold did not need, and the
/// fold-free result is the better host (#7949: the ISSUE_068 opening-dense
/// walls, where a noise-level fold turned the whole wall into hairline cracks).
///
/// "On the fold" is geometric and covers the whole edge, not its endpoints: a
/// peer seam conform splits a retained edge at a vertex the fold never owned
/// (the sub-edge is still the fold's boundary), while an edge joining two
/// separate fold regions has both endpoints on a fold and runs through none.
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
    const SAMPLES: usize = 4;
    let mut triangles: Vec<[Point3<f64>; 3]> = Vec::new();
    for key in supported.folded_buckets.iter().chain(&supported.fold_support_buckets) {
        triangles.extend(buckets.get(key).into_iter().flatten().map(|tri| tri.v));
    }
    let on_fold = |p: &Point3<f64>| {
        let reach = TOLERANCE + F32_ROUNDING * p.coords.amax();
        triangles.iter().any(|t| distance_to_triangle(p, t) <= reach)
    };
    super::open_edge_endpoints_at(candidate, SCALE).iter().any(|edge| {
        let [a, b] = edge.map(|e| Point3::new(e.0 as f64, e.1 as f64, e.2 as f64) / SCALE);
        !(0..=SAMPLES).all(|k| on_fold(&(a + (b - a) * (k as f64 / SAMPLES as f64))))
    })
}

/// Distance from `p` to the closed triangle `t` (Ericson, Real-Time Collision
/// Detection 5.1.5).
fn distance_to_triangle(p: &nalgebra::Point3<f64>, t: &[nalgebra::Point3<f64>; 3]) -> f64 {
    let [a, b, c] = *t;
    let (ab, ac, ap) = (b - a, c - a, p - a);
    let (d1, d2) = (ab.dot(&ap), ac.dot(&ap));
    let closest = if d1 <= 0.0 && d2 <= 0.0 {
        a
    } else {
        let bp = p - b;
        let (d3, d4) = (ab.dot(&bp), ac.dot(&bp));
        if d3 >= 0.0 && d4 <= d3 {
            b
        } else if d1 * d4 - d3 * d2 <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
            a + ab * (d1 / (d1 - d3))
        } else {
            let cp = p - c;
            let (d5, d6) = (ab.dot(&cp), ac.dot(&cp));
            if d6 >= 0.0 && d5 <= d6 {
                c
            } else if d5 * d2 - d1 * d6 <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                a + ac * (d2 / (d2 - d6))
            } else if d3 * d6 - d5 * d4 <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
                b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)))
            } else {
                let va = d3 * d6 - d5 * d4;
                let vb = d5 * d2 - d1 * d6;
                let vc = d1 * d4 - d3 * d2;
                let denom = 1.0 / (va + vb + vc);
                a + ab * (vb * denom) + ac * (vc * denom)
            }
        }
    };
    (p - closest).norm()
}
