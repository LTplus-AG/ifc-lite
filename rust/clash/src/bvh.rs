// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Simple median-split AABB BVH for spatial queries.
//!
//! Faithful port of the `build` / `queryAABB` behaviour in
//! `packages/spatial/src/bvh.ts`: longest-axis split, sort items by center
//! along that axis, split the sorted list in half, and re-check leaf bounds on
//! query. Each item carries an `id` (returned by queries) and its bounds.

use crate::aabb::Aabb;

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
