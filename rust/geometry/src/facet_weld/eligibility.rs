// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7633: full-edge connectivity only describes a conforming source. Decline
//! partition on ambiguous inputs and retain the original cluster fit. This is
//! a topology prerequisite, not a shape/volume preservation certificate.

use super::SNAP_GRID;
use crate::Mesh;
use bnum::cast::CastFrom;
use bnum::types::I256;
use num_traits::ConstZero;
use rustc_hash::FxHashMap;

fn insert_edge<K: Copy + Ord + std::hash::Hash>(
    edges: &mut FxHashMap<(K, K), [u8; 2]>,
    a: K,
    b: K,
) -> bool {
    if a == b {
        return false;
    }
    let uses = edges.entry((a.min(b), a.max(b))).or_default();
    let direction = usize::from(a > b);
    if uses[direction] != 0 {
        return false;
    }
    uses[direction] = 1;
    true
}

/// Check both the actual kernel grid and the existing canonical IDs used by
/// the component graph. Neither closure implies the other: 49/51 micrometre
/// copies share a fine cell but straddle the 100 micrometre canonical boundary.
/// Every triangle must have nonzero area and every edge exactly one use in
/// each direction in BOTH domains. Work and storage are linear in source size.
pub(super) fn source_is_conforming(
    mesh: &Mesh,
    canon_of: &[usize],
    canon_pos: &[[f64; 3]],
) -> bool {
    if mesh.indices.is_empty()
        || !mesh.indices.len().is_multiple_of(3)
        || !mesh.positions.len().is_multiple_of(3)
        || canon_of.len() != mesh.positions.len() / 3
    {
        return false;
    }
    let mut fine = FxHashMap::default();
    let mut canonical = FxHashMap::default();
    for triangle in mesh.indices.chunks_exact(3) {
        let mut ids = [0; 3];
        let mut points = [[0i64; 3]; 3];
        for corner in 0..3 {
            let index = triangle[corner] as usize;
            let Some(&id) = canon_of.get(index) else {
                return false;
            };
            let Some(p) = canon_pos.get(id) else {
                return false;
            };
            if p.iter().any(|v| !v.is_finite()) {
                return false;
            }
            ids[corner] = id;
            for axis in 0..3 {
                let value = (f64::from(mesh.positions[index * 3 + axis]) / SNAP_GRID).round();
                if !value.is_finite() || value < i64::MIN as f64 || value >= -(i64::MIN as f64) {
                    return false;
                }
                points[corner][axis] = value as i64;
            }
        }
        let [a, b, c] = points;
        let ab: [I256; 3] = std::array::from_fn(|k| I256::cast_from(b[k]) - I256::cast_from(a[k]));
        let ac: [I256; 3] = std::array::from_fn(|k| I256::cast_from(c[k]) - I256::cast_from(a[k]));
        if [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ] == [I256::ZERO; 3]
        {
            return false;
        }
        // The canonical positions are original f32 coordinates, NOT grid
        // centres. Test their exact projected orientations without resnapping.
        let canonical_nonzero = [(0, 1), (1, 2), (2, 0)].into_iter().any(|(x, y)| {
            let p = ids.map(|id| [canon_pos[id][x], canon_pos[id][y]]);
            geometry_predicates::orient2d(p[0], p[1], p[2]) != 0.0
        });
        if !canonical_nonzero {
            return false;
        }
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            if !insert_edge(&mut fine, points[a], points[b])
                || !insert_edge(&mut canonical, ids[a], ids[b])
            {
                return false;
            }
        }
    }
    fine.values().all(|uses| *uses == [1, 1]) && canonical.values().all(|uses| *uses == [1, 1])
}

/// A new patch may use its own plane only when every actual fit position is
/// exactly on that plane. Otherwise the established jitter fit remains in
/// charge. An already-coplanar whole cluster likewise keeps its original fit.
/// Translation uses the same anchor subtraction as the fit's normal/offset
/// construction; no resnapping or planarity band is introduced.
pub(super) fn patch_is_planar(
    facets: &[super::fit::Facet],
    members: &[usize],
    canon_pos: &[[f64; 3]],
    anchor: [f64; 3],
) -> bool {
    let point = |id: usize| std::array::from_fn(|k| canon_pos[id][k] - anchor[k]);
    // Facets were built only from nondegenerate anchored triangles.
    let [a, b, c] = facets[members[0]].tri.map(point);
    members.iter().all(|&member| {
        facets[member]
            .tri
            .iter()
            .all(|&id| geometry_predicates::orient3d(a, b, c, point(id)) == 0.0)
    })
}
