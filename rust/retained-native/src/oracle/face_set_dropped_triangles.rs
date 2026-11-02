// SPDX-License-Identifier: MPL-2.0
//! #7955 ruling 20 (rvt01's doors): a near-degenerate triangle retained drops from its own
//! triangulation of a closed polygon row leaves exactly that triangle's three edges open.
use super::face_set_zero_rows::mesh_open_edges;
use super::face_sets::{AuthoredFaceSet, Edge};
use std::collections::{BTreeMap, BTreeSet};

/// Inside a closed polygon row, retained may drop near-degenerate triangles of its own
/// triangulation; adjacent ones along collinear corners leave one thin cycle (rvt01 #22375: four
/// corners on a line). Each component of the published open edges must then be such a cycle,
/// every corner meeting an even number of them, all on one authored row. That the dropped
/// triangles have no real area is not decided here: the row-area gate decides it, and the
/// caller requires it.
pub fn dropped_triangle_edges(set: &AuthoredFaceSet, positions: &[f64], indices: &[u32]) -> Option<usize> {
    let open = mesh_open_edges(positions, indices)?;
    if open.is_empty() || set.open_edges != 0 { return None; }
    let bits = |p: &[f64; 3]| p.map(|v| (v + 0.).to_bits());
    let rows: Vec<BTreeSet<[u64; 3]>> = set.rows.iter().map(|row| row.points.iter().map(bits).collect()).collect();
    let mut degree: BTreeMap<[u64; 3], usize> = BTreeMap::new();
    for (a, b) in &open { *degree.entry(*a).or_default() += 1; *degree.entry(*b).or_default() += 1; }
    if degree.values().any(|d| d % 2 != 0) { return None; }
    let mut left: BTreeSet<Edge> = open.clone();
    while let Some(&(a, _)) = left.iter().next() {
        // One connected component of open edges, by flood fill from `a`.
        let mut corners = BTreeSet::from([a]);
        let mut grown = true;
        while grown {
            grown = false;
            for &(p, q) in left.clone().iter() {
                if corners.contains(&p) || corners.contains(&q) {
                    left.remove(&(p, q));
                    corners.insert(p);
                    corners.insert(q);
                    grown = true;
                }
            }
        }
        if !rows.iter().any(|row| corners.is_subset(row)) { return None; }
    }
    Some(open.len())
}
