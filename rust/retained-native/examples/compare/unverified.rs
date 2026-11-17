// SPDX-License-Identifier: MPL-2.0
//! #7955: what the comparison could not verify, and what a ruling would read. Counts only:
//! a gated row stays in `violations`.
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Results that say the oracle produced no expectation: never a pass, wherever they gate.
const UNVERIFIED_FAMILIES: [&str; 6] = ["layerSourceAvailable", "clipSourceReadable", "clipSectionAvailable",
    "bounded_chain_unmodelled", "bounded_linear_volume_unavailable", "bounded_curved_volume_unavailable"];
/// M5 has no section for a mixed chain or an unmodelled host. M6's covers the whole single-item
/// body when it has one; another part's M5 section says nothing about this part.
const CLIP_GAPS: [&str; 2] = ["clipSectionMixedSubtree", "clipVolumeBoundsUnavailable"];
pub(super) fn says_unverified(family: &str, results: &[super::super::checks::OracleResult]) -> bool {
    UNVERIFIED_FAMILIES.contains(&family) || CLIP_GAPS.contains(&family)
        && !results.iter().any(|r| matches!(r.family, "bounded_section_volume" | "bounded_hand_volume"))
}
/// Closure defects on face sets, by the authored `Closed` and whether the source rows
/// themselves leave edges open. The defects stay gated: this is what a ruling would read.
pub(super) fn face_set_closure_summary(rows: &[Value]) -> Value {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in rows {
        // No authored set read: the source said nothing, so neither answer is claimed.
        let source = if row["closed"].as_str().is_none_or(str::is_empty) { "sourceRowsUnread" }
            else if row["sourceOpenEdges"].as_f64().unwrap_or(0.) > 0. { "sourceRowsOpen" } else { "sourceRowsClosed" };
        *counts.entry(format!("{} {source}", row["closed"].as_str().unwrap_or("?"))).or_default() += 1;
    }
    json!({"count": rows.len(), "gated": true, "byDeclaredClosed": counts, "products": rows})
}
/// Counts by family and reason, so a report never reads an absent expectation as a pass.
pub(super) fn unverified_summary(rows: &[Value]) -> Value {
    let mut counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for row in rows {
        *counts.entry(row["family"].as_str().unwrap_or_default().to_owned()).or_default()
            .entry(row["reason"].as_str().unwrap_or("unnamed").to_owned()).or_default() += 1;
    }
    json!({"count": rows.len(), "gated": rows.iter().filter(|r| r["gated"] == true).count(), "byFamily": counts, "products": rows})
}
