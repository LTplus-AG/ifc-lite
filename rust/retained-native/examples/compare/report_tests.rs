// SPDX-License-Identifier: MPL-2.0
use super::*;

fn tolerances() -> Value {
    crate::tolerances::registered().unwrap()
}

fn tetrahedron(scale: f64) -> Metrics {
    let mut measured = Metrics::default();
    measured
        .add_mesh(
            &[
                [0., 0., 0.],
                [scale, 0., 0.],
                [0., scale, 0.],
                [0., 0., scale],
            ],
            &[0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
        )
        .unwrap();
    measured
}

// #8183: all input coordinates are finite and every edge has two faces, yet
// finite arithmetic overflows. Curved/report-only comparisons must fail too.
#[test]
fn nonfinite_mesh_measurements_fail_the_comparison_gate() {
    let invalid = tetrahedron(1e200);
    assert_eq!(invalid.defects, 0);
    assert!(!invalid.volume.is_finite());
    for curved in [false, true] {
        let mut report = Report::default();
        report.check_measurements(
            "overflow:1",
            curved,
            false,
            &invalid,
            Some(&invalid),
            Some(&invalid),
            Some((1. / 6., None)),
            &tolerances(),
            false,
        );
        assert!(
            !report.violations.is_empty(),
            "nonfinite measurements must fail, curved={curved}"
        );
        assert_eq!(
            report.summary()["maximumDeviations"]["sourceVolumeRelative"],
            "infinite"
        );
    }
}

// #8183: checks apply to every compared quantity, including report-only exact
// curved metrics and source bounds; this is the violations list --gate reads.
#[test]
fn nonfinite_deviations_are_violations_in_every_comparison_channel() {
    let valid = tetrahedron(1.);
    for curved in [false, true] {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for channel in 0..5 {
                let mut actual = valid.clone();
                let mut rounded = valid.clone();
                let mut exact = valid.clone();
                let mut source = (valid.volume, Some(valid.bbox));
                match channel {
                    0 => source.0 = bad,
                    1 => {
                        rounded.volume = bad;
                        exact.volume = bad;
                    }
                    2 => {
                        rounded.area = bad;
                        exact.area = bad;
                    }
                    3 => {
                        rounded.bbox[0] = bad;
                        exact.bbox[0] = bad;
                    }
                    4 => {
                        actual.bbox[0] = bad;
                        source.1.as_mut().unwrap()[0] = bad;
                    }
                    _ => unreachable!(),
                }
                let mut report = Report::default();
                report.check_measurements(
                    "invalid:1",
                    curved,
                    false,
                    &actual,
                    Some(&rounded),
                    Some(&exact),
                    Some(source),
                    &tolerances(),
                    false,
                );
                // Channels 1-4 also raise a nonfinite measurement; require the
                // deviation check itself, so removing it cannot pass.
                assert!(
                    report
                        .violations
                        .iter()
                        .any(|v| v.contains("nonfinite") && v.contains("deviation")),
                    "channel={channel}, bad={bad}, curved={curved}: {:?}",
                    report.violations
                );
            }
        }
    }
    let mut report = Report::default();
    report.check_measurements(
        "valid:1",
        false,
        false,
        &valid,
        Some(&valid),
        Some(&valid),
        Some((valid.volume, Some(valid.bbox))),
        &tolerances(),
        false,
    );
    assert!(report.violations.is_empty());
}

// #7955 CUT-0 Round 3: closed tetrahedra supply independently known V=s^3/6.
// Exact is deliberately a different solid; no product-specific exception exists.
#[test]
fn exact_defect_when_retained_matches_source_but_exact_does_not() {
    let actual = tetrahedron(1.);
    let exact = tetrahedron(1.01);
    let mut report = Report::default();
    report.check_measurements("fixture:1", false, false, &actual, Some(&actual), Some(&exact),
        Some((1. / 6., Some([0., 0., 0., 1., 1., 1.]))), &tolerances(), false);
    assert!(report.violations.is_empty(), "{:?}", report.violations);
    let summary = report.summary();
    let defects = summary["exact_defect"].as_array().unwrap();
    assert_eq!(defects.len(), 1);
    let defect = &defects[0];
    assert_eq!(defect["classification"], "exact_defect");
    assert_eq!(defect["product"], "fixture:1");
    assert_eq!(defect["retainedVsSourceVolumeRelative"], 0.);
    assert_eq!(defect["exactVsSourceVolumeRelative"], relative(exact.volume, 1. / 6.));
    assert_eq!(defect["retainedVsExact"]["volumeRelative"], relative(actual.volume, exact.volume));
    assert_eq!(defect["retainedVsExact"]["areaRelative"], relative(actual.area, exact.area));
    assert_eq!(defect["retainedVsExact"]["bboxMetres"], bbox_deviation(&actual.bbox, &exact.bbox));
}

#[test]
fn exact_report_only_waiver_is_listed_in_the_summary() {
    let actual = tetrahedron(1.);
    let exact = tetrahedron(1.2);
    let mut report = Report::default();
    // No source oracle: the exact gate would violate, but the waiver defers it.
    report.check_measurements("fixture:w", false, false, &actual, Some(&actual), Some(&exact),
        None, &tolerances(), true);
    assert!(report.violations.is_empty(), "{:?}", report.violations);
    let summary = report.summary();
    let waived = summary["exact_report_only"].as_array().unwrap();
    assert_eq!(waived.len(), 1);
    assert_eq!(waived[0]["classification"], "exact_report_only");
    assert_eq!(waived[0]["product"], "fixture:w");
    assert_eq!(waived[0]["retainedVsExact"]["volumeRelative"], relative(actual.volume, exact.volume));
    assert!(summary["exact_defect"].as_array().unwrap().is_empty());
    // Without the waiver nothing is listed and the gate violates.
    let mut gated = Report::default();
    gated.check_measurements("fixture:g", false, false, &actual, Some(&actual), Some(&exact),
        None, &tolerances(), false);
    assert!(gated.summary()["exact_report_only"].as_array().unwrap().is_empty());
    assert!(!gated.violations.is_empty());
}

#[test]
fn exact_gate_still_violates_when_retained_fails_source_7955() {
    let actual = tetrahedron(1.02);
    let exact = tetrahedron(1.01);
    let mut report = Report::default();
    report.check_measurements("fixture:2", false, false, &actual, Some(&actual), Some(&exact),
        Some((1. / 6., None)), &tolerances(), false);
    assert!(report.exact_defects.is_empty());
    assert!(report.violations.iter().any(|v| v.contains("source volume deviation")));
    for key in ["volumeRelative", "areaRelative", "bboxMetres"] {
        assert!(report.violations.iter().any(|v| v.contains(&format!("exact {key} deviation"))));
    }
}

#[test]
fn exact_gate_still_violates_without_a_source_oracle_7955() {
    let actual = tetrahedron(1.);
    let exact = tetrahedron(1.01);
    let mut report = Report::default();
    report.check_measurements("fixture:3", false, false, &actual, Some(&actual), Some(&exact), None, &tolerances(), false);
    assert!(report.exact_defects.is_empty());
    for key in ["volumeRelative", "areaRelative", "bboxMetres"] {
        assert!(report.violations.iter().any(|v| v.contains(&format!("exact {key} deviation"))));
    }
}

#[test]
fn exact_agrees_with_source_so_area_disagreement_still_violates_7955() {
    // Equal-volume tetrahedra with different aspect ratios: source volume alone
    // cannot disprove exact here, so it must not suppress the area/bbox gates.
    let actual = tetrahedron(1.);
    let mut exact = Metrics::default();
    exact.add_mesh(&[[0.,0.,0.], [2.,0.,0.], [0.,0.5,0.], [0.,0.,1.]],
        &[0,2,1, 0,1,3, 1,2,3, 2,0,3]).unwrap();
    let mut report = Report::default();
    report.check_measurements("fixture:4", false, false, &actual, Some(&actual), Some(&exact),
        Some((1. / 6., None)), &tolerances(), false);
    assert!(report.exact_defects.is_empty());
    assert!(report.violations.iter().any(|v| v.contains("exact areaRelative deviation")));
}

#[test]
fn exact_defect_does_not_relax_source_bounds_or_closure_7955() {
    let valid = tetrahedron(1.);
    let exact = tetrahedron(1.01);
    for channel in 0..2 {
        let mut actual = valid.clone();
        let mut bounds = valid.bbox;
        if channel == 0 { bounds[3] = 2.; } else { actual.defects = 1; }
        let mut report = Report::default();
        report.check_measurements("fixture:5", false, false, &actual, Some(&valid), Some(&exact),
            Some((1. / 6., Some(bounds))), &tolerances(), false);
        let reason = if channel == 0 { "source bbox deviation" } else { "closure defects" };
        assert!(report.violations.iter().any(|v| v.contains(reason)));
    }
}

// #7955 M9 source authority is gated; exact survey-coordinate f32 is report-only.
#[test]
fn type_product_source_gate_rejects_wrong_volume_without_gating_exact_deviation() {
    let valid = tetrahedron(1.);
    let exact = tetrahedron(2.);
    let mut report = Report::default();
    report.check_measurements("type:1", false, true, &valid, Some(&valid), Some(&exact),
        Some((valid.volume, Some(valid.bbox))), &tolerances(), false);
    assert!(report.violations.is_empty(), "{:?}", report.violations);
    report.check_measurements("type:1", false, true, &valid, Some(&valid), Some(&exact),
        Some((2.*valid.volume, Some(valid.bbox))), &tolerances(), false);
    assert!(report.violations.iter().any(|v| v.contains("source volume deviation")));
}

// #7955/M8: report-only exact geometry must not waive source or closure gates.
#[test]
fn m8_report_only_exact_still_gates_source_volume_bounds_and_closure() {
    let actual = tetrahedron(1.);
    let exact = tetrahedron(2.);
    for defect in 0..5 {
        let mut measured = actual.clone();
        let mut source = (actual.volume, Some(actual.bbox));
        match defect {
            1 => source.0 *= 2.,
            2 => source.1.as_mut().unwrap()[0] -= 1.,
            3 => measured.defects = 1,
            4 => measured.volume = f64::NAN,
            _ => {},
        }
        let mut report = Report::default();
        report.check_measurements("m8:72245", false, false, &measured, Some(&measured), Some(&exact),
            Some(source), &tolerances(), true);
        assert_eq!(report.violations.is_empty(), defect == 0, "defect={defect}");
    }
    let mut report = Report::default();
    // An unflagged product with no source that disproves exact keeps the exact gate.
    report.check_measurements("ordinary:1", false, false, &actual, Some(&actual), Some(&exact),
        None, &tolerances(), false);
    assert!(report.violations.iter().any(|message| message.contains("exact")));
}

// #3641: the harness must gate the cut result, including a smaller valid bbox.
#[test]
fn m8_convex_opening_expectation_rejects_wrong_volume_and_escaped_bbox() {
    let path = std::path::Path::new("rust/processing/tests/fixtures/issue_3641_voiding_trap.ifc");
    let bytes = include_bytes!("../../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(bytes, None);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(bytes, ifc_lite_core::build_entity_index(bytes));
    let t = crate::tolerances::registered().unwrap();
    let expected = crate::source::retraced_opening(path, &sources, &mut decoder, &t).unwrap().unwrap();
    let volume = expected.result_volume.unwrap();
    let bbox = expected.host_bbox.unwrap();
    for defect in 0..3 {
        let mut actual = Metrics { volume, area: 0., bbox, defects: 0, ..Default::default() };
        match defect {
            1 => actual.volume *= 1.001,
            2 => actual.bbox[0] -= 1.,
            _ => actual.bbox[0] += 0.001,
        }
        let mut violations = Vec::new();
        crate::openings::check_opened("M8 slab", &actual, Some(&expected), &t, &mut violations);
        assert_eq!(violations.is_empty(), defect == 0, "defect={defect}: {violations:?}");
    }
}
