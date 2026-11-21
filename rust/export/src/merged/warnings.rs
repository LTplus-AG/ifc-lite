// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The diagnostics a finished merge reports in [`MergedStats::warnings`],
//! split out of `mod.rs` so the emit loop stays within its size budget.

use std::collections::{BTreeSet, HashMap, HashSet};

use super::MergedStats;

/// A later model can no longer unify onto a record the schema pass will prune.
pub(super) fn forget_omitted_guids(
    body: &str, schema: &str, seeds: &HashSet<u32>, omitted: &mut HashSet<u32>,
    guids: &mut HashMap<String, (u32, f64)>, emitted: &mut HashSet<String>,
) {
    if seeds.is_empty() {
        return;
    }
    let previous_count = omitted.len();
    omitted.extend(seeds.iter().copied());
    // Model offsets are disjoint. Only remaps to earlier models can carry an
    // omission across models, so scan this model against the known ids.
    let Some(dropped) = crate::schema_unrooted_upgrade::omitted_in_body(body, omitted, schema) else { return };
    if dropped.len() > previous_count {
        guids.retain(|guid, (id, _)| {
            if dropped.contains(id) {
                emitted.remove(guid);
                return false;
            }
            true
        });
    }
    *omitted = dropped;
}

pub(super) fn unmerged_tail(stats: &mut MergedStats, merged: usize, total: usize) {
    stats.unmerged_model_count = total - merged;
    stats.warnings.push(format!(
        "merged EXPRESS id space would exceed u32::MAX; stopped after {merged} model(s), {} model(s) not merged.",
        stats.unmerged_model_count
    ));
}

/// Push the merge-level warnings: federated models, oversized references
/// refused while resolving closures, and types kept unconverted.
pub(super) fn push_merge_warnings(
    stats: &mut MergedStats,
    refused_refs_total: usize,
    unrepresented_types_kept: BTreeSet<String>,
    schema: &str,
) {
    if stats.federated_model_count > 0 {
        stats.warnings.push(format!(
            "{} model(s) had an incompatible length unit and were federated as separate IfcProject instances (relaxing IfcSingleProjectInstance).",
            stats.federated_model_count
        ));
    }

    if refused_refs_total > 0 {
        // Issue #3421/#3752: a `#<digits>` reference above `u32::MAX` is
        // refused, not wrapped onto a real entity, while resolving which
        // ids a filtered/merged model reaches. The referenced record could
        // never itself be a real entity (every id in this store is also
        // `u32`-bound), so nothing reachable was excluded — this only says
        // at least one input file contains an express id ifc-lite cannot
        // represent.
        stats.warnings.push(format!(
            "{refused_refs_total} reference(s) above the u32 express-id bound were refused (see issue #3421) while resolving model reference closures."
        ));
    }

    if !unrepresented_types_kept.is_empty() {
        // #5116: kept pass-through, not proxied or dropped -- see the fallback in
        // the emit loop (`mod.rs`). Names every affected TYPE (not every occurrence) so this stays
        // readable on a large merge with many instances of the same type.
        stats.warnings.push(format!(
            "{} entity type(s) have no representation in {schema} and are not IfcRoot subtypes, \
             so the merge kept them unconverted instead of guessing (see issue #5116): {}.",
            unrepresented_types_kept.len(),
            unrepresented_types_kept.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
}


pub(super) fn finish_output(
    out: &mut String,
    stats: &mut MergedStats,
    schema: &str,
    slot_fill: &crate::schema_ifc2x3_slots::Ifc2x3SlotFill,
    checks: &crate::schema_enum::ConversionChecks,
    parents: super::single_parents::ParentClaims,
    upgrade_seeds: &std::collections::HashSet<u32>,
) {
    stats.warnings.extend(slot_fill.warnings());
    stats.warnings.extend(checks.warnings());
    stats.warnings.extend(parents.apply_folds(out)); // #5774 folds, after every model is written
    // One product per placement in IFC2X3 (#9209); the header holds no record to change.
    stats.written = stats.written.saturating_add_signed(crate::schema_ifc2x3_placements::place_text_for_schema(schema, out));
    if let Some((pruned, removed, losses)) = crate::schema_unrooted_upgrade::prune(out, upgrade_seeds, schema) {
        *out = pruned;
        stats.written -= removed;
        stats.warnings.extend(losses);
    }
    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
}
