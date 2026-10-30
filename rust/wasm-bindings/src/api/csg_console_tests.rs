// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8341 C4-12x: the console summary is a rendering of `GeometryDiagnostics`.
//! The text is pinned because it is what a user reads in DevTools.

use super::{console_summary, Level};
use ifc_lite_geometry::{
    aggregate_diagnostics, BoolFailure, BoolFailureReason, BoolOp, ClassificationStats,
    ClassificationSummary, GeometryDiagnostics, HostOpeningDiagnostic, RectFastStats, RectFastSummary, ReasonCount, WorstHost,
};
use rustc_hash::FxHashMap;

const WORST_HOSTS_LIMIT: usize = 16;

fn reason(reason: &str, count: u64) -> ReasonCount {
    ReasonCount { reason: reason.to_string(), count }
}

fn worst(product_id: u32, ifc_type: &str, csg_failures: u64, label: Option<&str>) -> WorstHost {
    WorstHost {
        product_id,
        ifc_type: ifc_type.to_string(),
        openings: 2,
        csg_failures,
        first_failure_label: label.map(str::to_string),
        bbox: None,
        triangle_count: None,
    }
}

#[test]
fn a_clean_batch_prints_nothing() {
    assert!(console_summary(&GeometryDiagnostics::default()).is_empty());
}

#[test]
fn every_line_is_formatted_from_the_contract() {
    let d = GeometryDiagnostics {
        total_csg_failures: 4,
        products_with_failures: 2,
        hosts_with_openings: 3,
        classification: ClassificationSummary { rectangular: 5, diagonal: 1, non_rectangular: 2, total: 8 },
        failures_by_reason: vec![reason("EmptyOperand", 3), reason("KernelError", 1)],
        silent_no_ops: 1,
        rect_fast: RectFastSummary { fired: 2, openings_cut: 4, defer_near_edge: 1, ..RectFastSummary::default() },
        worst_hosts: vec![worst(42, "IfcWall", 3, Some("EmptyOperand")), worst(7, "IfcSlab", 1, None)],
        oversized_ref_drops: 2,
        total_unsupported_items: 3,
        unsupported_items_by_type: vec![reason("IfcTextLiteral", 2), reason("IfcAnnotationFillArea", 1)],
        ..GeometryDiagnostics::default()
    };

    let expected = vec![
        (Level::Warn, "[IFC-LITE] CSG diagnostics: 8 openings classified, 4 failures, 3 hosts tracked"),
        (Level::Info, "[IFC-LITE] Opening classifier: rect=5 diag=1 non_rect=2 (total=8)"),
        (
            Level::Warn,
            "[IFC-LITE] Rectangular cut SILENT NO-OP on 1 hosts (rect boxes processed but mesh \
             unchanged, no CSG failure recorded; likely opening box doesn't intersect host)",
        ),
        (
            Level::Warn,
            "[IFC-LITE] CSG fallbacks: 4 failures across 2 products. Breakdown: EmptyOperand=3, KernelError=1.\n\
             Worst-failing hosts (2 shown, by failures then id):\n\
             \x20 #42 IfcWall — 2 openings, 3 CSG failure(s) (EmptyOperand)\n\
             \x20 #7 IfcSlab — 2 openings, 1 CSG failure(s) (?)",
        ),
        (
            Level::Info,
            "[IFC-LITE] rect_fast: fired=2 (cut 4 openings) | deferred: host_not_box=0 not_through=0 off_face=0 near_edge=1",
        ),
        (
            Level::Warn,
            "[IFC-LITE] 2 content-hash reference(s) above the u32 express-id bound were refused (see issue #3421)",
        ),
        (
            Level::Warn,
            "[IFC-LITE] 3 representation item(s) dropped (unsupported type or failed geometry) — these \
             elements are missing or incomplete: IfcTextLiteral=2, IfcAnnotationFillArea=1",
        ),
    ];
    let actual = console_summary(&d);
    let actual: Vec<_> = actual.iter().map(|(level, line)| (*level, line.as_str())).collect();
    assert_eq!(actual, expected);
}

#[test]
fn hosts_without_failures_print_the_pipeline_note() {
    let d = GeometryDiagnostics { hosts_with_openings: 2, ..GeometryDiagnostics::default() };
    let lines = console_summary(&d);
    assert_eq!(
        lines,
        [(Level::Info, "[IFC-LITE] Opening pipeline: 0 CSG failures. 2 hosts with openings.".to_string())]
    );
}

/// A rect_fast pass that only deferred for "no openings" or "too many" is not
/// engagement worth a line, as before.
#[test]
fn rect_fast_stays_quiet_without_engagement() {
    let rect_fast = RectFastSummary { defer_no_openings: 3, defer_too_many_openings: 1, ..RectFastSummary::default() };
    let d = GeometryDiagnostics { rect_fast, ..GeometryDiagnostics::default() };
    assert!(console_summary(&d).is_empty());
}

fn host(ifc_type: &str, csg_failure_count: usize) -> HostOpeningDiagnostic {
    HostOpeningDiagnostic {
        host_type: ifc_type.to_string(),
        csg_failure_count,
        first_failure_label: (csg_failure_count > 0).then(|| "EmptyOperand".to_string()),
        ..HostOpeningDiagnostic::default()
    }
}

/// Twenty failing hosts, inserted in an order unrelated to the expected one,
/// plus a host with no failures. The console lists the contract's sixteen:
/// failures descending, equal counts by ascending id, the clean host never.
#[test]
fn worst_hosts_are_the_top_sixteen_with_an_id_tie_break() {
    let mut hosts = FxHashMap::default();
    let mut failures: FxHashMap<u32, Vec<BoolFailure>> = FxHashMap::default();
    for id in (1..=20u32).rev() {
        let count = if id % 2 == 0 { 2 } else { 1 };
        hosts.insert(id, host("IfcWall", count));
        let failure = BoolFailure::new(BoolOp::Difference, BoolFailureReason::EmptyOperand).with_product_id(id);
        failures.insert(id, vec![failure; count]);
    }
    hosts.insert(99, host("IfcSlab", 0));
    let d = aggregate_diagnostics(
        ClassificationStats::default(),
        &failures,
        &hosts,
        RectFastStats::default(),
        WORST_HOSTS_LIMIT,
        0,
        &FxHashMap::default(),
    );
    let lines = console_summary(&d);
    let (level, detail) = lines.iter().find(|(_, line)| line.contains("CSG fallbacks")).unwrap();
    assert_eq!(*level, Level::Warn);
    let ids: Vec<u32> = detail
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix('#'))
        .map(|line| line.split(' ').next().unwrap().parse().unwrap())
        .collect();
    assert_eq!(ids, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 1, 3, 5, 7, 9, 11]);
    assert!(detail.contains("Worst-failing hosts (16 shown, by failures then id):"));
    assert!(detail.starts_with("[IFC-LITE] CSG fallbacks: 30 failures across 20 products. Breakdown: EmptyOperand=30."));
}

/// A host whose cut left the mesh unchanged is a silent no-op only when it
/// recorded no CSG failure; a failed host is reported as a failure instead.
#[test]
fn a_failed_host_is_not_also_a_silent_no_op() {
    let unchanged = |csg_failure_count| HostOpeningDiagnostic {
        tris_before: Some(12),
        tris_after: Some(12),
        rect_boxes_processed: 1,
        ..host("IfcWall", csg_failure_count)
    };
    let mut hosts = FxHashMap::default();
    hosts.insert(1, unchanged(0));
    hosts.insert(2, unchanged(1));
    let failure = BoolFailure::new(BoolOp::Difference, BoolFailureReason::EmptyOperand).with_product_id(2);
    let failures = FxHashMap::from_iter([(2, vec![failure])]);
    let d = aggregate_diagnostics(
        ClassificationStats::default(),
        &failures,
        &hosts,
        RectFastStats::default(),
        WORST_HOSTS_LIMIT,
        0,
        &FxHashMap::default(),
    );
    let lines = console_summary(&d);
    assert!(lines.iter().any(|(_, line)| line.starts_with("[IFC-LITE] Rectangular cut SILENT NO-OP on 1 hosts ")));
    assert!(lines.iter().any(|(_, line)| line.contains("  #2 IfcWall — 0 openings, 1 CSG failure(s) (EmptyOperand)")));
}
