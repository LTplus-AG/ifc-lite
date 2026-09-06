// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structural invariant over a finished spatial-node set, split out of
//! `spatial.rs` to stay under the module-size ratchet (the same reason
//! `spatial_tree.rs` and `spatial_elevation.rs` exist).
//!
//! #3973 fixed the same defect shape twice, pointwise, in two different
//! code paths: a dangling `children_ids` entry naming an entity with no
//! corresponding node in `nodes_map` (first a depth-capped node resurrected
//! as a fake root, then a rescued orphan's `children_ids` populated straight
//! from `spatial_children_map` with no filtering). Each fix closed one path
//! into the tree without ruling the shape out structurally, so this checks
//! the finished tree instead of any one code path.

use super::super::types::SpatialNode;
use rustc_hash::FxHashMap;

/// Check a finished node set for the dangling-reference shape #3973 fixed
/// twice pointwise: (a) every id in every node's `children_ids` must resolve
/// to a node in the set, (b) every node's `parent_id` must either resolve to
/// a node or be the root sentinel (`0` - never a real STEP entity id), and
/// (c) the two directions must agree - `A.children_ids` containing `B` and
/// `B.parent_id == A` are two representations of the same fact. Clause (c)
/// is the one that actually catches the family: a fake root with a real
/// parent_id disagreement passes (a) and (b) - it names no nonexistent id
/// and has a resolvable-or-sentinel parent - while still being wrong.
///
/// Called from both `build_spatial_hierarchy`'s own `debug_assert!` and the
/// test suite (`super::spatial::spatial_hierarchy_consistency_violations`),
/// so this is the single place either has to change.
pub(crate) fn spatial_hierarchy_consistency_violations(nodes: &[&SpatialNode]) -> Vec<String> {
    let by_id: FxHashMap<u32, &&SpatialNode> = nodes.iter().map(|n| (n.entity_id, n)).collect();
    let mut violations = Vec::new();

    for node in nodes {
        for &child_id in &node.children_ids {
            match by_id.get(&child_id) {
                None => violations.push(format!(
                    "node #{} lists child #{child_id} in children_ids, but no node #{child_id} exists",
                    node.entity_id
                )),
                Some(child) if child.parent_id != node.entity_id => violations.push(format!(
                    "node #{} lists child #{child_id} in children_ids, but #{child_id}.parent_id is #{} (expected #{})",
                    node.entity_id, child.parent_id, node.entity_id
                )),
                Some(_) => {}
            }
        }

        if node.parent_id != 0 {
            match by_id.get(&node.parent_id) {
                None => violations.push(format!(
                    "node #{} has parent_id #{}, but no node #{} exists",
                    node.entity_id, node.parent_id, node.parent_id
                )),
                Some(parent) if !parent.children_ids.contains(&node.entity_id) => {
                    violations.push(format!(
                        "node #{} has parent_id #{}, but #{}.children_ids does not list #{}",
                        node.entity_id, node.parent_id, node.parent_id, node.entity_id
                    ))
                }
                Some(_) => {}
            }
        }
    }

    violations
}
