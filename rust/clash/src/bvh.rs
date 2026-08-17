// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Simple median-split AABB BVH for spatial queries.
//!
//! Faithful port of the `build` / `queryAABB` / `raycast` behaviour in
//! `packages/spatial/src/bvh.ts`: longest-axis split, sort items by center
//! along that axis, split the sorted list in half, and re-check leaf bounds on
//! query. Each item carries an `id` (returned by queries) and its bounds.

use crate::aabb::Aabb;
use crate::vec3::Vec3;

/// `Math.max` semantics, which differ from Rust's `f64::max` on NaN: JS
/// propagates the NaN, Rust returns the non-NaN operand. The slab test below
/// must reject NaN geometry exactly the way the TS BVH does, or the two kernels
/// disagree on meshes with NaN coordinates.
#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min` semantics — see [`js_max`].
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// Slab-method ray/AABB test, operation for operation the TS
/// `BVH.rayIntersectsAABB`. Conservative: any box the ray truly enters at
/// `t >= 0` passes.
fn ray_intersects_aabb(origin: Vec3, direction: Vec3, aabb: &Aabb) -> bool {
    let mut tmin = f64::NEG_INFINITY;
    let mut tmax = f64::INFINITY;

    for i in 0..3 {
        if direction[i] == 0.0 {
            // Ray parallel to this axis' slab; reject if the origin is outside
            // it. Avoids 0 * Infinity = NaN poisoning tmin/tmax below.
            if origin[i] < aabb.min[i] || origin[i] > aabb.max[i] {
                return false;
            }
            continue;
        }
        let inv_d = 1.0 / direction[i];
        let mut t0 = (aabb.min[i] - origin[i]) * inv_d;
        let mut t1 = (aabb.max[i] - origin[i]) * inv_d;

        if inv_d < 0.0 {
            std::mem::swap(&mut t0, &mut t1);
        }

        tmin = js_max(tmin, t0);
        tmax = js_min(tmax, t1);

        if tmax < tmin {
            return false;
        }
    }

    tmax >= 0.0
}

struct Node {
    bounds: Aabb,
    left: Option<Box<Node>>,
    right: Option<Box<Node>>,
    /// Item ids for a leaf node; empty for internal nodes.
    ids: Vec<u32>,
}

/// A bounding-volume hierarchy over a set of `(id, bounds)` items.
pub struct Bvh {
    root: Option<Box<Node>>,
    bounds: Vec<Aabb>,
    ids: Vec<u32>,
}

impl Bvh {
    /// Build a BVH from `items` of `(id, bounds)`. `id` is what queries return.
    pub fn build(items: &[(u32, Aabb)]) -> Self {
        let bounds: Vec<Aabb> = items.iter().map(|&(_, b)| b).collect();
        let ids: Vec<u32> = items.iter().map(|&(id, _)| id).collect();
        let root = if items.is_empty() {
            None
        } else {
            let mut indices: Vec<usize> = (0..items.len()).collect();
            Some(build_node(&mut indices, &bounds))
        };
        Self { root, bounds, ids }
    }

    /// Return the ids of items whose bounds intersect `query`.
    pub fn query_aabb(&self, query: &Aabb) -> Vec<u32> {
        let mut results = Vec::new();
        if let Some(root) = &self.root {
            self.query_node(root, query, &mut results);
        }
        results
    }

    /// Return the ids of items whose bounds the ray from `origin` along
    /// `direction` may hit. Mirrors the TS `BVH.raycast`, including its
    /// normalisation of `direction` and its left-then-right traversal.
    pub fn raycast(&self, origin: Vec3, direction: Vec3) -> Vec<u32> {
        let mut results = Vec::new();
        let Some(root) = &self.root else {
            return results;
        };
        // Normalize direction. The only caller passes a vector that is already
        // exactly unit-length, so this is the identity there — it is kept so the
        // two BVH implementations stay line-for-line comparable.
        let len =
            (direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2])
                .sqrt();
        let dir = [direction[0] / len, direction[1] / len, direction[2] / len];
        self.raycast_node(root, origin, dir, &mut results);
        results
    }

    fn raycast_node(&self, node: &Node, origin: Vec3, direction: Vec3, results: &mut Vec<u32>) {
        if !ray_intersects_aabb(origin, direction, &node.bounds) {
            return;
        }
        if !node.ids.is_empty() {
            for &idx in &node.ids {
                if ray_intersects_aabb(origin, direction, &self.bounds[idx as usize]) {
                    results.push(self.ids[idx as usize]);
                }
            }
        } else {
            if let Some(left) = &node.left {
                self.raycast_node(left, origin, direction, results);
            }
            if let Some(right) = &node.right {
                self.raycast_node(right, origin, direction, results);
            }
        }
    }

    fn query_node(&self, node: &Node, query: &Aabb, results: &mut Vec<u32>) {
        if !node.bounds.intersects(query) {
            return;
        }
        if !node.ids.is_empty() {
            for &idx in &node.ids {
                if self.bounds[idx as usize].intersects(query) {
                    results.push(self.ids[idx as usize]);
                }
            }
        } else {
            if let Some(left) = &node.left {
                self.query_node(left, query, results);
            }
            if let Some(right) = &node.right {
                self.query_node(right, query, results);
            }
        }
    }
}

fn compute_bounds(indices: &[usize], bounds: &[Aabb]) -> Aabb {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &idx in indices {
        let b = &bounds[idx];
        for axis in 0..3 {
            if b.min[axis] < min[axis] {
                min[axis] = b.min[axis];
            }
            if b.max[axis] > max[axis] {
                max[axis] = b.max[axis];
            }
        }
    }
    Aabb::new(min, max)
}

fn build_node(indices: &mut [usize], bounds: &[Aabb]) -> Box<Node> {
    if indices.len() == 1 {
        let idx = indices[0];
        return Box::new(Node {
            bounds: bounds[idx],
            left: None,
            right: None,
            ids: vec![idx as u32],
        });
    }

    let node_bounds = compute_bounds(indices, bounds);

    // Choose split axis (longest axis), matching the TS tie-breaking exactly.
    let extent = [
        node_bounds.max[0] - node_bounds.min[0],
        node_bounds.max[1] - node_bounds.min[1],
        node_bounds.max[2] - node_bounds.min[2],
    ];
    let axis = if extent[0] > extent[1] && extent[0] > extent[2] {
        0
    } else if extent[1] > extent[2] {
        1
    } else {
        2
    };

    // Sort by center along axis. The TS comparator subtracts centers; a stable
    // sort by that key reproduces the same ordering.
    indices.sort_by(|&a, &b| {
        let ca = (bounds[a].min[axis] + bounds[a].max[axis]) / 2.0;
        let cb = (bounds[b].min[axis] + bounds[b].max[axis]) / 2.0;
        ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mid = indices.len() / 2;
    let (left_indices, right_indices) = indices.split_at_mut(mid);
    Box::new(Node {
        bounds: node_bounds,
        left: Some(build_node(left_indices, bounds)),
        right: Some(build_node(right_indices, bounds)),
        ids: Vec::new(),
    })
}
