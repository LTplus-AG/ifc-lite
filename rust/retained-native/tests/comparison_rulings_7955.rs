// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 closing rulings for the retained comparison (SDK-free), driving the
//! comparison's own modules:
//! - ruling 2: retained is compared with exact BEFORE exact's world f32 rounding;
//! - ruling 3: a missing face key passes only as a counted kernel merge of a
//!   0.8-4 mm collinear side whose area its neighbour carries (rulings 3 and 16). Nothing widens.
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
#[allow(dead_code)]
#[path = "../examples/compare/precision.rs"]
mod precision;
#[allow(dead_code)]
#[path = "../examples/compare/checks/mod.rs"]
mod checks;
#[path = "../examples/compare/tolerances.rs"]
mod tolerances;

use checks::{faces::compare, OracleResult};
use ifc_lite_retained_native::oracle::faces::{collinear_runs, uncut};
use std::collections::BTreeMap;

const BOX: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc");
const RECTANGLE: &str = "#18=IFCRECTANGLEPROFILEDEF(.AREA.,$,#17,2.,1.);";

/// f-c-extrusion's box (2 x 1 profile, 3 m deep, rotated) with `profile` in place of the rectangle.
fn with_profile(points: &[[f64; 2]]) -> String {
    let list: Vec<String> = (0..points.len()).map(|i| format!("#{}", 9000 + i)).collect();
    let mut entities: String = points.iter().enumerate().map(|(i, p)| format!("#{}=IFCCARTESIANPOINT(({:?},{:?}));\n", 9000 + i, p[0], p[1])).collect();
    entities += &format!("#8999=IFCPOLYLINE(({},#9000));\n", list.join(","));
    assert!(BOX.contains(RECTANGLE));
    BOX.replace(RECTANGLE, "#18=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#8999);")
        .replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{entities}ENDSEC;\nEND-ISO-10303-21;"))
}

fn faces_of(text: &str) -> (ifc_lite_retained_native::oracle::faces::FaceAreas, Vec<ifc_lite_retained_native::oracle::faces::CollinearRun>) {
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    (uncut(&sources, 27).expect("uncut source faces"), collinear_runs(&sources, 27).expect("collinear runs"))
}

/// What the kernel would publish if it folded side `from` into side `into`.
fn folded(expected: &ifc_lite_retained_native::oracle::faces::FaceAreas, from: &str, into: &str, error: f64) -> BTreeMap<String, f64> {
    let mut actual: BTreeMap<String, f64> = expected.iter().map(|(k, e)| (k.clone(), e.area_m2)).collect();
    let area = actual.remove(from).expect("folded key exists");
    let receiving = actual.get_mut(into).expect("receiving key exists");
    *receiving = (*receiving + area) * (1. + error);
    actual
}

fn row<'a>(rows: &'a [OracleResult], family: &str) -> Option<&'a OracleResult> { rows.iter().find(|r| r.family == family) }
fn gated_failures(rows: &[OracleResult]) -> Vec<&'static str> {
    rows.iter().filter(|r| r.gated && !r.pass).map(|r| r.family).collect()
}

// 2 x 1 profile whose bottom edge ends in a short collinear piece starting at `tail_start`.
fn split_bottom(tail_start: [f64; 2]) -> String {
    with_profile(&[[0., 0.], tail_start, [2., 0.], [2., 1.], [0., 1.]])
}

#[test]
fn ruling_3_kernel_merged_collinear_side_is_counted_not_hidden() {
    let tolerances = tolerances::registered().unwrap();
    let text = split_bottom([1.997, 0.]);
    let (expected, runs) = faces_of(&text);
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0].keys, ["#19:side(0,0)", "#19:side(0,1)"]);
    assert!((runs[0].widths_m[1] - 0.003).abs() < 1e-12, "{runs:?}");
    // Nothing missing: no merge outcome, every gated row passes.
    let all: BTreeMap<_, _> = expected.iter().map(|(k, e)| (k.clone(), e.area_m2)).collect();
    let rows = compare(&expected, &all, &runs, &tolerances);
    assert!(row(&rows, "faceKeysKernelMerged").is_none() && gated_failures(&rows).is_empty());
    // The 3 mm side folded into its collinear neighbour with the area preserved.
    let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 0.), &runs, &tolerances);
    assert!(gated_failures(&rows).is_empty(), "{:?}", gated_failures(&rows));
    let merged = row(&rows, "faceKeysKernelMerged").expect("named outcome");
    assert_eq!((merged.value, merged.gated), (1., false));
    assert_eq!(merged.reason.as_deref(), Some("#19:side(0,1) into #19:side(0,0) (3.000 mm)"));
}

#[test]
fn ruling_3_dropped_non_collinear_face_still_fails() {
    let tolerances = tolerances::registered().unwrap();
    // A 2.8 mm chamfer at the corner: short enough, but not on the bottom line.
    let text = with_profile(&[[0., 0.], [1.998, 0.], [2., 0.002], [2., 1.], [0., 1.]]);
    let (expected, runs) = faces_of(&text);
    assert!(runs.is_empty(), "{runs:?}");
    let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 0.), &runs, &tolerances);
    assert!(row(&rows, "faceKeysKernelMerged").is_none());
    assert_eq!(gated_failures(&rows), ["faceKeys", "faceAreaLinear"]);
    // A collinear profile cannot excuse dropping a side that is not on the run either.
    let (expected, runs) = faces_of(&split_bottom([1.997, 0.]));
    let rows = compare(&expected, &folded(&expected, "#19:side(0,2)", "#19:side(0,1)", 0.), &runs, &tolerances);
    assert_eq!(gated_failures(&rows), ["faceKeys", "faceAreaLinear"]);
}

#[test]
fn ruling_3_area_mismatch_still_fails() {
    let tolerances = tolerances::registered().unwrap();
    let (expected, runs) = faces_of(&split_bottom([1.997, 0.]));
    // The neighbour carries 1e-6 more than both source areas: beyond the frozen 1e-9.
    let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 1e-6), &runs, &tolerances);
    assert!(row(&rows, "faceKeysKernelMerged").is_none());
    assert_eq!(gated_failures(&rows), ["faceKeys", "faceAreaLinear"]);
    // Dropped outright, the area is simply lost.
    let mut lost: BTreeMap<_, _> = expected.iter().map(|(k, e)| (k.clone(), e.area_m2)).collect();
    lost.remove("#19:side(0,1)");
    assert_eq!(gated_failures(&compare(&expected, &lost, &runs, &tolerances)), ["faceKeys", "faceAreaLinear"]);
}

#[test]
fn ruling_3_wide_face_still_fails() {
    let tolerances = tolerances::registered().unwrap();
    for (start, width) in [([1.995, 0.], 0.005), ([1.9993, 0.], 0.0007)] {
        let (expected, runs) = faces_of(&split_bottom(start));
        assert!((runs[0].widths_m[1] - width).abs() < 1e-12, "{runs:?}");
        let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 0.), &runs, &tolerances);
        assert!(row(&rows, "faceKeysKernelMerged").is_none(), "{width} m");
        assert_eq!(gated_failures(&rows), ["faceKeys", "faceAreaLinear"], "{width} m: outside the 0.8-4 mm window");
    }
}

/// Ruling 16: the ISSUE_129 and dental widths (0.831, 1.595 and 1.795 mm) now pass, with the
/// same collinear and matching-total conditions; a lost area still fails.
#[test]
fn ruling_16_sub_2_mm_collinear_side_merges_by_name_only_if_its_area_matches() {
    let tolerances = tolerances::registered().unwrap();
    for (start, width) in [([1.999169, 0.], 0.000831), ([1.9992, 0.], 0.0008), ([1.998405, 0.], 0.001595), ([1.998205, 0.], 0.001795)] {
        let (expected, runs) = faces_of(&split_bottom(start));
        assert!((runs[0].widths_m[1] - width).abs() < 1e-12, "{runs:?}");
        let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 0.), &runs, &tolerances);
        assert!(gated_failures(&rows).is_empty(), "{width} m: {:?}", gated_failures(&rows));
        assert_eq!(row(&rows, "faceKeysKernelMerged").expect("named outcome").value, 1.);
        // A shortfall past the frozen 1e-9 receiver limit stays red.
        let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 1e-8), &runs, &tolerances);
        assert_eq!(gated_failures(&rows), ["faceKeys", "faceAreaLinear"], "{width} m with a lost area");
    }
}

#[test]
fn ruling_3_key_is_as_wide_as_its_widest_instance() {
    let tolerances = tolerances::registered().unwrap();
    // One solid placed twice at different scales: one key, a 3 mm and a 5 mm side.
    let (expected, runs) = faces_of(&split_bottom([1.997, 0.]));
    let mut wide = runs[0].clone();
    wide.widths_m[1] = 0.005;
    let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 0.), &[runs[0].clone(), wide], &tolerances);
    assert!(row(&rows, "faceKeysKernelMerged").is_none());
    assert_eq!(gated_failures(&rows), ["faceKeys", "faceAreaLinear"]);
}

#[test]
fn ruling_3_authored_window_bounds_survive_width_rounding() {
    let tolerances = tolerances::registered().unwrap();
    for width in [0.0019999999999999996, 0.0040000000000000004] {
        let (expected, mut runs) = faces_of(&split_bottom([1.997, 0.]));
        runs[0].widths_m[1] = width;
        let rows = compare(&expected, &folded(&expected, "#19:side(0,1)", "#19:side(0,0)", 0.), &runs, &tolerances);
        assert!(gated_failures(&rows).is_empty() && row(&rows, "faceKeysKernelMerged").is_some(), "{width}");
    }
}

#[test]
fn ruling_3_many_single_receiver_sides_are_not_capped() {
    let tolerances = tolerances::registered().unwrap();
    // One long side, then 11 collinear 3 mm sides: each has exactly one receiver.
    let mut points = vec![[0., 0.], [1.967, 0.]];
    points.extend((1..=11).map(|i| [1.967 + 0.003 * f64::from(i), 0.]));
    points.extend([[2., 1.], [0., 1.]]);
    let (expected, runs) = faces_of(&with_profile(&points));
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0].keys.len(), 12);
    let mut actual: BTreeMap<_, _> = expected.iter().map(|(k, e)| (k.clone(), e.area_m2)).collect();
    for i in 1..=11 {
        let area = actual.remove(&format!("#19:side(0,{i})")).unwrap();
        *actual.get_mut("#19:side(0,0)").unwrap() += area;
    }
    let rows = compare(&expected, &actual, &runs, &tolerances);
    assert!(gated_failures(&rows).is_empty(), "{:?}", gated_failures(&rows));
    assert_eq!(row(&rows, "faceKeysKernelMerged").map(|r| r.value), Some(11.));
}

/// A 51.3 x 137.1 mm member, 2.9 m long, about 200 m from the origin: the
/// thin-member case that dominated the 560 corpus rows (ISSUE_068, MiniBIM, rvt01).
#[test]
fn ruling_2_exact_is_compared_before_its_f32_storage_rounding() {
    let text = BOX.replace(RECTANGLE, "#18=IFCRECTANGLEPROFILEDEF(.AREA.,$,#17,0.0513,0.1371);")
        .replace("#19=IFCEXTRUDEDAREASOLID(#18,#2,#3,3.);", "#19=IFCEXTRUDEDAREASOLID(#18,#2,#3,2.9);")
        .replace("#20=IFCCARTESIANPOINT((4.,-3.,2.));", "#20=IFCCARTESIANPOINT((203.1234567,-187.6543219,2.0017));");
    let source = 0.0513 * 0.1371 * 2.9;
    let limit = tolerances::registered().unwrap()["exactLinear"]["volumeRelative"].as_f64().unwrap();
    let volume = |exact: &ifc_lite_processing::ProcessingResult| {
        let mut measured = metrics::Metrics::default();
        for mesh in exact.meshes.iter().filter(|m| m.express_id == 27) {
            let points: Vec<_> = mesh.positions.chunks_exact(3)
                .map(|p| exact.frame.to_world(std::array::from_fn(|i| mesh.origin[i] + f64::from(p[i])))).collect();
            measured.add_mesh(&points, &mesh.indices).unwrap();
        }
        assert_eq!(measured.defects, 0);
        metrics::relative(measured.volume, source)
    };
    // The default exact output stores absolute f32: the member is off by more than the frozen limit.
    let stored = volume(&ifc_lite_processing::process_geometry(text.as_bytes()));
    assert!(stored > limit, "fixture must be sensitive to world f32 storage: {stored:e}");
    // Before that rounding, exact agrees with the f64 source (and so with retained) well inside it.
    // What remains is the local frame's storage: one f32 ulp of the 1.45 m half-length
    // over the 51 mm thickness (measured 5.0e-7 here, against 8.7e-5 stored absolute).
    let unrounded = volume(&precision::exact_unrounded(text.as_bytes()));
    assert!(unrounded <= limit / 10., "exact before f32 rounding: {unrounded:e} (stored {stored:e})");
}
