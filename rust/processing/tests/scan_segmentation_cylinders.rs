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
use scan_synthetic::{cylinder_room, room_with, two_rooms, ExpectedCylinder, Rng, ScanSpec};
use std::f64::consts::TAU;
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
    // The wall/floor and wall/ceiling creases never become cylinders: their
    // voxels touch planes and stay out of every group (the exact count above).
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

#[test]
fn issue_6870_finds_a_column_three_centimetres_from_a_room_corner() {
    // Review #6878 (1): the wall-edge voxels used to join the column's group
    // and push its share under 60 %, so the column was never found.
    let column = ExpectedCylinder::vertical([0.33, 0.33], 0.3, (0., 2.7));
    let positions = room_with(&ScanSpec::default(), &[(column.clone(), TAU)]);
    let report = segment_scan_points(&positions, &ScanSegmentationOptions::default()).unwrap();
    assert_finds_exactly(&report, &[column]);
}

#[test]
fn issue_6870_a_pipe_near_a_wall_is_reported_once() {
    // Review #6878 (2): r 0.05, 8 cm from the wall, used to come out twice.
    // A 2 cm voxel keeps r 0.05 above the minimum radius (2 voxels).
    let pipe = ExpectedCylinder { start: [1., 0.13, 1.5], end: [4., 0.13, 1.5], radius: 0.05 };
    let positions = room_with(&ScanSpec { density: 9_000., ..Default::default() }, &[(pipe.clone(), TAU)]);
    let options = ScanSegmentationOptions { voxel_size_metres: 0.02, ..Default::default() };
    let report = segment_scan_points(&positions, &options).unwrap();
    assert_finds_exactly(&report, &[pipe]);
}

#[test]
fn issue_6870_minimum_radius_defaults_to_two_voxels() {
    // Review #6878 (3): below two voxels a circumference cannot carry its
    // curvature (a half-visible r 0.05 pipe came out as r 0.0685).
    let thin = ExpectedCylinder { start: [1., 2., 1.5], end: [4., 2., 1.5], radius: 0.05 };
    let half = room_with(&ScanSpec::default(), &[(thin, TAU / 2.)]);
    let report = segment_scan_points(&half, &ScanSegmentationOptions::default()).unwrap();
    assert!(report.cylinders.is_empty(), "r 0.05 is under 2 x 3 cm: {:?}", report.cylinders);
    // Just above the boundary (r 0.07 > 0.06) a pipe is found at the default.
    let pipe = ExpectedCylinder { start: [1., 2., 1.5], end: [4., 2., 1.5], radius: 0.07 };
    let report = segment_scan_points(&room_with(&ScanSpec::default(), &[(pipe.clone(), TAU)]), &ScanSegmentationOptions::default()).unwrap();
    assert_finds_exactly(&report, &[pipe]);
    // An explicit minimum still applies, and must not undercut the voxel floor silently.
    let explicit = ScanSegmentationOptions { min_cylinder_radius_metres: Some(0.1), ..Default::default() };
    assert!(segment_scan_points(&half, &explicit).unwrap().cylinders.is_empty());
}

#[test]
fn issue_6870_every_cylinder_refusal_is_counted() {
    // Review #6878 (1): candidates under the inlier share and failed refits
    // used to leave the loop without a stat.
    let (_, report) = scene();
    let s = &report.stats;
    let refused = s.cylinder_candidates_below_share + s.cylinder_refits_failed + s.cylinders_rejected_as_spheres
        + s.cylinders_rejected_for_arc + s.cylinders_rejected_for_length + s.cylinders_rejected_as_duplicates
        + s.cylinders_rejected_for_radius + s.cylinders_rejected_as_sparse;
    assert!(s.cylinder_candidates_below_share >= 1, "the whole sphere fits no cylinder: {s:?}");
    assert!(refused + report.cylinders.len() as u64 >= s.cylinder_groups, "every group ends in a count: {s:?}");
}

#[test]
fn issue_6870_one_surface_found_twice_is_reported_once() {
    // Review #6878 (2). These seeds each produce a second, near-identical
    // cylinder (a refit of the leftover voxels after the first was accepted)
    // when duplicate suppression is off.
    let column = ExpectedCylinder::vertical([0.33, 0.33], 0.3, (0., 2.7));
    let pipe = ExpectedCylinder { start: [1., 2., 1.5], end: [4., 2., 1.5], radius: 0.08 };
    let mut suppressed = 0;
    for (expected, spec) in [
        (column, ScanSpec { seed: 3, density: 6_000., ..Default::default() }),
        (pipe, ScanSpec { seed: 1, density: 6_000., noise_sigma: 0.008, ..Default::default() }),
    ] {
        let report = segment_scan_points(&room_with(&spec, &[(expected.clone(), TAU)]), &ScanSegmentationOptions::default()).unwrap();
        assert_finds_exactly(&report, &[expected]);
        suppressed += report.stats.cylinders_rejected_as_duplicates;
    }
    // The second find is refused as a duplicate (or, when it is a loose fit,
    // as sparse); at least one case needs the duplicate test itself.
    assert!(suppressed >= 1);
}

#[test]
fn issue_6870_noisy_pipes_are_found_across_seeds() {
    // 1 cm noise on an r 0.1 pipe: the best raw RANSAC draw can fit under 60 %
    // while its least-squares refit fits nearly all (seed 2 was missed).
    let pipe = ExpectedCylinder { start: [1., 2., 1.5], end: [4., 2., 1.5], radius: 0.1 };
    for seed in [1, 2, 3] {
        let spec = ScanSpec { seed, density: 6_000., noise_sigma: 0.01, ..Default::default() };
        let report = segment_scan_points(&room_with(&spec, &[(pipe.clone(), TAU)]), &ScanSegmentationOptions::default()).unwrap();
        assert_finds_exactly(&report, std::slice::from_ref(&pipe));
    }
}
