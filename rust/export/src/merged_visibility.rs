// SPDX-License-Identifier: MPL-2.0
//! Per-model visibility filtering for the merged (federated) STEP exporter.
//!
//! Mirrors the ROLE `StepOptions.included` plays for single-model export
//! (`step.rs`): a caller-supplied root set plus a forward-`#`-reference
//! closure. Two things the single-model path doesn't need, that a
//! multi-model federation does:
//!
//! - An explicit `excluded` id set the closure must never walk INTO — so a
//!   hidden product's geometry can't re-enter through a relationship that
//!   also names it. This is `merged-exporter.ts`'s `hiddenProductIds`
//!   (`computeIncludedEntityIds`, `reference-collector.ts:865` builds it,
//!   `reference-collector.ts:379`'s `excludeIds` param consumes it).
//! - A pass that drops a KEPT relationship (`IFCREL*`) entity outright when
//!   any id it names is not in the kept set, rather than emitting the
//!   relationship's original bytes with a now-dangling `#ref`. The real JS
//!   exporter instead NARROWS the relationship's SET/LIST attribute to its
//!   surviving members (`relationshipRefsSurviveExclusion`,
//!   `filterHiddenRefsFromRelationshipLine` in `step-exporter.ts`) — this
//!   repo's Rust side has no per-attribute-group parser for STEP lines
//!   (`refs_in_line` only extracts a flat list of `#id`s), so narrowing one
//!   list while keeping the rest of the line is not available here yet.
//!   Dropping the whole relationship is strictly more conservative than
//!   narrowing (it can only under-connect, never dangle), and this repo has
//!   already shipped the dangling-reference shape once (#2398), so
//!   correctness is chosen over completeness for this increment.

use crate::step_text::refs_in_line;
use std::collections::{HashMap, HashSet};

/// One model's visibility filter for merged export.
///
/// `roots: vec![]` with `excluded: vec![]` means exactly what it says —
/// nothing survives from this model (an explicit empty allowlist), which is
/// a different outcome than omitting the filter entirely (which includes the
/// model in full). Callers are expected to pass the SAME root ids the JS
/// `computeIncludedEntityIds` (`merged-exporter.ts:994`) would select for a
/// `visibleOnly` export of this model on its own — infrastructure, spatial
/// structure, and every `IFCREL*` entity are always roots there; this module
/// does not re-derive that classification, it only closes and dedangles
/// whatever root/excluded sets it is given.
#[derive(Debug, Default, Clone)]
pub struct VisibilityFilter {
    pub roots: Vec<u32>,
    pub excluded: Vec<u32>,
}

/// Walk the forward `#`-reference closure from `roots`, refusing to enqueue
/// (or keep) any id in `excluded`, or any id absent from `by_id` entirely (a
/// ref to nothing, e.g. one already dangling in the source, is left exactly
/// as absent as it started).
fn forward_closure(
    roots: &[u32],
    excluded: &HashSet<u32>,
    by_id: &HashMap<u32, (&str, &[u8])>,
) -> HashSet<u32> {
    let mut keep: HashSet<u32> = HashSet::new();
    let mut stack: Vec<u32> = roots.to_vec();
    let mut refs: Vec<u32> = Vec::new();
    while let Some(id) = stack.pop() {
        if excluded.contains(&id) || !by_id.contains_key(&id) {
            continue;
        }
        if !keep.insert(id) {
            continue;
        }
        let (_, bytes) = by_id[&id];
        refs.clear();
        refs_in_line(bytes, &mut refs);
        for &r in &refs {
            if !excluded.contains(&r) && !keep.contains(&r) && by_id.contains_key(&r) {
                stack.push(r);
            }
        }
    }
    keep
}

/// Kept `IFCREL*` ids in `keep` that name an id NOT in `keep` — these would
/// dangle if their original bytes were emitted verbatim.
fn dangling_relationship_ids(keep: &HashSet<u32>, by_id: &HashMap<u32, (&str, &[u8])>) -> Vec<u32> {
    let mut refs: Vec<u32> = Vec::new();
    let mut dangling = Vec::new();
    for &id in keep {
        let (ty, bytes) = by_id[&id];
        if !ty.starts_with("IFCREL") {
            continue;
        }
        refs.clear();
        refs_in_line(bytes, &mut refs);
        if refs.iter().any(|r| by_id.contains_key(r) && !keep.contains(r)) {
            dangling.push(id);
        }
    }
    dangling
}

/// Compute the kept express-id set for one model's lines under `filter`.
///
/// `lines` is `(express_id, type_name, line_bytes)` for every entity in the
/// model, in source order — the same shape `export_merged_with_stats`
/// already collects. Fixpoint of two steps:
///
/// 1. [`forward_closure`] from `filter.roots`, excluding `filter.excluded`.
/// 2. [`dangling_relationship_ids`] — any kept `IFCREL*` naming an id outside
///    the kept set is added to the excluded set and dropped from the root
///    list, and the closure is recomputed. Excluding (not just removing) the
///    dropped relationship's own id ensures anything reachable ONLY through
///    it — e.g. a property set exclusively attached by that one relationship
///    — is pruned too, rather than surviving as an orphan the next model
///    reload can no longer explain. Terminates because the excluded set only
///    grows and is bounded by the model's entity count.
pub fn compute_keep_set(lines: &[(u32, &str, &[u8])], filter: &VisibilityFilter) -> HashSet<u32> {
    let mut by_id: HashMap<u32, (&str, &[u8])> = HashMap::with_capacity(lines.len());
    for &(id, ty, bytes) in lines {
        by_id.entry(id).or_insert((ty, bytes));
    }

    let mut excluded: HashSet<u32> = filter.excluded.iter().copied().collect();
    let mut roots: Vec<u32> = filter.roots.clone();

    loop {
        let keep = forward_closure(&roots, &excluded, &by_id);
        let dangling = dangling_relationship_ids(&keep, &by_id);
        if dangling.is_empty() {
            return keep;
        }
        for id in dangling {
            excluded.insert(id);
            roots.retain(|&r| r != id);
        }
    }
}

#[cfg(test)]
#[path = "merged_visibility_tests.rs"]
mod tests;
