// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Axis-aligned bounding boxes and the cheap separation/overlap helpers the
//! clash engine relies on.
//!
//! Faithful port of `packages/clash/src/math/aabb.ts`.

use crate::vec3::Vec3;

/// An axis-aligned bounding box with explicit `min`/`max` corners.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Aabb {
    #[inline]
    pub fn new(min: [f64; 3], max: [f64; 3]) -> Self {
        Self { min, max }
    }

    /// Axis-aligned bounds of a packed `[x, y, z, ...]` position buffer.
    ///
    /// Mirrors `fromPositions`; the optional transform from the TS source is
    /// dropped because the native API ingests world-space geometry directly.
    pub fn from_positions(positions: &[f64]) -> Aabb {
        if positions.len() < 3 {
            return Aabb::new([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]);
        }
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        let mut i = 0;
        while i + 2 < positions.len() {
            for axis in 0..3 {
                let v = positions[i + axis];
                if v < min[axis] {
                    min[axis] = v;
                }
                if v > max[axis] {
                    max[axis] = v;
                }
            }
            i += 3;
        }
        Aabb::new(min, max)
    }

    /// Expand bounds by `m` on every side.
    #[inline]
    pub fn inflate(&self, m: f64) -> Aabb {
        Aabb::new(
            [self.min[0] - m, self.min[1] - m, self.min[2] - m],
            [self.max[0] + m, self.max[1] + m, self.max[2] + m],
        )
    }

    #[inline]
    pub fn center(&self) -> Vec3 {
        [
            (self.min[0] + self.max[0]) / 2.0,
            (self.min[1] + self.max[1]) / 2.0,
            (self.min[2] + self.max[2]) / 2.0,
        ]
    }

    #[inline]
    pub fn intersects(&self, b: &Aabb) -> bool {
        self.min[0] <= b.max[0]
            && self.max[0] >= b.min[0]
            && self.min[1] <= b.max[1]
            && self.max[1] >= b.min[1]
            && self.min[2] <= b.max[2]
            && self.max[2] >= b.min[2]
    }
}

/// Signed gap between two boxes: `>0` is the Euclidean separation, `<0` is the
/// penetration depth (negative of the minimum-axis overlap).
pub fn signed_gap(a: &Aabb, b: &Aabb) -> f64 {
    let mut squared_distance = 0.0;
    let mut min_overlap = f64::INFINITY;
    let mut penetrating = true;
    for i in 0..3 {
        let gap = (b.min[i] - a.max[i]).max(a.min[i] - b.max[i]);
        if gap > 0.0 {
            squared_distance += gap * gap;
            penetrating = false;
        } else {
            let overlap = a.max[i].min(b.max[i]) - a.min[i].max(b.min[i]);
            if overlap < min_overlap {
                min_overlap = overlap;
            }
        }
    }
    if penetrating {
        -min_overlap
    } else {
        squared_distance.sqrt()
    }
}

/// The intersection box of two overlapping bounds (clamped to be non-inverted).
pub fn overlap_bounds(a: &Aabb, b: &Aabb) -> Aabb {
    let mut min = [
        a.min[0].max(b.min[0]),
        a.min[1].max(b.min[1]),
        a.min[2].max(b.min[2]),
    ];
    let mut max = [
        a.max[0].min(b.max[0]),
        a.max[1].min(b.max[1]),
        a.max[2].min(b.max[2]),
    ];
    for i in 0..3 {
        if max[i] < min[i] {
            let mid = (min[i] + max[i]) / 2.0;
            min[i] = mid;
            max[i] = mid;
        }
    }
    Aabb::new(min, max)
}

/// Bounds enclosing two points.
pub fn bounds_of_points(a: Vec3, b: Vec3) -> Aabb {
    Aabb::new(
        [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])],
        [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])],
    )
}
