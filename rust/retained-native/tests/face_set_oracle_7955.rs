// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 face-set comparison contract (SDK-free), driving the comparison's own modules:
//! - F2: an authored row no wider than the 1e-9 m plane tolerance has no area to compare and
//!   may be dropped, so a faithful copy passes at 1e-9 and reports no missing row;
//! - F3: only a set its source authors open skips closure and exact volume/area, and the
//!   skip is reported. A source-closed or unknown set with a hole still fails.
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

use ifc_lite_core::EntityDecoder;
use ifc_lite_retained_native::oracle::{face_set_closure::authored_open, face_sets};

const SET: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X3'));ENDSEC;DATA;
#30=IFCCARTESIANPOINTLIST3D((POINTS));
#33=IFCTRIANGULATEDFACESET(#30,$,CLOSED,(ROWS),$);
#34=IFCTRIANGULATEDIRREGULARNETWORK(#30,$,.F.,(ROWS),(0),$);
ENDSEC;END-ISO-10303-21;";

fn set(points: &[[f64; 3]], rows: &[[usize; 3]], closed: &str) -> String {
    let points: Vec<String> = points.iter().map(|p| format!("({:?},{:?},{:?})", p[0], p[1], p[2])).collect();
    let rows: Vec<String> = rows.iter().map(|r| format!("({},{},{})", r[0], r[1], r[2])).collect();
    SET.replace("POINTS", &points.join(",")).replace("ROWS", &rows.join(",")).replace("CLOSED", closed)
}

/// Each authored row published as itself, the way retained publishes uncut face sets: a
/// row's triangle carries the authored points (relative to the first, in metres).
fn faithful(text: &str, metres_per_unit: f64, drop: &[usize]) -> face_sets::RowDeviation {
    let mut decoder = EntityDecoder::new(text.as_bytes());
    let item = decoder.decode_by_id(33).unwrap();
    let set = face_sets::authored(&item, &mut decoder, metres_per_unit).unwrap();
    let (mut positions, mut indices, mut keys) = (Vec::new(), Vec::new(), Vec::new());
    for (k, row) in set.rows.iter().enumerate().filter(|(k, _)| !drop.contains(k)) {
        for p in &row.points { indices.push((positions.len() / 3) as u32); positions.extend_from_slice(p); }
        keys.push(Some(k as u32));
    }
    face_sets::deviation(&set, &positions, &indices, &keys)
}

#[test]
fn issue_7955_f2_a_collinear_authored_row_has_no_area_to_compare() {
    // building-architecture.ifc #74 row 11 (IfcSlab #52, millimetres): its corners are
    // collinear to 1.3e-15 m, so its area is rounding noise; the oracle read 1.1e-3.
    let points = [[2400.0000000000146, 0., 3.6095570976613087e-13], [2400.0000000000023, 1799.9999999999338, 250.00000000000034],
        [2400.000000000014, -3.6398755663811063e-13, 250.00000000000034], [2400.000000000014, 200.00000000000037, 250.00000000000034],
        [2400.0000000000146, 1800., 3.6095570976613087e-13]];
    let text = set(&points, &[[2, 4, 3], [1, 2, 3], [1, 3, 5]], ".T.");
    let deviation = faithful(&text, 0.001, &[]);
    assert!(deviation.area_relative <= 1e-9 && deviation.corner_m == 0. && deviation.missing_rows == 0, "{deviation:?}");
    // Retained may drop a zero-area triangle; nothing of the surface is lost.
    assert_eq!(faithful(&text, 0.001, &[0]).missing_rows, 0);
    // A real row is still required.
    assert_eq!(faithful(&text, 0.001, &[1]).missing_rows, 1, "a dropped row with area is observed");
}

#[test]
fn issue_7955_f2_a_sliver_far_from_the_first_point_keeps_its_area() {
    // Viadotto_Acerno #159309 shape: 0.5 m slivers 1e-5 m high, hundreds of metres from the
    // set's first point, read 8.8e-9 before #8410's per-row noise allowance; they must pass.
    let points = [[0., 0., 0.], [300., 200., 50.], [300.5, 200.00001, 50.], [300.25, 200.000025, 50.00002], [1., 0., 0.], [0., 1., 0.]];
    let text = set(&points, &[[1, 5, 6], [2, 3, 4]], ".F.");
    let deviation = faithful(&text, 1., &[]);
    assert!(deviation.area_relative <= 1e-9, "{deviation:?}");
    assert_eq!(deviation.missing_rows, 0);
}

#[test]
fn issue_7955_f3_only_a_source_open_set_is_authored_open() {
    let points = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
    for (closed, open) in [(".F.", true), (".T.", false), ("$", false), (".U.", false)] {
        let text = set(&points, &[[1, 2, 3]], closed);
        let mut decoder = EntityDecoder::new(text.as_bytes());
        assert_eq!(authored_open(&decoder.decode_by_id(33).unwrap()), open, "Closed = {closed}");
        assert!(authored_open(&decoder.decode_by_id(34).unwrap()), "a TIN is never closed");
    }
}

fn open_shell() -> metrics::Metrics {
    // Three faces of a tetrahedron: an open mesh with a volume.
    let points = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    let mut metrics = metrics::Metrics::default();
    metrics.add_mesh(&points, &[0, 2, 1, 0, 1, 3, 1, 2, 3]).unwrap();
    assert!(metrics.defects > 0 && metrics.volume > 0.);
    metrics
}

#[test]
fn issue_7955_f3_open_skips_closure_and_volume_but_closed_still_fails() {
    let tolerances = tolerances::registered().unwrap();
    let actual = open_shell();
    let mut exact = actual.clone();
    exact.volume = 0.; // AB22 #1217: no volume on the exact side, an infinite deviation
    for open in [true, false] {
        let mut report = report::Report::default();
        report.check_measurements(open, "set:1", false, false, &actual, Some(&actual), Some(&exact), None, &tolerances, false);
        let has = |text: &str| report.violations.iter().any(|v| v.contains(text));
        let listed = report.summary()["authoredOpenFaceSets"]["count"].as_u64().unwrap();
        if open {
            assert!(report.violations.is_empty(), "{:?}", report.violations);
            assert_eq!(listed, 1, "the skip is reported, not hidden");
        } else {
            assert!(has("closure defects") && has("nonfinite exact volume deviation"), "{:?}", report.violations);
            assert_eq!(listed, 0);
        }
    }
    // Open does not waive the bbox: a moved shell still fails.
    let mut moved = actual.clone();
    moved.bbox[3] += 1.;
    let mut report = report::Report::default();
    report.check_measurements(true, "set:2", false, false, &moved, Some(&moved), Some(&actual), None, &tolerances, false);
    assert!(report.violations.iter().any(|v| v.contains("exact bboxMetres deviation")), "{:?}", report.violations);
}
