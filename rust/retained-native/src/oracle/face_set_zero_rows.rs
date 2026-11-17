// SPDX-License-Identifier: MPL-2.0
//! #7955 ruling 13: retained drops an authored zero-area row, which leaves its neighbours'
//! edges open by exact coordinates although nothing of the surface is lost. Such a closure
//! defect is explained only by the authored rows themselves: the set closes with all of them,
//! every row without a published triangle has no area, and the published open edges are
//! exactly what the published rows alone leave.
use super::face_sets::{AuthoredFaceSet, Edge};
use std::collections::{BTreeMap, BTreeSet};

fn open_of<'a>(edges: impl Iterator<Item = &'a Edge>) -> BTreeSet<Edge> {
    let mut counts: BTreeMap<Edge, usize> = BTreeMap::new();
    for edge in edges { *counts.entry(*edge).or_default() += 1; }
    counts.into_iter().filter(|(_, n)| *n != 2).map(|(edge, _)| edge).collect()
}
/// The mesh's open edges by exact coordinates; +0 and -0 are the same corner.
pub fn mesh_open_edges(positions: &[f64], indices: &[u32]) -> Option<BTreeSet<Edge>> {
    let key = |i: u32| -> Option<[u64; 3]> {
        let at = (i as usize).checked_mul(3)?;
        let p = positions.get(at..at + 3)?;
        Some([(p[0] + 0.).to_bits(), (p[1] + 0.).to_bits(), (p[2] + 0.).to_bits()])
    };
    let mut edges = Vec::with_capacity(indices.len());
    for triangle in indices.chunks_exact(3) {
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let (a, b) = (key(triangle[a])?, key(triangle[b])?);
            edges.push((a.min(b), a.max(b)));
        }
    }
    Some(open_of(edges.iter()))
}
/// How many of a part's open edges the set's dropped zero-area rows explain: all of them or
/// `None`. `keys` names each published triangle's row; `positions` are the part's own, which
/// a faithful copy keeps bit-identical to the authored points.
pub fn explained_open_edges(set: &AuthoredFaceSet, positions: &[f64], indices: &[u32], keys: &[Option<u32>]) -> Option<usize> {
    let open = mesh_open_edges(positions, indices)?;
    if open.is_empty() { return Some(0); }
    if set.open_edges != 0 { return None; }
    let published: BTreeSet<usize> = keys.iter().map(|k| k.map(|k| k as usize)).collect::<Option<_>>()?;
    let dropped_have_no_area = set.rows.iter().enumerate()
        .all(|(k, row)| published.contains(&k) || row.area_m2 == Some(0.));
    let left = open_of(published.iter().filter_map(|k| set.row_edges.get(*k)).flatten());
    (dropped_have_no_area && open == left).then_some(open.len())
}
