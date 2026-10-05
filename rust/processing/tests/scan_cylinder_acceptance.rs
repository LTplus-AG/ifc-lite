// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinder acceptance table (#6870): the recall/precision matrix that guards
//! every threshold in `scan_segmentation::cylinder` and `cylinder_guards`.
//! Tuning changes are judged here, not by eye.
//!
//! Each real row runs seeds 101..=103 at 3 and 8 mm noise (6 runs) and must
//! find its cylinder in at least `required` of them (5 of 6; 6 of 6 for whole
//! surfaces; 4 of 6 for r 0.06 at a 3 cm voxel, which is the two-voxel
//! minimum radius itself, so fits just under it are refused by design). A
//! hit is: axis within 2 degrees, axis line within 3 cm of the truth's,
//! radius within 1 cm (2 cm for the ellipse, against its mean radius). A
//! cylinder on the right axis with the wrong radius is a miss; a cylinder off
//! every true axis is a false positive, and no row may have one. Each decoy
//! row runs the same 6 and must never report a cylinder. 12 mm noise is run
//! once per row and printed, never asserted.
//!
//! Stated limit, printed but not asserted: flat faces narrower than about
//! 3.5 voxels (a three-facet pier of 0.1 m faces, a 90 degree pair of 0.1 m
//! strips at 3 cm voxels) are found as cylinders. Their best-fit circle
//! deviates by under 1 cm (a third of a voxel), and every measured property
//! (trimmed radial deviation 3.1..4.9 degrees, turning 0.73..0.84,
//! cross-section curvature 0.64..1.13, slice agreement 1.0, coverage 0.84,
//! no piercing) lies inside the range of real r 0.06..0.12 pipes; refusing
//! them would refuse those pipes. They are resolved at 2 cm voxels and 3 mm
//! noise.
//!
//! Every row is its own test so the harness runs them in parallel.

mod scan_matrix;

use ifc_lite_processing::scan_segmentation::{segment_scan_points, ScanCylinder, ScanSegmentationOptions};
use scan_matrix::Truth;

const SEEDS: [u64; 3] = [101, 102, 103];
const ASSERTED_NOISE: [f64; 2] = [0.003, 0.008];
const INFORMATIONAL_NOISE: f64 = 0.012;

fn options(voxel: f64) -> ScanSegmentationOptions {
    ScanSegmentationOptions { voxel_size_metres: voxel, ..Default::default() }
}

fn axis_matches(found: &ScanCylinder, truth: &Truth) -> bool {
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let angle = dot(found.axis_direction, truth.axis).abs().min(1.).acos().to_degrees();
    let off = |p: [f64; 3]| {
        let d = [p[0] - found.axis_start[0], p[1] - found.axis_start[1], p[2] - found.axis_start[2]];
        let along = dot(d, found.axis_direction);
        (dot(d, d) - along * along).max(0.).sqrt()
    };
    let far = std::array::from_fn(|k| truth.point[k] + truth.axis[k]);
    angle <= 2. && off(truth.point).max(off(far)) <= 0.03
}

fn matches(found: &ScanCylinder, truth: &Truth, radius_tolerance: f64) -> bool {
    axis_matches(found, truth) && (found.radius - truth.radius).abs() <= radius_tolerance
}

/// Runs a real row; returns (found exactly, runs) over the asserted runs and
/// prints every run, the 12 mm one included.
fn real_row(name: &str, voxel: f64, radius_tolerance: f64, required: usize, scene: &dyn Fn(u64, f64) -> (Vec<f32>, Truth)) {
    let mut hits = 0;
    let mut extras = Vec::new();
    for sigma in ASSERTED_NOISE {
        for seed in SEEDS {
            let (points, truth) = scene(seed, sigma);
            let report = segment_scan_points(&points, &options(voxel)).unwrap();
            let good = report.cylinders.iter().filter(|c| matches(c, &truth, radius_tolerance)).count();
            hits += usize::from(good >= 1);
            extras.extend(report.cylinders.iter().filter(|c| !axis_matches(c, &truth)).map(|c| (seed, sigma, c.radius, c.axis_start)));
            println!("ROW {name} v{voxel} s{sigma} seed{seed}: {} cylinder(s), match {}", report.cylinders.len(), good >= 1);
        }
    }
    let (points, truth) = scene(SEEDS[0], INFORMATIONAL_NOISE);
    let report = segment_scan_points(&points, &options(voxel)).unwrap();
    let info = report.cylinders.iter().any(|c| matches(c, &truth, radius_tolerance));
    println!("TABLE {name:<34} v{voxel:<5} found {hits}/6 (required {required}), extras {}, 12 mm: {}", extras.len(), if info { "found" } else { "missed" });
    assert!(hits >= required, "{name}: found {hits}/6, required {required}");
    assert!(extras.is_empty(), "{name}: false cylinders {extras:?}");
}

/// A decoy past the stated resolution limit: printed, never asserted.
fn limit_row(name: &str, voxel: f64, scene: &dyn Fn(u64, f64) -> Vec<f32>) {
    let mut found = 0;
    for sigma in ASSERTED_NOISE {
        for seed in SEEDS {
            found += usize::from(!segment_scan_points(&scene(seed, sigma), &options(voxel)).unwrap().cylinders.is_empty());
        }
    }
    println!("TABLE {name:<34} v{voxel:<5} (resolution limit, not asserted) reported in {found}/6 runs");
}

fn decoy_row(name: &str, voxel: f64, scene: &dyn Fn(u64, f64) -> Vec<f32>) {
    let mut false_positives = Vec::new();
    for sigma in ASSERTED_NOISE {
        for seed in SEEDS {
            let report = segment_scan_points(&scene(seed, sigma), &options(voxel)).unwrap();
            false_positives.extend(report.cylinders.iter().map(|c| (seed, sigma, c.radius, c.arc_degrees)));
        }
    }
    let info = segment_scan_points(&scene(SEEDS[0], INFORMATIONAL_NOISE), &options(voxel)).unwrap().cylinders.len();
    println!("TABLE {name:<34} v{voxel:<5} false positives {}/6 runs, 12 mm: {info}", false_positives.len());
    assert!(false_positives.is_empty(), "{name}: {false_positives:?}");
}

// Thin, half-visible pipes at 2 to 2.3 voxels of radius (DN100-125 at the
// default voxel), seen from one side only.
#[test]
fn table_half_pipe_r0060_v003() {
    real_row("half pipe r0.06", 0.03, 0.01, 4, &|seed, s| scan_matrix::x_pipe(seed, s, 0.06, true));
}
#[test]
fn table_half_pipe_r0065_v003() {
    real_row("half pipe r0.065", 0.03, 0.01, 5, &|seed, s| scan_matrix::x_pipe(seed, s, 0.065, true));
}
#[test]
fn table_half_pipe_r0070_v003() {
    real_row("half pipe r0.07", 0.03, 0.01, 5, &|seed, s| scan_matrix::x_pipe(seed, s, 0.07, true));
}
#[test]
fn table_half_pipe_r0100_v005() {
    real_row("half pipe r0.1", 0.05, 0.01, 5, &|seed, s| scan_matrix::x_pipe(seed, s, 0.1, true));
}
#[test]
fn table_half_pipe_r0110_v005() {
    real_row("half pipe r0.11", 0.05, 0.01, 5, &|seed, s| scan_matrix::x_pipe(seed, s, 0.11, true));
}
#[test]
fn table_grazing_ceiling_pipe_v005() {
    real_row("grazing ceiling pipe r0.1", 0.05, 0.01, 5, &scan_matrix::grazing_ceiling_pipe);
}
#[test]
fn table_full_pipe_r0080_v003() {
    real_row("full pipe r0.08", 0.03, 0.01, 6, &|seed, s| scan_matrix::x_pipe(seed, s, 0.08, false));
}
#[test]
fn table_full_column_r030_v003() {
    real_row("full column r0.3", 0.03, 0.01, 6, &|seed, s| scan_matrix::full_column(seed, s, 0.3));
}
#[test]
fn table_half_column_r030_v003() {
    real_row("half column r0.3", 0.03, 0.01, 6, &|seed, s| scan_matrix::half_column(seed, s, 0.3));
}
#[test]
fn table_half_column_r012_v003() {
    real_row("half column r0.12", 0.03, 0.01, 5, &|seed, s| scan_matrix::half_column(seed, s, 0.12));
}
#[test]
fn table_half_ellipse_v003() {
    real_row("half ellipse 0.3 x 0.27", 0.03, 0.02, 5, &scan_matrix::half_ellipse);
}
#[test]
fn table_strapped_column_v003() {
    real_row("column + strapped conduit + sign", 0.03, 0.01, 5, &scan_matrix::strapped_column);
}
#[test]
fn table_occluded_column_v003() {
    real_row("column, 60 deg visible below 1.8 m", 0.03, 0.01, 5, &|seed, s| scan_matrix::occluded_column(seed, s, 1.8, 60.));
}

#[test]
fn table_decoy_facet_pair_90_v003() {
    decoy_row("facet pair 90 deg, 0.15 m", 0.03, &|seed, s| scan_matrix::facet_pair(seed, s, 90., 0.15));
}
#[test]
fn table_decoy_facet_pair_120_v003() {
    decoy_row("facet pair 120 deg, 0.15 m", 0.03, &|seed, s| scan_matrix::facet_pair(seed, s, 120., 0.15));
}
#[test]
fn table_limit_facet_pair_90_narrow_v003() {
    limit_row("facet pair 90 deg, 0.1 m", 0.03, &|seed, s| scan_matrix::facet_pair(seed, s, 90., 0.1));
}
#[test]
fn table_decoy_facet_pair_135_v003() {
    decoy_row("facet pair 135 deg, 0.12 m", 0.03, &|seed, s| scan_matrix::facet_pair(seed, s, 135., 0.12));
}
#[test]
fn table_decoy_facet_pair_90_v005() {
    decoy_row("facet pair 90 deg, 0.15 m", 0.05, &|seed, s| scan_matrix::facet_pair(seed, s, 90., 0.15));
}
#[test]
fn table_limit_three_facets_v003() {
    limit_row("three facets, 45 deg steps", 0.03, &scan_matrix::three_facets);
}
#[test]
fn table_limit_three_facets_v005() {
    limit_row("three facets, 45 deg steps", 0.05, &scan_matrix::three_facets);
}
#[test]
fn table_decoy_corner_chamfer_v003() {
    decoy_row("corner chamfer 45 deg", 0.03, &scan_matrix::corner_chamfer);
}

#[test]
fn issue_6870_a_column_on_a_plinth_is_two_cylinders() {
    // Round 4 review: a narrower coaxial column standing on a wider one (a
    // plinth) used to join into one r 0.3 cylinder under the 25 % radius
    // ratio. Radii must agree within about a voxel to join.
    for upper in [0.24, 0.25] {
        let (points, truths) = scan_matrix::plinth(61, 0.003, upper);
        let report = segment_scan_points(&points, &options(0.03)).unwrap();
        assert_eq!(report.cylinders.len(), 2, "upper r {upper}: {:?}", report.cylinders.iter().map(|c| c.radius).collect::<Vec<_>>());
        for truth in &truths {
            assert!(report.cylinders.iter().any(|c| matches(c, truth, 0.01)), "upper r {upper}: r {} missing", truth.radius);
        }
    }
}

#[test]
fn issue_6870_a_plane_through_the_inside_is_not_a_solid_cylinder() {
    // Round 4: a scanned flat surface cannot lie inside a solid column or
    // pipe; the walls of an inside corner do cut through the circle a rounded
    // crease fits (the apartment's corner clutter: 0.67 of its slices
    // pierced). The same pipe without the sheet is found.
    let (points, truth) = scan_matrix::pierced_pipe(71, 0.003, false);
    let clean = segment_scan_points(&points, &options(0.03)).unwrap();
    assert!(clean.cylinders.iter().any(|c| matches(c, &truth, 0.01)), "{:?}", clean.stats);
    let (points, _) = scan_matrix::pierced_pipe(71, 0.003, true);
    let pierced = segment_scan_points(&points, &options(0.03)).unwrap();
    assert!(pierced.cylinders.is_empty(), "{:?}", pierced.cylinders);
    assert!(pierced.stats.cylinders_rejected_as_pierced >= 1, "{:?}", pierced.stats);
}
