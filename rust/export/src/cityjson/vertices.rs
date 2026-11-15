// SPDX-License-Identifier: MPL-2.0
//! The integer vertex pool behind a CityJSON `transform`.
//!
//! CityJSON stores every vertex as three integers and one dataset-wide
//! `scale` and `translate` (spec §4). Vertices are snapped to the grid
//! `round(x / scale)` in absolute coordinates first, so deduplication does not
//! depend on the translate; the translate is the grid minimum, chosen once
//! the whole model has been pooled, and each stored integer is its grid
//! offset from that minimum. Two vertices closer than half a grid step are
//! one vertex, which is the deduplication the format is designed around.

use std::collections::HashMap;

/// Snapped vertices, deduplicated on the grid.
pub(super) struct VertexPool {
    scale: f64,
    grid: Vec<[i64; 3]>,
    index: HashMap<[i64; 3], u32>,
}

impl VertexPool {
    pub(super) fn new(scale: f64) -> Self {
        Self { scale, grid: Vec::new(), index: HashMap::new() }
    }

    /// The grid cell of a real coordinate, or `None` for a non-finite one or
    /// one too far out for an `i64` grid at this scale.
    fn cell(&self, p: [f64; 3]) -> Option<[i64; 3]> {
        let mut out = [0i64; 3];
        for (slot, value) in out.iter_mut().zip(p) {
            let q = (value / self.scale).round();
            if !q.is_finite() || q.abs() > 9.0e15 {
                return None;
            }
            *slot = q as i64;
        }
        Some(out)
    }

    /// The pool index of `p`, adding it when its grid cell is new.
    pub(super) fn add(&mut self, p: [f64; 3]) -> Option<u32> {
        let cell = self.cell(p)?;
        if let Some(&i) = self.index.get(&cell) {
            return Some(i);
        }
        let i = u32::try_from(self.grid.len()).ok()?;
        self.grid.push(cell);
        self.index.insert(cell, i);
        Some(i)
    }

    /// Keep only the vertices in `used`, renumbered in pool order; returns
    /// old index → new index (`u32::MAX` for a dropped vertex). Snapping can
    /// collapse a ring after its vertices were pooled, and an unreferenced
    /// vertex is a cjval warning.
    pub(super) fn compact(&mut self, used: &[bool]) -> Vec<u32> {
        let mut remap = vec![u32::MAX; self.grid.len()];
        let mut grid = Vec::with_capacity(self.grid.len());
        for (old, cell) in self.grid.iter().enumerate() {
            if used.get(old).copied().unwrap_or(false) {
                remap[old] = grid.len() as u32;
                grid.push(*cell);
            }
        }
        self.index = grid.iter().enumerate().map(|(i, c)| (*c, i as u32)).collect();
        self.grid = grid;
        remap
    }

    pub(super) fn len(&self) -> usize {
        self.grid.len()
    }

    /// The grid minimum over every pooled vertex (all zero when empty).
    fn min_cell(&self) -> [i64; 3] {
        let mut min = [i64::MAX; 3];
        for cell in &self.grid {
            for axis in 0..3 {
                min[axis] = min[axis].min(cell[axis]);
            }
        }
        if self.grid.is_empty() { [0; 3] } else { min }
    }

    /// `transform.translate`: the real coordinate of the grid minimum.
    pub(super) fn translate(&self) -> [f64; 3] {
        let min = self.min_cell();
        [min[0] as f64 * self.scale, min[1] as f64 * self.scale, min[2] as f64 * self.scale]
    }

    /// The stored integer vertices, offset from the grid minimum.
    pub(super) fn integers(&self) -> Vec<[i64; 3]> {
        let min = self.min_cell();
        self.grid.iter().map(|c| [c[0] - min[0], c[1] - min[1], c[2] - min[2]]).collect()
    }

    /// The real-world extent `[minx, miny, minz, maxx, maxy, maxz]` of the
    /// given pool indices, as decoded through the transform.
    pub(super) fn extent(&self, indices: impl IntoIterator<Item = u32>) -> Option<[f64; 6]> {
        let mut lo = [i64::MAX; 3];
        let mut hi = [i64::MIN; 3];
        let mut any = false;
        for i in indices {
            let c = self.grid[i as usize];
            any = true;
            for axis in 0..3 {
                lo[axis] = lo[axis].min(c[axis]);
                hi[axis] = hi[axis].max(c[axis]);
            }
        }
        let s = self.scale;
        any.then(|| [lo[0] as f64 * s, lo[1] as f64 * s, lo[2] as f64 * s, hi[0] as f64 * s, hi[1] as f64 * s, hi[2] as f64 * s])
    }
}

/// A ring with consecutive repeats of the same pool index (including the
/// wrap from last to first) removed, or `None` when fewer than three
/// distinct vertices remain or a vertex recurs. Snapping can merge
/// neighbouring vertices; a ring that repeats a vertex is invalid (val3dity
/// error 102), and one that collapses is no surface at all. `key` reads the
/// pool index of an item.
pub(super) fn clean_ring_by<T: Copy>(ring: &[T], key: impl Fn(&T) -> u32) -> Option<Vec<T>> {
    let mut out: Vec<T> = Vec::with_capacity(ring.len());
    for item in ring {
        if out.last().map(&key) != Some(key(item)) {
            out.push(*item);
        }
    }
    while out.len() > 1 && out.first().map(&key) == out.last().map(&key) {
        out.pop();
    }
    let mut distinct: Vec<u32> = out.iter().map(&key).collect();
    distinct.sort_unstable();
    distinct.dedup();
    (distinct.len() >= 3 && distinct.len() == out.len()).then_some(out)
}
