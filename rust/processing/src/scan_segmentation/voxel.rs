// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Order-independent voxel working set.
//!
//! Every point is quantised to a fixed-point lattice (`QUANTA_PER_METRE`)
//! relative to the positions' frame origin, and each voxel keeps the integer
//! sum of its points' offsets from the voxel's own corner plus their count.
//! Integer addition is associative, so the sums, and everything derived from
//! them, are identical for any point order or chunking.
//!
//! The voxel edge is an integer number of quanta. When the voxel count passes
//! the budget the edge doubles and every voxel folds into its parent: the
//! parent's sum is the child's sum plus `count x (child corner - parent
//! corner)`, still exact. Folding equals voxelising at the coarse edge
//! directly, so the final lattice is the finest one whose voxel count fits
//! the budget for the whole input: also independent of order.
use super::options::{Params, MAX_ABS_COORDINATE, MAX_COARSENINGS, MAX_POINTS};
use rustc_hash::FxHashMap;
use std::collections::hash_map::Entry;

/// 2^16 quanta per metre (~15 micrometres): far below scanner noise, and small
/// enough that i64 sums cannot overflow under `MAX_POINTS` and `MAX_COARSENINGS`.
pub(crate) const QUANTA_PER_METRE: f64 = 65_536.;

pub(crate) type Key = [i32; 3];

pub(crate) struct VoxelGrid {
    size_quanta: i64,
    max_voxels: usize,
    pub coarsenings: u32,
    index: FxHashMap<Key, u32>,
    keys: Vec<Key>,
    sums: Vec<[i64; 3]>,
    counts: Vec<u32>,
    region: Option<super::ScanRegion>,
    pub input: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub outside: u64,
    /// Largest |coordinate| among accepted points (order-independent).
    pub max_abs: f64,
}

/// Finished voxels sorted by key: every later stage iterates in this order.
pub(crate) struct VoxelSet {
    pub size: f64,
    pub keys: Vec<Key>,
    pub means: Vec<[f64; 3]>,
    pub counts: Vec<u32>,
    index: FxHashMap<Key, u32>,
}

impl VoxelGrid {
    pub fn new(params: &Params) -> Self {
        Self {
            size_quanta: params.base_size_quanta,
            max_voxels: params.max_voxels,
            coarsenings: 0,
            index: FxHashMap::default(),
            keys: Vec::new(),
            sums: Vec::new(),
            counts: Vec::new(),
            region: params.region,
            input: 0,
            accepted: 0,
            rejected: 0,
            outside: 0,
            max_abs: 0.,
        }
    }

    pub fn add(&mut self, positions: &[f32]) -> Result<(), String> {
        if !positions.len().is_multiple_of(3) {
            return Err("Scan positions must be xyz triples".into());
        }
        let n = (positions.len() / 3) as u64;
        if self.input + n > MAX_POINTS {
            return Err(format!("Scan segmentation accepts at most {MAX_POINTS} points"));
        }
        self.input += n;
        for p in positions.chunks_exact(3) {
            let p = [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])];
            if !p.iter().all(|v| v.is_finite() && v.abs() <= MAX_ABS_COORDINATE) {
                self.rejected += 1;
                continue;
            }
            if let Some(r) = &self.region {
                if (0..3).any(|a| p[a] < r.min[a] || p[a] > r.max[a]) {
                    self.outside += 1;
                    continue;
                }
            }
            self.accepted += 1;
            self.max_abs = p.iter().fold(self.max_abs, |m, v| m.max(v.abs()));
            let q = p.map(|v| (v * QUANTA_PER_METRE).round() as i64);
            let key = q.map(|v| v.div_euclid(self.size_quanta) as i32);
            let slot = match self.index.entry(key) {
                Entry::Occupied(e) => *e.get() as usize,
                Entry::Vacant(e) => {
                    e.insert(self.keys.len() as u32);
                    self.keys.push(key);
                    self.sums.push([0; 3]);
                    self.counts.push(0);
                    self.keys.len() - 1
                }
            };
            for a in 0..3 {
                self.sums[slot][a] += q[a] - i64::from(key[a]) * self.size_quanta;
            }
            self.counts[slot] += 1;
            while self.keys.len() > self.max_voxels {
                self.coarsen()?;
            }
        }
        Ok(())
    }

    fn coarsen(&mut self) -> Result<(), String> {
        if self.coarsenings >= MAX_COARSENINGS {
            return Err(format!(
                "Scan voxel budget still exceeded after doubling the voxel size {MAX_COARSENINGS} times"
            ));
        }
        let old = self.size_quanta;
        self.size_quanta *= 2;
        self.coarsenings += 1;
        let mut index = FxHashMap::default();
        let (mut keys, mut sums, mut counts) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..self.keys.len() {
            let child = self.keys[i];
            let parent = child.map(|k| k.div_euclid(2));
            let slot = *index.entry(parent).or_insert_with(|| {
                keys.push(parent);
                sums.push([0_i64; 3]);
                counts.push(0_u32);
                keys.len() as u32 - 1
            }) as usize;
            let count = i64::from(self.counts[i]);
            for a in 0..3 {
                let corner_offset = i64::from(child[a] - 2 * parent[a]) * old;
                sums[slot][a] += self.sums[i][a] + count * corner_offset;
            }
            counts[slot] += self.counts[i];
        }
        (self.index, self.keys, self.sums, self.counts) = (index, keys, sums, counts);
        Ok(())
    }

    /// Spacing of adjacent f32 values at the largest accepted coordinate: the
    /// resolution the input positions can carry at all.
    pub fn f32_spacing(&self) -> f64 {
        if self.max_abs < f64::from(f32::MIN_POSITIVE) {
            return 0.;
        }
        2_f64.powi(self.max_abs.log2().floor() as i32 - 23)
    }

    pub fn size_metres(&self) -> f64 {
        self.size_quanta as f64 / QUANTA_PER_METRE
    }

    pub fn finish(self) -> VoxelSet {
        let mut order: Vec<u32> = (0..self.keys.len() as u32).collect();
        order.sort_unstable_by_key(|&i| self.keys[i as usize]);
        let size = self.size_quanta;
        let keys: Vec<Key> = order.iter().map(|&i| self.keys[i as usize]).collect();
        let counts: Vec<u32> = order.iter().map(|&i| self.counts[i as usize]).collect();
        let means = order
            .iter()
            .map(|&i| {
                let (key, sum, n) = (self.keys[i as usize], self.sums[i as usize], f64::from(self.counts[i as usize]));
                std::array::from_fn(|a| ((i64::from(key[a]) * size) as f64 + sum[a] as f64 / n) / QUANTA_PER_METRE)
            })
            .collect();
        let index = keys.iter().enumerate().map(|(i, k)| (*k, i as u32)).collect();
        VoxelSet { size: size as f64 / QUANTA_PER_METRE, keys, means, counts, index }
    }
}

impl VoxelSet {
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// The voxel at `key`, if occupied.
    pub fn lookup(&self, key: Key) -> Option<u32> {
        self.index.get(&key).copied()
    }

    /// Calls `visit` for every occupied voxel whose key lies in the box
    /// spanning `ends` widened by `margin` (plus one voxel), in key order; or
    /// for every voxel, in index order, when the box holds more keys than
    /// there are voxels. Callers test the exact shape themselves.
    pub fn for_each_in_box(&self, ends: [[f64; 3]; 2], margin: f64, mut visit: impl FnMut(u32)) {
        let key = |v: f64| (v / self.size).floor();
        let lo: [f64; 3] = std::array::from_fn(|a| key(ends[0][a].min(ends[1][a]) - margin) - 1.);
        let hi: [f64; 3] = std::array::from_fn(|a| key(ends[0][a].max(ends[1][a]) + margin) + 1.);
        let cells: f64 = (0..3).map(|a| hi[a] - lo[a] + 1.).product();
        if cells > self.len() as f64 {
            (0..self.len() as u32).for_each(visit);
            return;
        }
        for x in lo[0] as i32..=hi[0] as i32 {
            for y in lo[1] as i32..=hi[1] as i32 {
                for z in lo[2] as i32..=hi[2] as i32 {
                    if let Some(k) = self.lookup([x, y, z]) {
                        visit(k);
                    }
                }
            }
        }
    }

    /// Calls `visit` for every occupied voxel within `rings` of voxel `i`
    /// (excluding `i`), in a fixed z-y-x order.
    pub fn for_each_neighbor(&self, i: u32, rings: i32, mut visit: impl FnMut(u32)) {
        let key = self.keys[i as usize];
        for dz in -rings..=rings {
            for dy in -rings..=rings {
                for dx in -rings..=rings {
                    if dx == 0 && dy == 0 && dz == 0 {
                        continue;
                    }
                    if let Some(&j) = self.index.get(&[key[0] + dx, key[1] + dy, key[2] + dz]) {
                        visit(j);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "voxel_tests.rs"]
mod tests;
