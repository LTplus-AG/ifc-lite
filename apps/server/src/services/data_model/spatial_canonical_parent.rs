// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cycle-safe canonical-parent resolution, split out of `spatial.rs` (same
//! reason `spatial_elevation.rs`, `spatial_invariant.rs` and `spatial_tree.rs`
//! already are: stay under the module-size ratchet). Mirrors
//! `packages/parser/src/spatial-hierarchy-canonical-parent.ts`, which split
//! the same concern out of `spatial-hierarchy-builder.ts` for the same
//! reason.

use super::super::types::Relationship;
use rustc_hash::{FxHashMap, FxHashSet};

/// Is `candidate_parent` reachable from `child_id` by walking forward
/// `IFCRELAGGREGATES` edges (i.e. is `child_id` an ANCESTOR of
/// `candidate_parent` in the raw, unresolved aggregation graph)? Mirrors
/// `packages/parser/src/spatial-hierarchy-canonical-parent.ts`'s
/// `formsCycleThroughChild` (#4246): used only to disqualify a tied
/// candidate parent that would close a cycle back through the child itself -
/// the STEP-authoring-tool mistake of declaring an aggregation pair in both
/// directions (or, one hop longer, an indirect A -> B -> C -> A chain).
/// Bounded to `child_id`'s own raw aggregation subtree, so it only costs
/// anything on an already-malformed file where a child has more than one
/// candidate Aggregates parent - the common case (one candidate) never calls
/// this.
fn forms_cycle_through_child(
    child_id: u32,
    candidate_parent: u32,
    raw_aggregates_children: &FxHashMap<u32, Vec<u32>>,
) -> bool {
    let mut visited: FxHashSet<u32> = FxHashSet::default();
    visited.insert(child_id);
    let mut stack = vec![child_id];
    while let Some(current) = stack.pop() {
        if let Some(kids) = raw_aggregates_children.get(&current) {
            for &kid in kids {
                if kid == candidate_parent {
                    return true;
                }
                if visited.insert(kid) {
                    stack.push(kid);
                }
            }
        }
    }
    false
}

/// Resolve each spatial child's ONE canonical `IFCRELAGGREGATES` parent,
/// globally, from the raw relationship list. Plain first-declared-wins,
/// EXCEPT that a candidate closing a cycle back through the child is skipped
/// first (#4246) - a mutual or longer aggregation back-edge (a
/// STEP-authoring-tool mistake: a parent/child pair declared in both
/// directions) cannot win a tie against a candidate that doesn't orphan the
/// child's own subtree from itself. Falls through to plain first-declared if
/// every candidate closes a cycle, so a child is never left without a
/// parent. Mirrors
/// `packages/parser/src/spatial-hierarchy-canonical-parent.ts`'s
/// `computeCanonicalParent`.
///
/// Only resolves `IFCRELAGGREGATES` edges; the
/// `IFCRELCONTAINEDINSPATIALSTRUCTURE` promotion (a spatial-structure target
/// with no Aggregates edge at all, #1075) is layered on top by the caller in
/// `spatial.rs`, same as before this split.
pub(super) fn resolve_aggregate_canonical_parents(
    relationships: &[Relationship],
) -> FxHashMap<u32, u32> {
    // Raw (unresolved) forward IFCRELAGGREGATES edges, parent -> children, in
    // file-declaration order. Used only by `forms_cycle_through_child` above
    // to detect a spurious back-edge; distinct from the returned map, which
    // holds the single resolved winner per child.
    let mut raw_aggregates_children: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    // Candidate parents named for each child by an IFCRELAGGREGATES edge, in
    // file-declaration order (mirrors `edges` in the TS `computeCanonicalParent`).
    let mut aggregate_candidates: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for rel in relationships {
        if rel.rel_type.to_uppercase() == "IFCRELAGGREGATES" {
            raw_aggregates_children
                .entry(rel.relating_id)
                .or_default()
                .push(rel.related_id);
            aggregate_candidates
                .entry(rel.related_id)
                .or_default()
                .push(rel.relating_id);
        }
    }

    let mut canonical_parent: FxHashMap<u32, u32> = FxHashMap::default();
    for (&child_id, candidates) in &aggregate_candidates {
        let mut winner = candidates[0];
        if candidates.len() > 1 {
            if let Some(&non_cyclic) = candidates.iter().find(|&&candidate| {
                !forms_cycle_through_child(child_id, candidate, &raw_aggregates_children)
            }) {
                if non_cyclic != winner {
                    tracing::warn!(
                        child_id,
                        kept_parent = non_cyclic,
                        first_declared_parent = winner,
                        "Ignored an aggregation back-edge cycle in spatial hierarchy"
                    );
                }
                winner = non_cyclic;
            }
            // else: every candidate closes a cycle back through the child -
            // fall through to plain first-declared so it is never left
            // without a parent.
        }
        canonical_parent.insert(child_id, winner);
    }
    canonical_parent
}
