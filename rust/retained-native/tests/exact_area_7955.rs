// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: an uncut product's analytic faces, or a preregistered hand area, outrank an exact
//! mesh they disprove, by area as they already do by volume. Nothing is hidden: the row is a
//! named, counted `exact_defect`. Drives the comparison's own measurement gate (SDK-free).
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
#[allow(dead_code)]
#[path = "../examples/compare/openings.rs"]
mod openings;
#[allow(dead_code)]
#[path = "../examples/compare/layer_report.rs"]
mod layer_report;
#[allow(dead_code)]
#[path = "../examples/compare/checks/mod.rs"]
mod checks;
#[allow(dead_code)]
#[path = "../examples/compare/registry.rs"]
mod registry;
#[allow(dead_code)]
#[path = "../examples/compare/tolerances.rs"]
mod tolerances;
#[allow(dead_code)]
#[path = "../examples/compare/precision.rs"]
mod precision;
#[allow(dead_code, unused_imports)]
#[path = "../examples/compare/source.rs"]
mod source;
#[allow(dead_code)]
#[path = "../examples/compare/exact_area.rs"]
mod exact_area;
#[allow(dead_code)]
#[path = "../examples/compare/report.rs"]
mod report;

use exact_area::{ExactAreaAuthorities, REGISTERED};
use metrics::Metrics;
use report::Report;

fn tetrahedron() -> Metrics {
    let mut measured = Metrics::default();
    measured.add_mesh(&[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], &[0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]).unwrap();
    measured
}
fn check(source_area: Option<f64>, curved: bool, actual: &Metrics, exact: &Metrics) -> Report {
    let mut report = Report { source_area, ..Default::default() };
    report.check_measurements(false, "fixture:a", curved, false, actual, Some(actual), Some(exact), None, &tolerances::registered().unwrap(), false);
    report
}

#[test]
fn exact_area_defect_needs_retained_on_the_source_and_exact_off_it() {
    let retained = tetrahedron();
    let mut exact = tetrahedron();
    exact.area *= 1.1;
    let source = retained.area;
    let named = check(Some(source), false, &retained, &exact);
    assert!(named.violations.is_empty(), "{:?}", named.violations);
    assert_eq!(named.summary()["exact_defect"][0]["kind"], "area");
    assert_eq!(named.summary()["exact_defect"][0]["exactAreaM2"], exact.area);
    // Retained a little inside the frozen 1e-9 face limit is still on the source.
    assert_eq!(check(Some(source * (1. + 1e-10)), false, &retained, &exact).exact_defects.len(), 1);
    // No authority: the area gate stands.
    assert!(check(None, false, &retained, &exact).violations.iter().any(|v| v.contains("areaRelative")));
    // Retained off the source by more than the frozen face limit: never exact's fault.
    let off = check(Some(source * (1. + 1e-8)), false, &retained, &exact);
    assert!(off.exact_defects.is_empty());
    assert!(off.violations.iter().any(|v| v.contains("areaRelative")));
    // Exact within its own limit of the source: nothing to name.
    let mut close = tetrahedron();
    close.area *= 1. + 1e-6;
    assert!(check(Some(source), false, &retained, &close).exact_defects.is_empty());
    // A waived or authored-open product's area was never gated: nothing to name, nothing to count.
    for (open, waived) in [(true, false), (false, true)] {
        let mut report = Report { source_area: Some(source), ..Default::default() };
        report.check_measurements(open, "fixture:w", false, false, &retained, Some(&retained), Some(&exact), None, &tolerances::registered().unwrap(), waived);
        assert!(report.exact_defects.is_empty(), "open {open} waived {waived}");
    }
    // A curved product keeps its report-only comparison and names nothing.
    assert!(check(Some(source), true, &retained, &exact).exact_defects.is_empty());
    // An area defect does not excuse the volume or bbox gate.
    let mut wrong_volume = exact.clone();
    wrong_volume.volume *= 1.1;
    assert!(check(Some(source), false, &retained, &wrong_volume).violations.iter().any(|v| v.contains("volumeRelative")));
}

#[test]
fn hand_areas_are_real_rows_matched_by_repo_suffix() {
    let table = ExactAreaAuthorities::parse(REGISTERED).unwrap();
    let area = table.get("/work/tests/models/ara3d/dental_clinic.ifc", 1757).expect("registered");
    assert!((area - 62.3265783).abs() < 1e-6);
    assert!(table.get("/work/tests/models/ara3d/dental_clinic.ifc", 1).is_none());
    assert!(table.get("/work/tests/models/ara3d/other.ifc", 1757).is_none());
    for text in ["{", r#"{"elsewhere/a.ifc":{"1":{"area":1,"derivation":"x"}}}"#,
        r#"{"tests/models/a.ifc":{"1":{"area":-1,"derivation":"x"}}}"#,
        r#"{"tests/models/a.ifc":{"1":{"area":1,"derivation":" "}}}"#,
        r#"{"tests/models/a.ifc":{"1":{"area":1,"derivation":"x","extra":1}}}"#] {
        assert!(ExactAreaAuthorities::parse(text).is_err(), "{text}");
    }
}
