// SPDX-License-Identifier: MPL-2.0
//! #7955 ruling 20 (rvt01's doors): a near-degenerate triangle retained drops from its own
//! triangulation of a closed polygon row leaves exactly that triangle's three edges open.
use super::face_set_zero_rows::mesh_open_edges;
use super::face_sets::AuthoredFaceSet;
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
    // The rows each corner lies on: a component can only be inside a row its first corner is on.
    let mut on: BTreeMap<[u64; 3], Vec<usize>> = BTreeMap::new();
    for (k, row) in rows.iter().enumerate() { for &corner in row { on.entry(corner).or_default().push(k); } }
    let mut degree: BTreeMap<[u64; 3], usize> = BTreeMap::new();
    for (a, b) in &open { *degree.entry(*a).or_default() += 1; *degree.entry(*b).or_default() += 1; }
    if degree.values().any(|d| d % 2 != 0) { return None; }
    // Each connected component of open edges, by one walk over corner adjacency.
    let mut next: BTreeMap<[u64; 3], Vec<[u64; 3]>> = BTreeMap::new();
    for &(a, b) in &open { next.entry(a).or_default().push(b); next.entry(b).or_default().push(a); }
    let mut seen: BTreeSet<[u64; 3]> = BTreeSet::new();
    for &start in next.keys() {
        if !seen.insert(start) { continue; }
        let (mut corners, mut stack) = (BTreeSet::from([start]), vec![start]);
        while let Some(p) = stack.pop() {
            for &q in &next[&p] { if seen.insert(q) { corners.insert(q); stack.push(q); } }
        }
        if !on.get(&start).is_some_and(|ks| ks.iter().any(|&k| corners.is_subset(&rows[k]))) { return None; }
    }
    Some(open.len())
}
