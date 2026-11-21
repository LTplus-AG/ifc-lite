// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::BoolFailure;
use rustc_hash::FxHashMap;

use super::{
    count_attributed_products, unsupported_items, BudgetRefusal, ClassificationStats,
    ClassificationSummary, GeometryDiagnostics, HostBbox, HostOpeningDiagnostic, ReasonCount,
    RectFastSummary, WorstHost, LEGACY_CUT_SCHEMA_VERSION,
};

/// Build a v5 [`GeometryDiagnostics`] from drained router data and triangle counts.
/// Producers with measured cuts attach their count with
/// [`GeometryDiagnostics::with_measured_silent_no_ops`].
/// The caller owns draining: the router accessors are destructive (`mem::take`),
/// so drain once and pass the results here — do not double-`take`.
/// `budget_refusals` is [`GeometryRouter::take_budget_refusal_report`]'s
/// (total, details). It is required, so a caller cannot build diagnostics
/// without deciding what refusals to pass; like the other inputs, take it
/// once (a second take, or an earlier `take_budget_refusals`, finds it empty).
///
/// [`GeometryRouter::take_budget_refusal_report`]: crate::GeometryRouter::take_budget_refusal_report
#[allow(clippy::too_many_arguments)] // one argument per drained router collector
pub fn aggregate_diagnostics(
    classification: ClassificationStats,
    csg_failures: &FxHashMap<u32, Vec<BoolFailure>>,
    host_diags: &FxHashMap<u32, HostOpeningDiagnostic>,
    rect_fast: crate::rect_fast::RectFastStats,
    worst_hosts_limit: usize,
    oversized_ref_drops: u64,
    unsupported_items: &FxHashMap<String, u64>,
    budget_refusals: (u64, Vec<BudgetRefusal>),
) -> GeometryDiagnostics {
    let (total_budget_refusals, budget_refusals) = budget_refusals;
    let total_csg_failures = csg_failures.values().map(Vec::len).sum::<usize>() as u64;
    let products_with_failures = count_attributed_products(csg_failures);
    let hosts_with_openings = host_diags.len() as u64;

    let classification = ClassificationSummary {
        rectangular: classification.rectangular as u64,
        diagonal: classification.diagonal as u64,
        non_rectangular: classification.non_rectangular as u64,
        total: (classification.rectangular
            + classification.diagonal
            + classification.non_rectangular) as u64,
    };

    let mut by_reason: FxHashMap<&'static str, u64> = FxHashMap::default();
    for fails in csg_failures.values() {
        for f in fails {
            *by_reason.entry(f.reason.label()).or_insert(0) += 1;
        }
    }
    let mut failures_by_reason: Vec<ReasonCount> = by_reason
        .into_iter()
        .map(|(reason, count)| ReasonCount { reason: reason.to_string(), count })
        .collect();
    failures_by_reason
        .sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));

    let (total_unsupported_items, unsupported_items_by_type) =
        unsupported_items::summarize(unsupported_items);

    let silent_no_ops = host_diags
        .values()
        .filter(|hd| {
            // Count-only callers supply the triangle-count estimate.
            // Native and browser execution use geometry measurements from the cut.
            matches!((hd.tris_before, hd.tris_after), (Some(b), Some(a)) if b == a)
                && hd.rect_boxes_processed > 0
                && hd.csg_failure_count == 0
        })
        .count() as u64;

    let mut worst: Vec<(&u32, &HostOpeningDiagnostic)> = host_diags
        .iter()
        .filter(|(_, hd)| hd.csg_failure_count > 0)
        .collect();
    worst.sort_by(|a, b| {
        b.1.csg_failure_count.cmp(&a.1.csg_failure_count).then_with(|| a.0.cmp(b.0))
    });
    let worst_hosts: Vec<WorstHost> = worst
        .into_iter()
        .take(worst_hosts_limit)
        .map(|(pid, hd)| WorstHost {
            product_id: *pid,
            ifc_type: hd.host_type.clone(),
            openings: hd.openings.len() as u64,
            csg_failures: hd.csg_failure_count as u64,
            first_failure_label: hd.first_failure_label.clone(),
            bbox: hd.host_bounds.map(|(min, max)| HostBbox {
                min: [min.0, min.1, min.2],
                max: [max.0, max.1, max.2],
            }),
            triangle_count: hd.tris_after.or(hd.tris_before).map(|t| t as u64),
        })
        .collect();

    GeometryDiagnostics {
        schema_version: LEGACY_CUT_SCHEMA_VERSION,
        total_csg_failures,
        products_with_failures,
        hosts_with_openings,
        classification,
        failures_by_reason,
        silent_no_ops,
        rect_fast: RectFastSummary {
            fired: rect_fast.fired,
            openings_cut: rect_fast.openings_cut,
            defer_host_not_box: rect_fast.defer_host_not_box,
            defer_not_through: rect_fast.defer_not_through,
            defer_off_face: rect_fast.defer_off_face,
            defer_near_edge: rect_fast.defer_near_edge,
            defer_no_openings: rect_fast.defer_no_openings,
            defer_too_many_openings: rect_fast.defer_too_many_openings,
        },
        worst_hosts,
        oversized_ref_drops,
        total_unsupported_items,
        unsupported_items_by_type,
        budget_refusals,
        total_budget_refusals,
    }
}
