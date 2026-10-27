// SPDX-License-Identifier: MPL-2.0
use super::*;

fn tolerances() -> Value {
    serde_json::from_str(include_str!(
        "../../../../tests/fixtures/cli-retained/tolerances.json"
    ))
    .unwrap()
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
            &invalid,
            Some(&invalid),
            Some(&invalid),
            Some((1. / 6., None)),
            &tolerances(),
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
                    &actual,
                    Some(&rounded),
                    Some(&exact),
                    Some(source),
                    &tolerances(),
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
        &valid,
        Some(&valid),
        Some(&valid),
        Some((valid.volume, Some(valid.bbox))),
        &tolerances(),
    );
    assert!(report.violations.is_empty());
}
