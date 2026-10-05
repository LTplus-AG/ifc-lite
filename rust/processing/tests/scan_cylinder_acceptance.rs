// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinder acceptance table (#6870): the recall/precision matrix that guards
//! every threshold in `scan_segmentation::cylinder` and `cylinder_guards`.
//! Tuning changes are judged here, not by eye.
//!
//! Two tiers over one list of rows:
//! - `asserted_*` (every `cargo test`): each row in a compact room (the walls,
//!   floor and ceiling within about a metre of the feature), seed 101 at 3 mm
//!   and seed 102 at 8 mm noise. Real rows must hit in both runs (r 0.06 at a
//!   3 cm voxel, the two-voxel minimum radius itself, in at least one); decoy
//!   rows must report nothing in either.
//! - `full_matrix` (`#[ignore]`; run it after any tuning change with
//!   `cargo test -p ifc-lite-processing --test scan_cylinder_acceptance -- --ignored --nocapture`):
//!   the review's full 6 x 4 x 2.7 m room, seeds 101..=103 at 3 and 8 mm (6
//!   runs per row), 12 mm and the resolution-limit rows printed only.
//!
//! In the full matrix each real row must find its cylinder in at least
//! `required` of 6 runs (5; 6 for whole surfaces; 4 for r 0.06 at a 3 cm
//! voxel, which is the two-voxel minimum radius itself, so fits just under it
//! are refused by design). A
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
use scan_matrix::{Size, Truth};

const SEEDS: [u64; 3] = [101, 102, 103];
const ASSERTED_NOISE: [f64; 2] = [0.003, 0.008];
const INFORMATIONAL_NOISE: f64 = 0.012;
/// The asserted tier's two runs: (seed, noise).
const QUICK_RUNS: [(u64, f64); 2] = [(101, 0.003), (102, 0.008)];

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

type RealScene = fn(Size, u64, f64) -> (Vec<f32>, Truth);
type DecoyScene = fn(Size, u64, f64) -> Vec<f32>;

/// A real surface that must be found: `required` of the full matrix's 6
/// runs, `quick` of the asserted tier's 2.
struct Real {
    name: &'static str,
    voxel: f64,
    radius_tolerance: f64,
    required: usize,
    quick: usize,
    scene: RealScene,
}

struct Decoy {
    name: &'static str,
    voxel: f64,
    scene: DecoyScene,
}

const fn real(name: &'static str, voxel: f64, radius_tolerance: f64, required: usize, quick: usize, scene: RealScene) -> Real {
    Real { name, voxel, radius_tolerance, required, quick, scene }
}

/// Thin, half-visible pipes at 2 to 2.3 voxels of radius (DN100-125 at the
/// default voxel), seen from one side only; columns whole, half-visible,
/// out of round, strapped and occluded.
const REAL: [Real; 13] = [
    real("half pipe r0.06", 0.03, 0.01, 4, 1, |z, seed, s| scan_matrix::x_pipe(z, seed, s, 0.06, true)),
    real("half pipe r0.065", 0.03, 0.01, 5, 2, |z, seed, s| scan_matrix::x_pipe(z, seed, s, 0.065, true)),
    real("half pipe r0.07", 0.03, 0.01, 5, 2, |z, seed, s| scan_matrix::x_pipe(z, seed, s, 0.07, true)),
    real("half pipe r0.1", 0.05, 0.01, 5, 2, |z, seed, s| scan_matrix::x_pipe(z, seed, s, 0.1, true)),
    real("half pipe r0.11", 0.05, 0.01, 5, 2, |z, seed, s| scan_matrix::x_pipe(z, seed, s, 0.11, true)),
    real("grazing ceiling pipe r0.1", 0.05, 0.01, 5, 2, scan_matrix::grazing_ceiling_pipe),
    real("full pipe r0.08", 0.03, 0.01, 6, 2, |z, seed, s| scan_matrix::x_pipe(z, seed, s, 0.08, false)),
    real("full column r0.3", 0.03, 0.01, 6, 2, |z, seed, s| scan_matrix::full_column(z, seed, s, 0.3)),
    real("half column r0.3", 0.03, 0.01, 6, 2, |z, seed, s| scan_matrix::half_column(z, seed, s, 0.3)),
    real("half column r0.12", 0.03, 0.01, 5, 2, |z, seed, s| scan_matrix::half_column(z, seed, s, 0.12)),
    real("half ellipse 0.3 x 0.27", 0.03, 0.02, 5, 2, scan_matrix::half_ellipse),
    real("column + strapped conduit + sign", 0.03, 0.01, 5, 2, scan_matrix::strapped_column),
    real("column, 60 deg visible below 1.8 m", 0.03, 0.01, 5, 2, |z, seed, s| scan_matrix::occluded_column(z, seed, s, 1.8, 60.)),
];

const DECOYS: [Decoy; 6] = [
    Decoy { name: "facet pair 90 deg, 0.15 m", voxel: 0.03, scene: |z, seed, s| scan_matrix::facet_pair(z, seed, s, 90., 0.15) },
    Decoy { name: "facet pair 90 deg, 0.15 m", voxel: 0.05, scene: |z, seed, s| scan_matrix::facet_pair(z, seed, s, 90., 0.15) },
    Decoy { name: "facet pair 120 deg, 0.15 m", voxel: 0.03, scene: |z, seed, s| scan_matrix::facet_pair(z, seed, s, 120., 0.15) },
    Decoy { name: "facet pair 135 deg, 0.12 m", voxel: 0.03, scene: |z, seed, s| scan_matrix::facet_pair(z, seed, s, 135., 0.12) },
    Decoy { name: "corner chamfer 45 deg", voxel: 0.03, scene: scan_matrix::corner_chamfer },
    Decoy { name: "corner chamfer 45 deg", voxel: 0.05, scene: scan_matrix::corner_chamfer },
];

/// Past the stated resolution limit: printed by the full matrix, never asserted.
const LIMITS: [Decoy; 3] = [
    Decoy { name: "three facets, 45 deg steps", voxel: 0.03, scene: scan_matrix::three_facets },
    Decoy { name: "three facets, 45 deg steps", voxel: 0.05, scene: scan_matrix::three_facets },
    Decoy { name: "facet pair 90 deg, 0.1 m", voxel: 0.03, scene: |z, seed, s| scan_matrix::facet_pair(z, seed, s, 90., 0.1) },
];

/// (hit, false positives) for one run. With a hit, every other cylinder is a
/// false positive, a second or wrong-radius one on the true axis included;
/// without one, a wrong-radius fit of the true pipe is the miss itself, and
/// only cylinders off its axis count.
fn run_real(row: &Real, size: Size, seed: u64, sigma: f64) -> (bool, usize) {
    let (points, truth) = (row.scene)(size, seed, sigma);
    let report = segment_scan_points(&points, &options(row.voxel)).unwrap();
    let hit = report.cylinders.iter().any(|c| matches(c, &truth, row.radius_tolerance));
    let extra = if hit { report.cylinders.len() - 1 } else { report.cylinders.iter().filter(|c| !axis_matches(c, &truth)).count() };
    (hit, extra)
}

fn run_decoy(row: &Decoy, size: Size, seed: u64, sigma: f64) -> usize {
    segment_scan_points(&(row.scene)(size, seed, sigma), &options(row.voxel)).unwrap().cylinders.len()
}

fn quick_real(rows: &[Real]) {
    for row in rows {
        let runs: Vec<(bool, usize)> = QUICK_RUNS.iter().map(|&(seed, sigma)| run_real(row, Size::Compact, seed, sigma)).collect();
        let hits = runs.iter().filter(|r| r.0).count();
        let false_positives: usize = runs.iter().map(|r| r.1).sum();
        println!("QUICK {:<34} v{:<5} found {hits}/2 (required {}), false positives {false_positives}", row.name, row.voxel, row.quick);
        assert!(hits >= row.quick, "{} v{}: found {hits}/2, required {}", row.name, row.voxel, row.quick);
        assert_eq!(false_positives, 0, "{} v{}: false cylinders", row.name, row.voxel);
    }
}

fn quick_decoys(rows: &[Decoy]) {
    for row in rows {
        let found: usize = QUICK_RUNS.iter().map(|&(seed, sigma)| run_decoy(row, Size::Compact, seed, sigma)).sum();
        println!("QUICK {:<34} v{:<5} false positives {found}", row.name, row.voxel);
        assert_eq!(found, 0, "{} v{}: reported {found} cylinder(s)", row.name, row.voxel);
    }
}

// The asserted tier, split so the harness runs it on several threads.
#[test]
fn asserted_thin_pipes() {
    quick_real(&REAL[..6]);
}
#[test]
fn asserted_pipes_and_columns() {
    quick_real(&REAL[6..]);
}
#[test]
fn asserted_decoys() {
    quick_decoys(&DECOYS);
}

/// The review's full matrix in the full room: 6 asserted runs per row, 12 mm
/// and the resolution-limit rows printed. About 20 CPU-minutes in a debug
/// build (one thread per row); run it after any change to a cylinder threshold:
/// `cargo test -p ifc-lite-processing --test scan_cylinder_acceptance -- --ignored --nocapture`
#[test]
#[ignore]
fn full_matrix() {
    // One thread per row: (line, passed).
    let real = |row: &Real| {
        let (mut hits, mut false_positives) = (0, 0);
        for sigma in ASSERTED_NOISE {
            for seed in SEEDS {
                let (hit, extra) = run_real(row, Size::Full, seed, sigma);
                hits += usize::from(hit);
                false_positives += extra;
            }
        }
        let (info, _) = run_real(row, Size::Full, SEEDS[0], INFORMATIONAL_NOISE);
        let line = format!("TABLE {:<34} v{:<5} found {hits}/6 (required {}), false positives {false_positives}, 12 mm: {}", row.name, row.voxel, row.required, if info { "found" } else { "missed" });
        (line, hits >= row.required && false_positives == 0)
    };
    let runs = || ASSERTED_NOISE.iter().flat_map(|&sigma| SEEDS.map(|seed| (seed, sigma)));
    let decoy = |row: &Decoy| {
        let found: usize = runs().map(|(seed, sigma)| run_decoy(row, Size::Full, seed, sigma)).sum();
        let info = run_decoy(row, Size::Full, SEEDS[0], INFORMATIONAL_NOISE);
        (format!("TABLE {:<34} v{:<5} false positives {found} in 6 runs, 12 mm: {info}", row.name, row.voxel), found == 0)
    };
    let limit = |row: &Decoy| {
        let found = runs().filter(|&(seed, sigma)| run_decoy(row, Size::Full, seed, sigma) > 0).count();
        (format!("TABLE {:<34} v{:<5} (resolution limit, not asserted) reported in {found}/6 runs", row.name, row.voxel), true)
    };
    let results: Vec<(String, bool)> = std::thread::scope(|scope| {
        let handles: Vec<_> = REAL
            .iter()
            .map(|row| scope.spawn(move || real(row)))
            .chain(DECOYS.iter().map(|row| scope.spawn(move || decoy(row))))
            .chain(LIMITS.iter().map(|row| scope.spawn(move || limit(row))))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for (line, _) in &results {
        println!("{line}");
    }
    let failures: Vec<&String> = results.iter().filter(|r| !r.1).map(|r| &r.0).collect();
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn issue_6870_a_column_on_a_plinth_is_two_cylinders() {
    // Round 4 review: a narrower coaxial column standing on a wider one (a
    // plinth) used to join into one r 0.3 cylinder under the 25 % radius
    // ratio. Radii must agree within about a voxel to join.
    for upper in [0.24, 0.25] {
        let (points, truths) = scan_matrix::plinth(Size::Compact, 61, 0.003, upper);
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
