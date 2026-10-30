// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The browser console summary of one geometry batch, formatted only from the
//! typed [`GeometryDiagnostics`] the batch returns (#8341 C4-12x), so the
//! console cannot report a number the contract does not.
//!
//! The policy this module fixes:
//! - Worst-failing hosts are `GeometryDiagnostics::worst_hosts` as built: at
//!   most `WORST_HOSTS_LIMIT` (16) hosts with at least one CSG failure, by
//!   failure count descending, ties by ascending product id.
//! - Failure reasons are `failures_by_reason`: count descending, ties by label.
//! - Silent no-ops are the contract's count, which excludes a host that also
//!   recorded a CSG failure (that host is already reported as a failure). The
//!   contract carries no per-host no-op detail, so the line is a count.
//! - A batch with nothing to report prints nothing.

use ifc_lite_geometry::GeometryDiagnostics;

/// The console method a summary line goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Level {
    /// `console.info`: engagement notes, shown in DevTools' default view.
    Info,
    /// `console.warn`: something a user investigating a model should see.
    Warn,
}

/// Every summary line for `d`, in emission order.
pub(super) fn console_summary(d: &GeometryDiagnostics) -> Vec<(Level, String)> {
    let mut lines = Vec::new();
    let classified = d.classification.total;
    if d.total_csg_failures > 0 {
        // "Failure" is the record channel, not "the kernel dropped a cut":
        // `CutterUnionUnavailable`, `PolygonalBoundedHalfSpaceFallback` and
        // #3440's open-topology record leave the cut applied. The reason
        // breakdown says which.
        lines.push((
            Level::Warn,
            format!(
                "[IFC-LITE] CSG diagnostics: {classified} openings classified, {} failures, {} hosts tracked",
                d.total_csg_failures, d.hosts_with_openings
            ),
        ));
    }
    if classified > 0 {
        let c = &d.classification;
        lines.push((
            Level::Info,
            format!(
                "[IFC-LITE] Opening classifier: rect={} diag={} non_rect={} (total={classified})",
                c.rectangular, c.diagonal, c.non_rectangular
            ),
        ));
    }
    if d.silent_no_ops > 0 {
        lines.push((Level::Warn, silent_no_op_line(d.silent_no_ops)));
    }
    if d.total_csg_failures > 0 {
        lines.push((Level::Warn, failure_detail(d)));
    } else if d.hosts_with_openings > 0 {
        lines.push((
            Level::Info,
            format!(
                "[IFC-LITE] Opening pipeline: 0 CSG failures. {} hosts with openings.",
                d.hosts_with_openings
            ),
        ));
    }
    if let Some(line) = rect_fast_line(d) {
        lines.push((Level::Info, line));
    }
    if d.oversized_ref_drops > 0 {
        // #3752: a content-hash reference above u32::MAX is refused (#3421).
        lines.push((
            Level::Warn,
            format!(
                "[IFC-LITE] {} content-hash reference(s) above the u32 express-id bound were refused (see issue #3421)",
                d.oversized_ref_drops
            ),
        ));
    }
    if d.total_unsupported_items > 0 {
        lines.push((Level::Warn, unsupported_line(d)));
    }
    lines
}

/// Rectangular cutters ran and the host mesh did not change, with no failure
/// recorded: usually an opening box that misses its host.
fn silent_no_op_line(hosts: u64) -> String {
    format!(
        "[IFC-LITE] Rectangular cut SILENT NO-OP on {hosts} hosts (rect boxes processed but mesh \
         unchanged, no CSG failure recorded; likely opening box doesn't intersect host)"
    )
}

/// The failure breakdown by reason and the worst-failing hosts.
fn failure_detail(d: &GeometryDiagnostics) -> String {
    let breakdown = d
        .failures_by_reason
        .iter()
        .map(|r| format!("{}={}", r.reason, r.count))
        .collect::<Vec<_>>()
        .join(", ");
    let hosts = if d.worst_hosts.is_empty() {
        "  (none)".to_string()
    } else {
        d.worst_hosts
            .iter()
            .map(|h| {
                format!(
                    "  #{} {} — {} openings, {} CSG failure(s) ({})",
                    h.product_id,
                    h.ifc_type,
                    h.openings,
                    h.csg_failures,
                    h.first_failure_label.as_deref().unwrap_or("?"),
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "[IFC-LITE] CSG fallbacks: {} failures across {} products. Breakdown: {breakdown}.\n\
         Worst-failing hosts ({} shown, by failures then id):\n{hosts}",
        d.total_csg_failures,
        d.products_with_failures,
        d.worst_hosts.len(),
    )
}

/// rect_fast engagement, when the fast path fired or deferred for a reason
/// worth seeing. Absent when no rectangular-opening host reached it.
fn rect_fast_line(d: &GeometryDiagnostics) -> Option<String> {
    let rf = &d.rect_fast;
    let engaged = rf.fired > 0
        || rf.defer_host_not_box > 0
        || rf.defer_not_through > 0
        || rf.defer_off_face > 0
        || rf.defer_near_edge > 0;
    engaged.then(|| {
        format!(
            "[IFC-LITE] rect_fast: fired={} (cut {} openings) | deferred: host_not_box={} \
             not_through={} off_face={} near_edge={}",
            rf.fired,
            rf.openings_cut,
            rf.defer_host_not_box,
            rf.defer_not_through,
            rf.defer_off_face,
            rf.defer_near_edge,
        )
    })
}

/// Dropped representation items, `type=count` in the contract's order (count
/// descending, ties by name), the same list `format_unsupported_breakdown`
/// gives the native warning.
fn unsupported_line(d: &GeometryDiagnostics) -> String {
    let breakdown = d
        .unsupported_items_by_type
        .iter()
        .map(|r| format!("{}={}", r.reason, r.count))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "[IFC-LITE] {} representation item(s) dropped (unsupported type or failed geometry) — \
         these elements are missing or incomplete: {breakdown}",
        d.total_unsupported_items
    )
}

#[cfg(test)]
#[path = "csg_console_tests.rs"]
mod tests;
