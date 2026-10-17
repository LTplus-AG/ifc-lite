// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one spatial walk the export formats share (D48, EXPORT-DATA-16, C6-10).
//!
//! Export walks the raw aggregation and containment edges
//! (`ifc_lite_export::relationships().spatial_children`), not the server's
//! canonical hierarchy. The rule, for every format: pre-order depth first from
//! the project, children in SOURCE order, and the first parent to reach a node
//! owns it (a later edge to it is ignored). CSV did this, USD's recursive
//! emitter does this, and IFCX walked a stack whose siblings came out
//! reversed, so the same file listed its nodes in a different order per format.

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;

/// One node reached by [`walk`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpatialVisit {
    pub id: u32,
    /// The parent that reached it first; `None` for the root.
    pub parent: Option<u32>,
    /// Edges from the root.
    pub level: usize,
}

/// Every node reachable from `root`, in pre-order, source order, first parent
/// wins. Iterative, so the depth of a hostile file cannot overflow the stack;
/// each node is visited once, so a cycle ends.
pub fn walk<S: BuildHasher>(children: &HashMap<u32, Vec<u32>, S>, root: u32) -> Vec<SpatialVisit> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![SpatialVisit { id: root, parent: None, level: 0 }];
    while let Some(visit) = stack.pop() {
        if !visited.insert(visit.id) {
            continue;
        }
        out.push(visit);
        if let Some(kids) = children.get(&visit.id) {
            // Pushed reversed so the first child is popped, and so owned, first.
            for &kid in kids.iter() {
                if !visited.contains(&kid) {
                    stack.push(SpatialVisit { id: kid, parent: Some(visit.id), level: visit.level + 1 });
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "spatial_walk_tests.rs"]
mod tests;
