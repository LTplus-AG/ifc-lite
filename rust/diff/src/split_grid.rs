// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded uniform-grid candidate lookup and deterministic proximity clusters.
use std::collections::HashMap;
use crate::model::EntityAabb;
use crate::split_geometry::boxes_touch;

pub struct BoxGrid {
    count: usize,
    cell: f64,
    buckets: HashMap<[i64; 3], Vec<usize>>,
    scan: bool,
}
impl BoxGrid {
    pub fn new(boxes: &[EntityAabb]) -> Self {
        let mut cell = 0.0;
        for b in boxes {
            for axis in 0..3 {
                let extent = b.max[axis] - b.min[axis];
                if extent > cell { cell = extent; }
            }
        }
        if cell <= 0.0 { cell = 1.0; }
        let mut grid = Self { count: boxes.len(), cell, buckets: HashMap::new(), scan: false };
        for (index, b) in boxes.iter().enumerate() {
            let Some((lo, hi)) = grid.range(b, 0.0) else {
                // Extreme coordinates cannot be stepped safely as JS numbers.
                // A scan retains the candidate-superset contract.
                grid.scan = true;
                grid.buckets.clear();
                break;
            };
            for x in lo[0]..=hi[0] { for y in lo[1]..=hi[1] { for z in lo[2]..=hi[2] {
                grid.buckets.entry([x, y, z]).or_default().push(index);
            } } }
        }
        grid
    }
    fn range(&self, b: &EntityAabb, pad: f64) -> Option<([i64; 3], [i64; 3])> {
        let mut lo = [0; 3];
        let mut hi = [0; 3];
        let mut cells = 1.0;
        for axis in 0..3 {
            let a = ((b.min[axis] - pad) / self.cell).floor();
            let z = ((b.max[axis] + pad) / self.cell).floor();
            if !a.is_finite() || !z.is_finite() || a.abs() >= 4503599627370496.0 || z.abs() >= 4503599627370496.0 { return None; }
            cells *= z - a + 1.0;
            lo[axis] = a as i64;
            hi[axis] = z as i64;
        }
        if !cells.is_finite() || cells > 4096.0 { return None; }
        Some((lo, hi))
    }
    pub fn query(&self, b: &EntityAabb, pad: f64) -> Vec<usize> {
        if self.scan { return (0..self.count).collect(); }
        let Some((lo, hi)) = self.range(b, pad) else { return (0..self.count).collect(); };
        let mut found = Vec::new();
        for x in lo[0]..=hi[0] { for y in lo[1]..=hi[1] { for z in lo[2]..=hi[2] {
            if let Some(indices) = self.buckets.get(&[x, y, z]) { found.extend_from_slice(indices); }
        } } }
        found.sort_unstable();
        found.dedup();
        found
    }
}
fn find(parent: &mut [usize], i: usize) -> usize {
    let mut root = i;
    while parent[root] != root { root = parent[root]; }
    let mut walk = i;
    while parent[walk] != root {
        let next = parent[walk];
        parent[walk] = root;
        walk = next;
    }
    root
}
pub fn cluster_by_proximity(boxes: &[EntityAabb], paddings: &[f64]) -> Vec<Vec<usize>> {
    let mut parent: Vec<_> = (0..boxes.len()).collect();
    let grid = BoxGrid::new(boxes);
    let mut reach = 0.0;
    for &padding in paddings { if padding > reach { reach = padding; } }
    reach *= 2.0;
    for i in 0..boxes.len() {
        for j in grid.query(&boxes[i], reach) {
            if j <= i || !boxes_touch(&boxes[i], &boxes[j], paddings[i].max(paddings[j])) { continue; }
            let a = find(&mut parent, i);
            let b = find(&mut parent, j);
            if a != b { parent[a] = b; }
        }
    }
    let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..boxes.len() { by_root.entry(find(&mut parent, i)).or_default().push(i); }
    let mut components: Vec<_> = by_root.into_values().collect();
    components.sort_by_key(|members| members[0]);
    components
}
