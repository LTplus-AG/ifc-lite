// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinder detection on seeded synthetic scans (#6870).
//!
//! Tolerances, stated once: a recovered cylinder matches an expected one when
//! its axis is within `AXIS_TOLERANCE_DEGREES` (unsigned), its radius within
//! `RADIUS_TOLERANCE_METRES`, the expected axis passes within
//! `AXIS_OFFSET_TOLERANCE_METRES` of the found axis line, and its length is
//! within `LENGTH_TOLERANCE_METRES` (a column loses up to a voxel or two at
//! each junction with floor and ceiling).

mod scan_synthetic;

use ifc_lite_processing::scan_segmentation::{
    segment_scan_points, AxisOrientation, ScanCylinder, ScanSegmentationOptions, ScanSegmentationReport,
};
use scan_synthetic::{cylinder_room, two_rooms, ExpectedCylinder, Rng, ScanSpec};
use std::sync::OnceLock;

const AXIS_TOLERANCE_DEGREES: f64 = 2.;
const RADIUS_TOLERANCE_METRES: f64 = 0.01;
const AXIS_OFFSET_TOLERANCE_METRES: f64 = 0.015;
const LENGTH_TOLERANCE_METRES: f64 = 0.15;

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Distance of `p` from the found cylinder's axis line.
fn off_axis(found: &ScanCylinder, p: [f64; 3]) -> f64 {
    let d = sub(p, found.axis_start);
    let along = dot(d, found.axis_direction);
    (dot(d, d) - along * along).max(0.).sqrt()
}

fn matches(found: &ScanCylinder, expected: &ExpectedCylinder) -> Result<(), String> {
    let axis = sub(expected.end, expected.start);
    let length = dot(axis, axis).sqrt();
    let angle = (dot(found.axis_direction, axis) / length).abs().min(1.).acos().to_degrees();
    let offset = off_axis(found, expected.start).max(off_axis(found, expected.end));
    let errors = [
        (angle <= AXIS_TOLERANCE_DEGREES, format!("axis off by {angle:.2} deg")),
        ((found.radius - expected.radius).abs() <= RADIUS_TOLERANCE_METRES, format!("radius {} vs {}", found.radius, expected.radius)),
        (offset <= AXIS_OFFSET_TOLERANCE_METRES, format!("axis offset {offset:.4} m")),
        ((found.length - length).abs() <= LENGTH_TOLERANCE_METRES, format!("length {} vs {length}", found.length)),
    ];
    let failed: Vec<_> = errors.into_iter().filter(|(ok, _)| !ok).map(|(_, why)| why).collect();
    if failed.is_empty() { Ok(()) } else { Err(failed.join(", ")) }
}

fn assert_finds_exactly(report: &ScanSegmentationReport, expected: &[ExpectedCylinder]) {
    let summary: Vec<_> = report.cylinders.iter().map(|c| (c.axis_start, c.axis_direction, c.radius, c.length, c.arc_degrees)).collect();
    assert_eq!(report.cylinders.len(), expected.len(), "exactly the sampled cylinders: {summary:#?}");
    for e in expected {
        let results: Vec<_> = report.cylinders.iter().map(|c| matches(c, e)).collect();
        assert!(results.iter().any(Result::is_ok), "{e:?} not recovered: {results:?}");
    }
}

fn scene() -> &'static (scan_synthetic::CylinderScene, ScanSegmentationReport) {
    static SCENE: OnceLock<(scan_synthetic::CylinderScene, ScanSegmentationReport)> = OnceLock::new();
    SCENE.get_or_init(|| {
        let scene = cylinder_room(&ScanSpec::default());
        let options = ScanSegmentationOptions { scanner_position: Some(scene.scanner), ..Default::default() };
        let report = segment_scan_points(&scene.positions, &options).unwrap();
        (scene, report)
    })
}

#[test]
fn issue_6870_recovers_the_column_and_the_pipe_and_refuses_the_decoys() {
    let (scene, report) = scene();
    assert_finds_exactly(report, &scene.cylinders);
    let column = report.cylinders.iter().find(|c| c.orientation == AxisOrientation::Vertical).unwrap();
    assert!(column.arc_degrees > 300., "a free-standing column is seen all round: {}", column.arc_degrees);
    assert!(column.inlier_points > 0 && column.rms_metres < 0.005);
    // Vertical axes point up; the height range spans the column.
    assert!(column.axis_direction[2] > 0.999);
    assert!(column.height_range[0] < 0.1 && column.height_range[1] > 2.6, "{:?}", column.height_range);
    let pipe = report.cylinders.iter().find(|c| c.orientation == AxisOrientation::Horizontal).unwrap();
    assert!((pipe.height_range[0] - 2.2).abs() < 0.02 && (pipe.height_range[1] - 2.2).abs() < 0.02);
    // Each decoy was a candidate the acceptance tests refused.
    let s = &report.stats;
    assert!(s.cylinders_rejected_as_spheres >= 1, "{s:?}");
    assert!(s.cylinders_rejected_for_length >= 1, "{s:?}");
    assert!(s.cylinders_rejected_for_arc >= 1, "{s:?}");
    // The wall/floor and wall/ceiling creases are candidates too; refused.
    assert!(s.cylinders_rejected_as_creases >= 4, "{s:?}");
}

#[test]
fn issue_6870_recovers_both_room_columns_without_disturbing_the_planes() {
    let scan = two_rooms(&ScanSpec::default());
    let options = ScanSegmentationOptions { scanner_position: Some(scan.scanner), ..Default::default() };
    let report = segment_scan_points(&scan.positions, &options).unwrap();
    assert_finds_exactly(&report, &scan.columns);
    assert_eq!(report.planes.len(), scan.planes.len());
}

#[test]
fn issue_6870_cylinders_are_invariant_to_point_order() {
    let (scene, report) = scene();
    let mut shuffled = scene.positions.clone();
    Rng::new(5).shuffle_points(&mut shuffled);
    let options = ScanSegmentationOptions { scanner_position: Some(scene.scanner), ..Default::default() };
    let again = segment_scan_points(&shuffled, &options).unwrap();
    assert_eq!(serde_json::to_string(&again.cylinders).unwrap(), serde_json::to_string(&report.cylinders).unwrap());
}

#[test]
fn issue_6870_cylinder_detection_can_be_switched_off_and_is_bounded() {
    let (scene, report) = scene();
    let off = ScanSegmentationOptions { detect_cylinders: false, ..Default::default() };
    let none = segment_scan_points(&scene.positions, &off).unwrap();
    assert!(none.cylinders.is_empty());
    assert_eq!(none.stats.cylinder_groups, 0);
    assert_eq!(none.planes.len(), report.planes.len(), "planes do not depend on the cylinder pass");
    // A group budget of one examines only the largest group and says so.
    let one = ScanSegmentationOptions { max_cylinder_groups: 1, ..Default::default() };
    let bounded = segment_scan_points(&scene.positions, &one).unwrap();
    assert!(bounded.limits.cylinder_group_limit_hit);
    assert!(bounded.cylinders.len() <= 1);
    assert!(!report.limits.cylinder_group_limit_hit);
}

#[test]
fn issue_6870_pure_noise_yields_no_cylinders() {
    let noise = scan_synthetic::pure_noise(11, 200_000, 3.);
    let report = segment_scan_points(&noise, &ScanSegmentationOptions::default()).unwrap();
    assert!(report.cylinders.is_empty(), "{:?}", report.cylinders);
}
