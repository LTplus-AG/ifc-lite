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
use scan_synthetic::{angle_between, half_column_on_floor, room_column_where, cylinder_room, room_with, room_with_facets, twisted_fragments, two_rooms, vertical_strips, ExpectedCylinder, Rng, ScanSpec};
use std::f64::consts::{FRAC_PI_2, TAU};
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
    // The boundary itself: a clean, dense, whole r 0.05 pipe fits well (an
    // explicit 0.03 m minimum finds it), yet the two-voxel default refuses it.
    let whole = ExpectedCylinder { start: [1., 2., 1.5], end: [4., 2., 1.5], radius: 0.05 };
    let dense = room_with(&ScanSpec { density: 9_000., ..Default::default() }, &[(whole.clone(), TAU)]);
    assert!(segment_scan_points(&dense, &ScanSegmentationOptions::default()).unwrap().cylinders.is_empty());
    let explicit = ScanSegmentationOptions { min_cylinder_radius_metres: Some(0.03), ..Default::default() };
    assert_finds_exactly(&segment_scan_points(&dense, &explicit).unwrap(), &[whole]);
}

#[test]
fn issue_6870_an_empty_radius_range_reads_as_radius_refusals() {
    // Review #6878: with the minimum unset it is two voxels, so a maximum
    // under it (or a voxel coarsened past half the maximum) leaves no radius
    // to accept. That must read as refused for radius, not as "no candidate
    // fit the group".
    let pipe = ExpectedCylinder { start: [1., 2., 1.5], end: [4., 2., 1.5], radius: 0.07 };
    let points = room_with(&ScanSpec::default(), &[(pipe, TAU)]);
    let empty = ScanSegmentationOptions { max_cylinder_radius_metres: 0.05, ..Default::default() };
    let report = segment_scan_points(&points, &empty).unwrap();
    let s = &report.stats;
    assert!(report.cylinders.is_empty(), "min 0.06 > max 0.05: {:?}", report.cylinders);
    assert!(s.cylinder_groups >= 1, "{s:?}");
    assert_eq!(s.cylinders_rejected_for_radius, s.cylinder_groups, "{s:?}");
    assert_eq!(s.cylinder_candidates_below_share, 0, "{s:?}");
}

#[test]
fn issue_6870_every_cylinder_refusal_is_counted() {
    // Review #6878 (1): candidates under the inlier share and failed refits
    // used to leave the loop without a stat.
    let (_, report) = scene();
    let s = &report.stats;
    let refused = s.cylinder_candidates_below_share + s.cylinder_refits_failed + s.cylinders_rejected_as_spheres
        + s.cylinders_rejected_for_arc + s.cylinders_rejected_for_length + s.cylinders_rejected_as_duplicates
        + s.cylinders_rejected_for_radius + s.cylinders_rejected_as_facets + s.cylinders_rejected_as_pierced + s.cylinders_rejected_as_sparse
        + s.cylinders_rejected_for_uneven_arc;
    assert!(s.cylinder_candidates_below_share >= 1, "the whole sphere fits no cylinder: {s:?}");
    assert!(refused + report.cylinders.len() as u64 >= s.cylinder_groups, "every group ends in a count: {s:?}");
    // A free-standing 0.4 x 0.4 m panel is under the plane minimum, so its
    // voxels form a group; all its normals are parallel, so no pair defines a
    // candidate at all. That exit is counted too.
    let panel = room_with_facets(&ScanSpec::default(), &[], &[[[2.8, 2., 1.], [0.4, 0., 0.], [0., 0., 0.4]]]);
    let report = segment_scan_points(&panel, &ScanSegmentationOptions::default()).unwrap();
    assert!(report.cylinders.is_empty());
    assert!(report.stats.cylinder_candidates_below_share >= 1, "{:?}", report.stats);
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

#[test]
fn issue_6870_flat_facets_meeting_at_an_angle_are_not_cylinders() {
    // Review of #6878: facets under the plane area minimum never become
    // planes. Within 2 cm a flat facet about 8 cm from a candidate axis
    // matches the radius over roughly +-35 degrees with normals inside the
    // radial gate, and two such facets add up to more than 90 degrees of arc.
    // Apartment.e57 reported two such "cylinders" in wall corners.
    let polar = |angle: f64, length: f64| [3. + length * angle.to_radians().cos(), 2. + length * angle.to_radians().sin()];
    // (name, plan polyline, height range)
    type Decoy = (&'static str, Vec<[f64; 2]>, (f64, f64));
    let decoys: [Decoy; 4] = [
        ("two 0.15 m strips at 90 degrees", vec![polar(0., 0.15), polar(0., 0.), polar(90., 0.15)], (0.7, 2.0)),
        ("two 0.15 m strips at 120 degrees", vec![polar(0., 0.15), polar(0., 0.), polar(120., 0.15)], (0.7, 2.0)),
        // A corner with a 45 degree chamfer: three facets.
        ("chamfered corner", vec![[3.2, 2.], [3.06, 2.], [3., 2.06], [3., 2.2]], (0.7, 2.0)),
        // A narrow 45 degree chamfer across the room corner, floor to ceiling.
        ("corner chamfer strip", vec![[0.1, 0.], [0., 0.1]], (0., 2.7)),
    ];
    let mut refused_as_facets = 0;
    for (name, corners, z) in decoys {
        let spec = ScanSpec { seed: 31, ..Default::default() };
        let positions = room_with_facets(&spec, &[], &vertical_strips(&corners, z));
        let report = segment_scan_points(&positions, &ScanSegmentationOptions::default()).unwrap();
        assert!(report.cylinders.is_empty(), "{name}: {:?}", report.cylinders);
        refused_as_facets += report.stats.cylinders_rejected_as_facets;
    }
    assert!(refused_as_facets >= 3, "the facet guard itself refuses them");
}

#[test]
fn issue_6870_partial_and_wall_flush_pipes_pass_the_facet_guard() {
    // Real round surfaces must still pass the turning test when only part of
    // the circumference is scanned, or when the pipe sits against a wall.
    let along_x = |y: f64, radius: f64| ExpectedCylinder { start: [1., y, 1.5], end: [4., y, 1.5], radius };
    for (name, pipe, arc) in [
        ("half-visible", along_x(2., 0.08), TAU / 2.),
        ("third-visible", along_x(2., 0.08), TAU / 3.),
        ("flush against the wall", along_x(0.09, 0.08), TAU),
        ("sparse (2,500 points/m2)", along_x(2., 0.08), TAU),
    ] {
        let density = if name.starts_with("sparse") { 2_500. } else { 6_000. };
        let spec = ScanSpec { density, ..Default::default() };
        let report = segment_scan_points(&room_with(&spec, &[(pipe.clone(), arc)]), &ScanSegmentationOptions::default()).unwrap();
        assert_eq!(report.cylinders.len(), 1, "{name}: {:?}", report.stats);
        assert!(matches(&report.cylinders[0], &pipe).is_ok(), "{name}: {:?}", matches(&report.cylinders[0], &pipe));
    }
}

#[test]
fn issue_6870_fragments_at_different_heights_are_not_one_cylinder() {
    // Review of #6878: on a real apartment scan, clutter in a wall corner was
    // reported as a cylinder although no height shows a circular arc. Each
    // fragment here is truly curved (the facet guard passes it); only the
    // per-slice arc test sees that the arc is not the same at every height.
    let report = segment_scan_points(&twisted_fragments(&ScanSpec { seed: 31, ..Default::default() }, 90., 45., 9), &ScanSegmentationOptions::default()).unwrap();
    assert!(report.cylinders.is_empty(), "{:?}", report.cylinders);
    assert!(report.stats.cylinders_rejected_for_uneven_arc >= 1, "{:?}", report.stats);
}

#[test]
fn issue_6870_large_and_finely_voxelised_columns_pass_the_facet_guard() {
    // Round 3 review: adjacent voxels on a column many voxels in radius are
    // under 3 degrees apart, so the facet guard measured nothing and refused.
    let fine = ScanSegmentationOptions { voxel_size_metres: 0.01, ..Default::default() };
    let (positions, column) = half_column_on_floor(&ScanSpec { seed: 41, density: 40_000., ..Default::default() }, 0.3);
    assert_finds_exactly(&segment_scan_points(&positions, &fine).unwrap(), &[column]);
    let medium = ScanSegmentationOptions { voxel_size_metres: 0.02, ..Default::default() };
    // (r 0.8 at this voxel is lost before the guards, to plane growth: a
    // separate, known limit of large radii.)
    let (positions, column) = room_column_where(&ScanSpec { seed: 2, ..Default::default() }, 0.6, &|a, _, front| angle_between(a, front) < FRAC_PI_2);
    assert_finds_exactly(&segment_scan_points(&positions, &medium).unwrap(), &[column]);
}

#[test]
fn issue_6870_a_column_occluded_over_most_of_its_height_is_found() {
    // Round 3 review: 180 degrees visible above `z`, only `low` degrees below
    // (furniture in front). Every slice agrees with the same round surface.
    for (z, low) in [(1.6, 80.), (1.8, 60.), (2.0, 75.)] {
        for sigma in [0.003, 0.008] {
            let h = f64::to_radians(low) / 2.;
            let visible = move |a: f64, zz: f64, front: f64| {
                if zz > z { angle_between(a, front) < FRAC_PI_2 } else { angle_between(a, front + FRAC_PI_2 - h) < h }
            };
            let (positions, column) = room_column_where(&ScanSpec { seed: 51, noise_sigma: sigma, ..Default::default() }, 0.3, &visible);
            let report = segment_scan_points(&positions, &ScanSegmentationOptions::default()).unwrap();
            // Two thirds of the height shows 60..80 degrees of arc, so the axis
            // is less constrained: 3 cm axis tolerance here, radius 1 cm.
            assert_eq!(report.cylinders.len(), 1, "z {z}, {low} deg, sigma {sigma}: {:?}", report.stats);
            let found = &report.cylinders[0];
            assert!((found.radius - column.radius).abs() <= RADIUS_TOLERANCE_METRES, "{}", found.radius);
            assert!(off_axis(found, column.start).max(off_axis(found, column.end)) <= 0.03);
        }
    }
}

#[test]
fn issue_6870_overlapping_fragments_that_disagree_by_height_are_refused() {
    // Round 3 review: the apartment's corner clutter showed about a third of
    // its claimed arc per slice. Here 150 degree pieces turned 25 degrees per
    // 0.15 m: neighbouring slices overlap, so the group is one piece covering
    // the circumference, and each piece is truly curved (the facet guard
    // passes it), but only 0.47 of the slices agree with the widest one: just
    // under the 0.5 bar, so a looser bar (0.3) lets it through.
    let positions = twisted_fragments(&ScanSpec { seed: 31, ..Default::default() }, 150., 25., 9);
    let report = segment_scan_points(&positions, &ScanSegmentationOptions::default()).unwrap();
    assert!(report.cylinders.is_empty(), "{:?}", report.cylinders);
    assert!(report.stats.cylinders_rejected_for_uneven_arc >= 1, "{:?}", report.stats);
}

#[test]
fn issue_6870_a_column_with_density_gaps_is_one_cylinder() {
    // Round 3 review (optional): three 0.3 m bands without points used to
    // split the column into four coaxial pieces.
    let gaps = |_: f64, z: f64, _: f64| !(0.5..0.8).contains(&z) && !(1.2..1.5).contains(&z) && !(1.9..2.2).contains(&z);
    let (positions, column) = room_column_where(&ScanSpec { seed: 7, ..Default::default() }, 0.3, &gaps);
    assert_finds_exactly(&segment_scan_points(&positions, &ScanSegmentationOptions::default()).unwrap(), &[column]);
}
