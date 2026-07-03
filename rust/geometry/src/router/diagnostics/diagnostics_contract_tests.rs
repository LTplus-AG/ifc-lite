// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Split out of `router/diagnostics.rs` (module-size ratchet, #C1): the
//! `GeometryDiagnostics` contract tests, including the serde camelCase
//! key-stability guard that pins the JSON shape crossing the wasm boundary.

use super::*;
use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::rect_fast::RectFastStats;

#[test]
fn aggregate_empty_is_all_zero() {
    let d = aggregate_diagnostics(
        ClassificationStats::default(),
        &FxHashMap::default(),
        &FxHashMap::default(),
        RectFastStats::default(),
        16,
    );
    assert_eq!(d.total_csg_failures, 0);
    assert_eq!(d.products_with_failures, 0);
    assert!(d.failures_by_reason.is_empty());
    assert!(d.worst_hosts.is_empty());
    assert!(!d.has_issues());
}

#[test]
fn aggregate_summarizes_failures_hosts_classification_and_silent_noops() {
    let mut csg: FxHashMap<u32, Vec<BoolFailure>> = FxHashMap::default();
    csg.insert(
        5,
        vec![BoolFailure::new(BoolOp::Difference, BoolFailureReason::DifferenceEmptiedHost)],
    );
    csg.insert(
        7,
        vec![
            BoolFailure::new(BoolOp::Difference, BoolFailureReason::DifferenceEmptiedHost),
            BoolFailure::new(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid),
        ],
    );

    let mut hosts: FxHashMap<u32, HostOpeningDiagnostic> = FxHashMap::default();
    // A FAILED host (also unchanged tris) — must NOT be counted as a silent
    // no-op because it recorded an explicit failure.
    hosts.insert(
        7,
        HostOpeningDiagnostic {
            host_type: "IfcWallStandardCase".into(),
            csg_failure_count: 2,
            first_failure_label: Some("DifferenceEmptiedHost".into()),
            tris_before: Some(120),
            tris_after: Some(120),
            rect_boxes_processed: 1,
            host_bounds: Some(((0.0, 0.0, 0.0), (1.0, 2.0, 3.0))),
            ..Default::default()
        },
    );
    // A TRUE silent no-op host: rect cutters ran, tris unchanged, NO failure.
    hosts.insert(
        9,
        HostOpeningDiagnostic {
            host_type: "IfcSlab".into(),
            csg_failure_count: 0,
            tris_before: Some(50),
            tris_after: Some(50),
            rect_boxes_processed: 2,
            ..Default::default()
        },
    );

    let cls = ClassificationStats {
        rectangular: 3,
        diagonal: 1,
        non_rectangular: 0,
        floor_opening_guard_saved: 0,
    };
    let rf = RectFastStats { fired: 2, openings_cut: 4, ..Default::default() };

    let d = aggregate_diagnostics(cls, &csg, &hosts, rf, 16);
    assert_eq!(d.total_csg_failures, 3);
    assert_eq!(d.products_with_failures, 2);
    assert_eq!(d.hosts_with_openings, 2);
    assert_eq!(d.classification.total, 4);
    assert_eq!(d.classification.rectangular, 3);
    // Only host 9 (clean, unchanged tris) counts; host 7 failed, so it is NOT
    // a silent no-op.
    assert_eq!(d.silent_no_ops, 1);
    assert_eq!(d.rect_fast.fired, 2);
    // Sorted desc by count: DifferenceEmptiedHost=2 then KernelOutputInvalid=1.
    assert_eq!(d.failures_by_reason[0].reason, "DifferenceEmptiedHost");
    assert_eq!(d.failures_by_reason[0].count, 2);
    assert_eq!(d.worst_hosts.len(), 1);
    assert_eq!(d.worst_hosts[0].product_id, 7);
    assert_eq!(d.worst_hosts[0].csg_failures, 2);
    // bbox/triangle_count (#C1) thread through from the host diagnostic's
    // captured cut effect (tris_after wins over tris_before when both are set).
    let bbox = d.worst_hosts[0].bbox.expect("host_bounds captured");
    assert_eq!(bbox.min, [0.0, 0.0, 0.0]);
    assert_eq!(bbox.max, [1.0, 2.0, 3.0]);
    assert_eq!(d.worst_hosts[0].triangle_count, Some(120));
    assert!(d.has_issues());
}

#[test]
fn worst_host_triangle_count_falls_back_to_tris_before_when_no_cut_ran() {
    // A host that failed before any void cut effect was recorded (tris_after
    // never set) should still report tris_before — the un-cut mesh is what
    // actually renders in that case.
    let mut hosts: FxHashMap<u32, HostOpeningDiagnostic> = FxHashMap::default();
    hosts.insert(
        3,
        HostOpeningDiagnostic {
            host_type: "IfcSlab".into(),
            csg_failure_count: 1,
            first_failure_label: Some("EmptyOperand".into()),
            tris_before: Some(80),
            tris_after: None,
            ..Default::default()
        },
    );
    let mut csg: FxHashMap<u32, Vec<BoolFailure>> = FxHashMap::default();
    csg.insert(3, vec![BoolFailure::new(BoolOp::Difference, BoolFailureReason::EmptyOperand)]);
    let d = aggregate_diagnostics(ClassificationStats::default(), &csg, &hosts, RectFastStats::default(), 16);
    assert_eq!(d.worst_hosts[0].triangle_count, Some(80));
    assert!(d.worst_hosts[0].bbox.is_none());
}

#[test]
fn serializes_camelcase_keys_matching_the_ts_contract() {
    // Guard the serde rename_all against drift from the @ifc-lite/geometry
    // GeometryDiagnostics TS interface. The wasm getter uses the same renames
    // via serde-wasm-bindgen, so this JSON key set is what crosses to JS.
    let mut hosts: FxHashMap<u32, HostOpeningDiagnostic> = FxHashMap::default();
    hosts.insert(
        7,
        HostOpeningDiagnostic {
            host_type: "IfcWall".into(),
            csg_failure_count: 1,
            first_failure_label: Some("KernelError".into()),
            tris_before: Some(40),
            tris_after: Some(36),
            host_bounds: Some(((-1.0, -1.0, 0.0), (1.0, 1.0, 3.0))),
            ..Default::default()
        },
    );
    let mut csg: FxHashMap<u32, Vec<BoolFailure>> = FxHashMap::default();
    csg.insert(7, vec![BoolFailure::new(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid)]);
    let d = aggregate_diagnostics(
        ClassificationStats { rectangular: 1, ..Default::default() },
        &csg,
        &hosts,
        RectFastStats::default(),
        16,
    );
    let v = serde_json::to_value(&d).expect("serializes");
    for key in [
        "totalCsgFailures",
        "productsWithFailures",
        "hostsWithOpenings",
        "classification",
        "failuresByReason",
        "silentNoOps",
        "rectFast",
        "worstHosts",
    ] {
        assert!(v.get(key).is_some(), "missing top-level key {key}");
    }
    assert!(v["classification"].get("nonRectangular").is_some());
    assert!(v["rectFast"].get("deferHostNotBox").is_some());
    let wh = &v["worstHosts"][0];
    for key in [
        "productId",
        "ifcType",
        "openings",
        "csgFailures",
        "firstFailureLabel",
        "bbox",
        "triangleCount",
    ] {
        assert!(wh.get(key).is_some(), "missing worstHosts key {key}");
    }
    assert!(wh["bbox"].get("min").is_some() && wh["bbox"].get("max").is_some());
    let fr = &v["failuresByReason"][0];
    assert!(fr.get("reason").is_some() && fr.get("count").is_some());
}

#[test]
fn schema_version_round_trips_and_defaults() {
    let d = GeometryDiagnostics::default();
    assert_eq!(d.schema_version, GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION);
    let json = serde_json::to_string(&d).unwrap();
    assert!(json.contains("\"schemaVersion\":1"), "serialized unconditionally: {json}");
    let back: GeometryDiagnostics = serde_json::from_str(&json).unwrap();
    assert_eq!(back.schema_version, GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION);
    // A pre-versioned producer (field absent) deserializes to 0, distinguishable.
    let legacy: GeometryDiagnostics =
        serde_json::from_str(&json.replace("\"schemaVersion\":1,", "")).unwrap();
    assert_eq!(legacy.schema_version, 0);
}
