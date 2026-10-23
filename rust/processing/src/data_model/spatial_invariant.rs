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
use std::collections::VecDeque;

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
///
/// #4022 widened this from purely local edge consistency to two global
/// checks (see [`reachability_and_depth_violations`]): every node must be
/// reachable from a root by walking `children_ids`, and a reachable node's
/// `level` must equal its actual depth from that walk. A third candidate
/// class - requiring exactly one root - is deliberately NOT enforced:
/// `DISCONNECTED_SITE_AGGREGATES_BUILDING_IFC` in `tests.rs` legitimately
/// produces two independent `parent_id == 0` nodes (the true `IfcProject`
/// and a rescued orphan promoted to a fake root because it has no reachable
/// canonical parent), so a hard root-uniqueness rule would fire on valid
/// output rather than a defect. A model with a second root that is fully
/// disconnected from the real tree - internally consistent, reachable
/// on its own, but never reachable from the real root - still passes every
/// clause here; ruling that out needs a way to tell a legitimate rescued
/// island apart from a genuine second tree, which none of the clauses below
/// (or #3973's fixes) has any information to do.
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

    violations.extend(reachability_and_depth_violations(nodes, &by_id));

    violations
}

/// Global check, added for #4022: BFS every `children_ids` edge starting
/// from every node whose `parent_id` is the sentinel `0` (there can
/// legitimately be more than one, see the module doc above), tracking depth
/// as it goes. Any node the walk never reaches is flagged - this is what
/// catches a cycle isolated from every root (e.g. two nodes that are each
/// other's parent and only listed child: each satisfies the local clauses
/// above, but neither has a `parent_id == 0` node in its ancestry, so
/// neither is ever enqueued). Any node the walk does reach has its `level`
/// compared against the depth the walk assigned it, catching a `level` that
/// disagrees with the node's actual position in the tree.
///
/// This does not - and structurally cannot - detect a second root that is
/// itself internally well-formed and reachable purely from itself: it is
/// indistinguishable, by this walk, from a legitimate rescued-orphan island
/// (see the module doc above), so it is out of scope for this clause.
fn reachability_and_depth_violations(
    nodes: &[&SpatialNode],
    by_id: &FxHashMap<u32, &&SpatialNode>,
) -> Vec<String> {
    let mut visited: FxHashMap<u32, u16> = FxHashMap::default();
    let mut queue: VecDeque<(u32, u16)> = nodes
        .iter()
        .filter(|n| n.parent_id == 0)
        .map(|n| (n.entity_id, 0))
        .collect();

    while let Some((id, depth)) = queue.pop_front() {
        if visited.contains_key(&id) {
            continue;
        }
        visited.insert(id, depth);
        if let Some(node) = by_id.get(&id) {
            for &child_id in &node.children_ids {
                if !visited.contains_key(&child_id) {
                    queue.push_back((child_id, depth + 1));
                }
            }
        }
    }

    let mut violations = Vec::new();
    for node in nodes {
        match visited.get(&node.entity_id) {
            None => violations.push(format!(
                "node #{} is unreachable from any root (a node with parent_id 0) by walking \
                 children_ids - it may be part of a cycle isolated from the rest of the tree",
                node.entity_id
            )),
            Some(&depth) if depth != node.level => violations.push(format!(
                "node #{} has level {}, but walking children_ids from its root puts it at depth {depth}",
                node.entity_id, node.level
            )),
            Some(_) => {}
        }
    }

    violations
}

#[cfg(test)]
#[path = "spatial_invariant_tests.rs"]
mod spatial_invariant_tests;
