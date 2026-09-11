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

/// Upper bound on aggregate-graph node visits spent on back-edge cycle checks
/// for one upload. The check only runs for children named by MORE THAN ONE
/// `IFCRELAGGREGATES` (already malformed) and costs one descendant walk per
/// such child - O(V+E) each - so a crafted upload with thousands of contested
/// children could otherwise hold a blocking worker for O(C·(V+E)). Past the
/// budget the resolver falls back to plain first-declared-wins and logs once.
/// Mirrors `CYCLE_CHECK_VISIT_BUDGET` in
/// `packages/parser/src/spatial-hierarchy-canonical-parent.ts`.
pub(super) const CYCLE_CHECK_VISIT_BUDGET: u64 = 2_000_000;

/// Aggregated descendants of `child_id` (transitive, forward
/// `IFCRELAGGREGATES`), charged against `budget`. `None` when the budget ran
/// out mid-walk: a partial set must not be used, since a missing descendant
/// reads as "no cycle" - the wrong side to err on. Used only to disqualify a
/// tied candidate parent that would close a cycle back through the child
/// itself (#4246: the STEP-authoring-tool mistake of declaring an aggregation
/// pair in both directions, or an indirect A -> B -> C -> A chain) - the
/// common case (one candidate) never calls this. Mirrors
/// `packages/parser/src/spatial-hierarchy-canonical-parent.ts`'s
/// `aggregatedDescendants`.
fn aggregated_descendants(
    child_id: u32,
    raw_aggregates_children: &FxHashMap<u32, Vec<u32>>,
    budget: &mut u64,
) -> Option<FxHashSet<u32>> {
    let mut visited: FxHashSet<u32> = FxHashSet::default();
    visited.insert(child_id);
    let mut stack = vec![child_id];
    while let Some(current) = stack.pop() {
        if let Some(kids) = raw_aggregates_children.get(&current) {
            for &kid in kids {
                if *budget == 0 {
                    return None;
                }
                *budget -= 1;
                if visited.insert(kid) {
                    stack.push(kid);
                }
            }
        }
    }
    Some(visited)
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
pub(in crate::services::data_model) fn resolve_aggregate_canonical_parents(
    relationships: &[Relationship],
) -> FxHashMap<u32, u32> {
    resolve_aggregate_canonical_parents_with_budget(relationships, CYCLE_CHECK_VISIT_BUDGET)
}

pub(in crate::services::data_model) fn resolve_aggregate_canonical_parents_with_budget(
    relationships: &[Relationship],
    cycle_check_visit_budget: u64,
) -> FxHashMap<u32, u32> {
    // Raw (unresolved) forward IFCRELAGGREGATES edges, parent -> children, in
    // file-declaration order. Used only by `aggregated_descendants` above
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
    let mut budget = cycle_check_visit_budget;
    let mut budget_exhausted = false;
    for (&child_id, candidates) in &aggregate_candidates {
        let mut winner = candidates[0];
        if candidates.len() > 1 && !budget_exhausted {
            // One descendant walk per contested child (not per candidate),
            // under the upload-wide visit budget.
            match aggregated_descendants(child_id, &raw_aggregates_children, &mut budget) {
                None => {
                    budget_exhausted = true;
                    tracing::warn!(
                        budget = cycle_check_visit_budget,
                        "Aggregation back-edge cycle checks stopped: visit budget spent; remaining multi-parent children resolve first-declared"
                    );
                }
                Some(descendants) => {
                    let rejected: Vec<u32> = candidates
                        .iter()
                        .copied()
                        .filter(|candidate| descendants.contains(candidate))
                        .collect();
                    if let Some(&non_cyclic) =
                        candidates.iter().find(|candidate| !descendants.contains(candidate))
                    {
                        if non_cyclic != winner {
                            tracing::warn!(
                                child_id,
                                kept_parent = non_cyclic,
                                rejected_cyclic_parents = ?rejected,
                                "Ignored aggregation back-edge cycle(s) in spatial hierarchy"
                            );
                        }
                        winner = non_cyclic;
                    }
                    // else: every candidate closes a cycle back through the
                    // child - fall through to plain first-declared so it is
                    // never left without a parent.
                }
            }
        }
        canonical_parent.insert(child_id, winner);
    }
    canonical_parent
}
