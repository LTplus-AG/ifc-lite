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
        0,
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

    let cls = ClassificationStats { rectangular: 3, diagonal: 1, non_rectangular: 0 };
    let rf = RectFastStats { fired: 2, openings_cut: 4, ..Default::default() };

    let d = aggregate_diagnostics(cls, &csg, &hosts, rf, 16, 0);
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
    let d = aggregate_diagnostics(ClassificationStats::default(), &csg, &hosts, RectFastStats::default(), 16, 0);
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
        0,
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
        "oversizedRefDrops",
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

/// RED for issue #3752: `oversized_ref_drops` must pass through
/// `aggregate_diagnostics` unchanged and must NOT be swallowed by
/// `is_empty`'s all-zero gate — a model whose ONLY diagnostic-worthy event is
/// a refused oversized reference must still be surfaced, not suppressed.
#[test]
fn oversized_ref_drops_passes_through_and_defeats_is_empty() {
    let d = aggregate_diagnostics(
        ClassificationStats::default(),
        &FxHashMap::default(),
        &FxHashMap::default(),
        RectFastStats::default(),
        16,
        3,
    );
    assert_eq!(d.oversized_ref_drops, 3);
    assert!(
        !d.is_empty(),
        "a nonzero oversized_ref_drops must defeat is_empty so the diagnostics object is attached"
    );
}

/// Control: zero refusals is genuinely empty (all other fields already zero).
#[test]
fn zero_oversized_ref_drops_stays_empty() {
    let d = aggregate_diagnostics(
        ClassificationStats::default(),
        &FxHashMap::default(),
        &FxHashMap::default(),
        RectFastStats::default(),
        16,
        0,
    );
    assert!(d.is_empty());
}

#[test]
fn schema_version_round_trips_and_defaults() {
    let d = GeometryDiagnostics::default();
    assert_eq!(d.schema_version, GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION);
    let json = serde_json::to_string(&d).unwrap();
    assert!(json.contains("\"schemaVersion\":2"), "serialized unconditionally: {json}");
    let back: GeometryDiagnostics = serde_json::from_str(&json).unwrap();
    assert_eq!(back.schema_version, GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION);
    // A pre-versioned producer (field absent) deserializes to 0, distinguishable.
    let legacy: GeometryDiagnostics =
        serde_json::from_str(&json.replace("\"schemaVersion\":2,", "")).unwrap();
    assert_eq!(legacy.schema_version, 0);
}

/// A `WorstHost` field the TypeScript mirrors declare as `field?: T` must be
/// ABSENT from the JSON when it is `None`, not present as an explicit `null`.
///
/// The two are different wire states and `?:` means absent: an HTTP consumer
/// doing `if (h.triangleCount !== undefined) h.triangleCount.toLocaleString()`
/// typechecks and then throws on a `null`. The wasm boundary hid this because
/// `serde_wasm_bindgen` writes `None` as `undefined`; `serde_json`, which is
/// what the server response goes through, writes it as `null`.
///
/// Both directions are asserted, so "always skip" fails this test too.
#[test]
fn worst_host_optional_fields_are_omitted_when_none_and_present_when_some() {
    let none = WorstHost {
        product_id: 1,
        ifc_type: "IfcWall".to_string(),
        openings: 2,
        csg_failures: 1,
        first_failure_label: None,
        bbox: None,
        triangle_count: None,
    };
    let obj = serde_json::to_value(&none).unwrap();
    let obj = obj.as_object().expect("serializes to a JSON object");
    for key in ["firstFailureLabel", "bbox", "triangleCount"] {
        assert!(
            !obj.contains_key(key),
            "`{key}` must be absent when None, not null: {obj:?}"
        );
    }

    let some = WorstHost {
        first_failure_label: Some("difference_emptied_host".to_string()),
        bbox: Some(HostBbox { min: [0.0, 0.0, 0.0], max: [1.0, 2.0, 3.0] }),
        triangle_count: Some(42),
        ..none
    };
    let obj = serde_json::to_value(&some).unwrap();
    let obj = obj.as_object().expect("serializes to a JSON object");
    for key in ["firstFailureLabel", "bbox", "triangleCount"] {
        assert!(
            obj.contains_key(key),
            "`{key}` must be present when Some: {obj:?}"
        );
    }
    assert_eq!(obj["triangleCount"], serde_json::json!(42));

    // A legacy payload that still writes explicit nulls stays readable.
    let legacy = serde_json::json!({
        "productId": 1, "ifcType": "IfcWall", "openings": 2, "csgFailures": 1,
        "firstFailureLabel": null, "bbox": null, "triangleCount": null,
    });
    let back: WorstHost = serde_json::from_value(legacy).unwrap();
    assert!(back.bbox.is_none() && back.triangle_count.is_none());
}
