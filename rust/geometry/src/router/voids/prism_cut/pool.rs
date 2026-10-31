// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tolerance-merging 2D point pool shared by the triangle and cap CDTs.

use super::kit::{V2, V3};
use nalgebra::Point2;
use rustc_hash::FxHashMap;

/// 2D point pool with tolerance merging: canonical 3D/normal = first-seen.
/// Merging kills the 1e-12 doublets a cutter-edge junction produces when two
/// faces' clips compute the same geometric point through different arithmetic.
pub(super) struct PointPool {
    pub(super) pts2: Vec<Point2<f64>>,
    pub(super) pts3: Vec<V3>,
    pub(super) nrm: Vec<V3>,
    pub(super) buckets: FxHashMap<(i64, i64), Vec<usize>>,
    pub(super) eps: f64,
}

impl PointPool {
    pub(super) fn new(eps: f64) -> Self {
        Self {
            pts2: Vec::new(),
            pts3: Vec::new(),
            nrm: Vec::new(),
            buckets: FxHashMap::default(),
            eps: eps.max(1.0e-15),
        }
    }
    pub(super) fn intern(&mut self, q: V2, p3: V3, n: V3) -> usize {
        let cell = |x: f64| (x / (self.eps * 4.0)).floor() as i64;
        let (cx, cy) = (cell(q[0]), cell(q[1]));
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(ids) = self.buckets.get(&(cx + dx, cy + dy)) {
                    for &i in ids {
                        let d0 = self.pts2[i].x - q[0];
                        let d1 = self.pts2[i].y - q[1];
                        if d0.abs() <= self.eps && d1.abs() <= self.eps {
                            return i;
                        }
                    }
                }
            }
        }
        let idx = self.pts2.len();
        self.pts2.push(Point2::new(q[0], q[1]));
        self.pts3.push(p3);
        self.nrm.push(n);
        self.buckets.entry((cx, cy)).or_default().push(idx);
        idx
    }
}
