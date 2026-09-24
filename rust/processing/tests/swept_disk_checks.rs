// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5758: public source-geometry diagnostics on authored swept disks.

use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};
use ifc_lite_processing::{check_swept_disk, extract_swept_disk_descriptions,
    SweptDiskCheckOptions, SweptDiskFindingCode, SweptDiskOccurrence};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("../geometry/tests/fixtures/{name}.ifc")).unwrap()
}

fn disk(name: &str, element: u32) -> SweptDiskOccurrence {
    let description = extract_swept_disk_descriptions(&fixture(name), None);
    assert!(description.diagnostics.is_empty(), "{:?}", description.diagnostics);
    description.elements[&element][0].clone()
}

fn line(start: [f64; 3], end: [f64; 3]) -> AnalyticCurveSegment {
    AnalyticCurveSegment::Line { start, end }
}

#[test]
fn authored_l_u_and_crank_bars_have_no_geometric_findings() {
    for (name, element) in [
        ("swept_disk_composite_arc_lbar", 78),
        ("swept_disk_composite_arc_ubar", 125),
        ("swept_disk_composite_arc_crankbar", 79),
    ] {
        let report = check_swept_disk(&disk(name, element), &SweptDiskCheckOptions::default()).unwrap();
        assert_eq!(report.skipped_reason, None, "{name}");
        assert!(report.findings.is_empty(), "{name}: {:?}", report.findings);
    }
}

#[test]
fn deliberate_gap_sharp_corner_and_zero_length_have_indexed_measures() {
    let mut occurrence = disk("swept_disk_trimmed_line", 50);
    occurrence.directrix = vec![
        line([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
        line([1.001, 0.0, 0.0], [2.0, 0.0, 0.0]),
        line([2.0, 0.0, 0.0], [2.0, 0.0, 0.0]),
        line([2.0, 0.0, 0.0], [2.0, 1.0, 0.0]),
    ];
    let report = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(report.skipped_reason, None);
    assert_eq!(report.findings.len(), 2, "{:?}", report.findings);
    let gap = report.findings.iter().find(|f| f.code == SweptDiskFindingCode::ConsecutiveGap).unwrap();
    assert_eq!((gap.segment_index, gap.next_segment_index, gap.units), (0, Some(1), "m"));
    assert!((gap.measured - 0.001).abs() < 1e-12);
    assert_eq!(gap.threshold, 1e-6);
    let zero = report.findings.iter().find(|f| f.code == SweptDiskFindingCode::ZeroLengthSegment).unwrap();
    assert_eq!((zero.segment_index, zero.next_segment_index, zero.measured), (2, None, 0.0));

    occurrence.directrix = vec![line([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
        line([1.0, 0.0, 0.0], [1.0, 1.0, 0.0])];
    let report = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(report.findings.len(), 1);
    let sharp = &report.findings[0];
    assert_eq!(sharp.code, SweptDiskFindingCode::TangentDiscontinuity);
    assert_eq!((sharp.segment_index, sharp.next_segment_index, sharp.units), (0, Some(1), "rad"));
    assert!((sharp.measured - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
}

#[test]
fn arc_radius_constraint_is_independent_of_configurable_tolerances() {
    let mut occurrence = disk("swept_disk_composite_arc_lbar", 78);
    occurrence.radius = 0.0895;
    let report = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    let finding = report.findings.iter().find(|f| f.code ==
        SweptDiskFindingCode::ArcRadiusNotGreaterThanDiskRadius).unwrap();
    assert_eq!((finding.segment_index, finding.next_segment_index, finding.units), (1, None, "m"));
    assert_eq!(finding.measured, finding.threshold);
}

#[test]
fn tolerance_boundaries_and_invalid_options_are_explicit() {
    let mut occurrence = disk("swept_disk_trimmed_line", 50);
    occurrence.directrix = vec![line([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
        line([1.000_001, 0.0, 0.0], [2.0, 0.0, 0.0])];
    let mut options = SweptDiskCheckOptions::default();
    options.gap_tolerance_m = 1.1e-6;
    assert!(check_swept_disk(&occurrence, &options).unwrap().findings.is_empty());
    let mut strict = options;
    strict.gap_tolerance_m = 0.9e-6;
    assert_eq!(check_swept_disk(&occurrence, &strict).unwrap().findings[0].code,
        SweptDiskFindingCode::ConsecutiveGap);
    for invalid in [f64::NAN, f64::INFINITY, -1.0] {
        let mut options = SweptDiskCheckOptions::default();
        options.tangent_tolerance_rad = invalid;
        assert_eq!(options.validate().unwrap_err().option, "tangent_tolerance_rad");
        assert_eq!(check_swept_disk(&occurrence, &options).unwrap_err().option, "tangent_tolerance_rad");
    }
}

#[test]
fn unsupported_and_modified_records_preserve_provenance() {
    let mut occurrence = disk("swept_disk_trimmed_line", 50);
    occurrence.source_modified = true;
    let report = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    assert!(report.source_modified);
    assert_eq!(report.skipped_reason, None);
    occurrence.status = AnalyticStatus::Unsupported("unknown curve".into());
    occurrence.directrix.clear();
    let report = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    assert!(report.source_modified);
    assert_eq!(report.skipped_reason.as_deref(), Some("unknown curve"));
    assert!(report.findings.is_empty());
}

#[test]
fn translated_world_arcs_keep_local_gap_results() {
    let mut occurrence = disk("swept_disk_composite_arc_ubar", 125);
    let before = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    for segment in &mut occurrence.directrix {
        match segment {
            AnalyticCurveSegment::Line { start, end } => {
                start[0] += 5_000_000.0;
                end[0] += 5_000_000.0;
            }
            AnalyticCurveSegment::Arc { center, .. } => center[0] += 5_000_000.0,
        }
    }
    let after = check_swept_disk(&occurrence, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(before.findings, after.findings);
    assert_eq!(after.skipped_reason, None);
}

#[test]
fn mirrored_scaled_mapped_line_is_checked_in_world_metres() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let source = source.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,-2.,$);",
    );
    let description = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(description.diagnostics.is_empty(), "{:?}", description.diagnostics);
    let occurrence = &description.elements[&50][0];
    assert_eq!(occurrence.radius, 0.029);
    assert!((occurrence.directrix_metrics().unwrap().total_length - 5.5).abs() < 1e-12);
    let report = check_swept_disk(occurrence, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(report.skipped_reason, None);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}
