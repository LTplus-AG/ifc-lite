// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The drop plan's view of the one-parent pass (#5725, #5802); see
//! [`StructureClaims`].

use std::collections::{HashMap, HashSet};

use super::super::plan::ModelIndex;
use super::super::spatial::nth_attr;
use super::ref_list;

/// The one-parent pass's view of the structure relationships, for the drop plan
/// (#5725, #5802): the emit loop withholds an aggregation edge whose child
/// already has a written parent (`single_parents`), and a container that loses
/// its only edge that way is empty. Only `IfcRelAggregates` is a structure
/// relationship with a single-valued inverse there, as in the TypeScript twin.
///
/// The drops must be known before emission, and this pass runs with none
/// applied. That is already the fixed point: a claim that would differ once
/// drops are known needs a dropped parent, but a parent whose kept edge reaches
/// a kept child is kept itself. It holds only if this pass never withholds an
/// edge the emit loop writes, or a still-full child loses its only parent, so
/// it may see LESS than the emit loop, never more. It resolves ids through the
/// spatial remap only (which the emit loop repeats exactly), not through
/// GlobalId reconciliation, which the drop plan cannot reproduce here. What it
/// misses is an edge the emit loop withholds and this pass counts, which only
/// keeps a container (#3643's behaviour before #5725). The TypeScript twin is
/// `claimParents` in `merged-empty-containers.ts`.
#[derive(Default)]
pub(super) struct StructureClaims {
    decomposes: HashSet<u32>,
}

impl StructureClaims {
    /// Record this model's aggregation members (final ids) and return the
    /// `(rel, child)` edges the emit loop will withhold, when `dedupe` (a later,
    /// unified model) makes an already-claimed child redundant.
    pub(super) fn withheld(
        &mut self,
        index: &ModelIndex,
        included: &HashSet<u32>,
        remap: &HashMap<u32, u32>,
        base: u32,
        dedupe: bool,
    ) -> HashSet<(u32, u32)> {
        let mut withheld = HashSet::new();
        for &id in &index.order {
            if !included.contains(&id) {
                continue;
            }
            if index.type_of.get(&id).map(String::as_str) != Some("IFCRELAGGREGATES") {
                continue;
            }
            let Some(line) = index.line_str(id) else { continue };
            let children: Vec<(u32, u32)> = nth_attr(&line, 5)
                .map(ref_list)
                .unwrap_or_default()
                .into_iter()
                .filter(|child| included.contains(child))
                .map(|child| (child, remap.get(&child).copied().unwrap_or(child.saturating_add(base))))
                .collect();
            // Judged against the claims made BEFORE this rel, as the emit loop
            // does: a member listed twice in one rel is not redundant with itself.
            if dedupe {
                withheld.extend(
                    children.iter().filter(|(_, f)| self.decomposes.contains(f)).map(|&(child, _)| (id, child)),
                );
            }
            self.decomposes.extend(children.iter().map(|&(_, f)| f));
        }
        withheld
    }
}

#[cfg(test)]
#[path = "empty_claims_tests.rs"]
mod tests;
