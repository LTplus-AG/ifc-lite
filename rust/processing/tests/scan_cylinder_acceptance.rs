// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinder acceptance table (#6870, #6893): the recall/precision matrix that
//! guards every threshold in `scan_segmentation::cylinder`,
//! `cylinder_guards`, `ring`, `prism` and `columns`. Tuning changes are
//! judged here, not by eye.
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
//! radius within 1 cm (2 cm for the ellipse, against its mean radius), and
//! the right kind: round, or faceted with the right face count and a face
//! normal within 2 degrees of a true one (the radius of a faceted column is
//! its circumradius). A cylinder on the right axis with the wrong radius or
//! kind is a miss; a cylinder off every true axis is a false positive, and so
//! is a plane still reported on the true surface (a surface is reported
//! once); no row may have one. Each decoy row runs the same 6 and must never
//! report a cylinder, nor move a plane into one. 12 mm noise is run once per
//! row and printed, never asserted.
//!
//! #6893 rows: round columns of r 0.8 to 1.5 m (region growing splits them
//! into strips, which `ring` reassembles), 8-, 12- and 16-gon columns with
//! 0.36 m (12 voxel) faces, and columns at a 2 cm voxel with 8 mm noise at
//! 16,000 points per m^2 (6.4 per voxel: before the seed floor nothing at
//! all was found there, not even the floor). Faces
//! under about 10 voxels may come out round (the facet guard cannot see
//! them through the noise), and at 4,000 points per m^2 (1.6 per 2 cm
//! voxel) 8 mm noise is a floor of the 26-neighbour normals:
//! `normalNeighborRings: 2` recovers it (see the guide). Wall decoys: bays,
//! a niche, polygonal and round apses seen from the room, pilasters, an
//! outside corner plain and chamfered, a rectangular column (it stays four
//! planes: a rectangle is not a column of six or more faces) and a staircase
//! core.
//!
//! Stated limit, printed but not asserted: flat faces narrower than about
//! 3.5 voxels (a three-facet pier of 0.1 m faces, a 90 degree pair of 0.1 m
//! strips at 3 cm voxels) are found as cylinders; so is, in some runs, the
//! convex corner of a pilaster with 0.15 m (5 voxel) 45 degree chamfers (its
//! turning ratio 0.46..0.69 straddles the 0.6 bar; unchanged from #6870). Their best-fit circle
//! deviates by under 1 cm (a third of a voxel), and every measured property
//! (trimmed radial deviation 3.1..4.9 degrees, turning 0.73..0.84,
//! cross-section curvature 0.64..1.13, slice agreement 1.0, coverage 0.84,
//! no piercing) lies inside the range of real r 0.06..0.12 pipes; refusing
//! them would refuse those pipes. They are resolved at 2 cm voxels and 3 mm
//! noise.
//!
//! Every row is its own test so the harness runs them in parallel.

mod scan_matrix;

use ifc_lite_processing::scan_segmentation::{segment_scan_points, ScanCylinder, ScanSegmentationOptions, ScanSegmentationReport};
use scan_matrix::columns as cm;
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

/// Round, or faceted with `faces` sides and a face normal at plan angle
/// `face_angle` (radians, about +z).
#[derive(Clone, Copy)]
enum Kind {
    Round,
    Faceted { faces: u32, face_angle: f64 },
}

fn kind_matches(found: &ScanCylinder, kind: Kind) -> bool {
    match (kind, &found.faceted) {
        (Kind::Round, None) => true,
        (Kind::Faceted { faces, face_angle }, Some(f)) => {
            let step = std::f64::consts::TAU / f64::from(faces);
            let off = (f.face_normal[1].atan2(f.face_normal[0]) - face_angle).rem_euclid(step);
            f.faces == faces && off.min(step - off).to_degrees() <= 2.
        }
        _ => false,
    }
}

fn matches(found: &ScanCylinder, truth: &Truth, radius_tolerance: f64) -> bool {
    axis_matches(found, truth) && (found.radius - truth.radius).abs() <= radius_tolerance
}

/// Planes still reported on the true surface (normal across the axis,
/// centroid between the inscribed and the true radius, 5 cm either way): the
/// surface reported twice.
fn doubled(report: &ScanSegmentationReport, truth: &Truth, kind: Kind) -> usize {
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let inner = match kind {
        Kind::Round => truth.radius,
        Kind::Faceted { faces, .. } => truth.radius * (std::f64::consts::PI / f64::from(faces)).cos(),
    };
    let on = |c: [f64; 3]| {
        let d = [c[0] - truth.point[0], c[1] - truth.point[1], c[2] - truth.point[2]];
        let along = dot(d, truth.axis);
        let off = (dot(d, d) - along * along).max(0.).sqrt();
        off >= inner - 0.05 && off <= truth.radius + 0.05
    };
    report.planes.iter().filter(|p| dot(p.normal, truth.axis).abs() < 0.2 && on(p.centroid)).count()
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
    kind: Kind,
    scene: RealScene,
}

struct Decoy {
    name: &'static str,
    voxel: f64,
    scene: DecoyScene,
}

const fn real(name: &'static str, voxel: f64, radius_tolerance: f64, required: usize, quick: usize, scene: RealScene) -> Real {
    Real { name, voxel, radius_tolerance, required, quick, kind: Kind::Round, scene }
}

/// A regular `faces`-gon column of circumradius `r` (one corner at 0.1 rad),
/// half seen: a faceted hit.
const fn faceted(name: &'static str, faces: u32, required: usize, quick: usize, scene: RealScene) -> Real {
    let face_angle = 0.1 + std::f64::consts::PI / faces as f64;
    Real { name, voxel: 0.03, radius_tolerance: 0.01, required, quick, kind: Kind::Faceted { faces, face_angle }, scene }
}

fn polygon(size: Size, seed: u64, sigma: f64, faces: usize, r: f64) -> (Vec<f32>, Truth) {
    let (points, truth) = cm::polygon_column(size, seed, sigma, faces, r, 0.1);
    (points, truth.cylinder)
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

/// #6893: wide round, faceted and fine-voxel columns.
const COLUMNS: [Real; 8] = [
    real("wide column r0.8", 0.03, 0.01, 5, 2, |z, seed, s| cm::wide_column(z, seed, s, 0.8, true)),
    real("wide column r1.0", 0.03, 0.01, 5, 2, |z, seed, s| cm::wide_column(z, seed, s, 1.0, true)),
    real("wide column r1.5", 0.03, 0.01, 5, 2, |z, seed, s| cm::wide_column(z, seed, s, 1.5, true)),
    faceted("8-gon R0.47 (0.36 m faces)", 8, 5, 2, |z, seed, s| polygon(z, seed, s, 8, 0.47)),
    faceted("12-gon R0.70 (0.36 m faces)", 12, 5, 2, |z, seed, s| polygon(z, seed, s, 12, 0.7)),
    faceted("16-gon R0.92 (0.36 m faces)", 16, 5, 2, |z, seed, s| polygon(z, seed, s, 16, 0.92)),
    real("half column r0.3, 16k pts/m2", 0.02, 0.01, 5, 2, |z, seed, s| cm::wide_column_dense(z, seed, s, 16_000., 0.3, true)),
    real("wide column r1.0, 16k pts/m2", 0.02, 0.01, 5, 2, |z, seed, s| cm::wide_column_dense(z, seed, s, 16_000., 1.0, true)),
];

/// #6893: walls that must not pass for a column (nor lose a plane to one).
const WALL_DECOYS: [Decoy; 11] = [
    Decoy { name: "bay window 135 deg, 3 x 0.8 m", voxel: 0.03, scene: |z, seed, s| cm::bay_window(z, seed, s, 0.8) },
    Decoy { name: "bay window 135 deg, 3 x 0.4 m", voxel: 0.03, scene: |z, seed, s| cm::bay_window(z, seed, s, 0.4) },
    Decoy { name: "bay window 135 deg, from outside", voxel: 0.03, scene: |z, seed, s| cm::bay_from_outside(z, seed, s, 0.6) },
    Decoy { name: "niche 0.6 x 0.3 m", voxel: 0.03, scene: |z, seed, s| cm::niche(z, seed, s, 0.6, 0.3) },
    Decoy { name: "octagonal apse R1.2, from inside", voxel: 0.03, scene: |z, seed, s| cm::polygonal_apse(z, seed, s, 1.2) },
    Decoy { name: "round apse r1.5, from inside", voxel: 0.03, scene: |z, seed, s| cm::round_apse(z, seed, s, 1.5) },
    Decoy { name: "pilaster 0.4 x 0.15 m", voxel: 0.03, scene: |z, seed, s| cm::pilaster(z, seed, s, 0.4, 0.15) },
    Decoy { name: "outside corner (L)", voxel: 0.03, scene: cm::l_corner },
    Decoy { name: "outside corner, 0.2 m chamfer", voxel: 0.03, scene: |z, seed, s| cm::chamfered_corner(z, seed, s, 0.2) },
    Decoy { name: "rectangular column 0.4 x 0.4 m", voxel: 0.03, scene: |z, seed, s| cm::rectangular_column(z, seed, s, 0.4, 0.4, true) },
    Decoy { name: "staircase core 2.4 x 1.8 m", voxel: 0.03, scene: |z, seed, s| cm::rectangular_column(z, seed, s, 2.4, 1.8, false) },
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
const LIMITS: [Decoy; 5] = [
    Decoy { name: "three facets, 45 deg steps", voxel: 0.03, scene: scan_matrix::three_facets },
    Decoy { name: "three facets, 45 deg steps", voxel: 0.05, scene: scan_matrix::three_facets },
    Decoy { name: "facet pair 90 deg, 0.1 m", voxel: 0.03, scene: |z, seed, s| scan_matrix::facet_pair(z, seed, s, 90., 0.1) },
    Decoy { name: "pilaster, 0.15 m chamfers", voxel: 0.03, scene: |z, seed, s| cm::chamfered_pilaster(z, seed, s, 0.3, 0.15, 0.25) },
    Decoy { name: "pilaster, 0.15 m chamfers", voxel: 0.05, scene: |z, seed, s| cm::chamfered_pilaster(z, seed, s, 0.3, 0.15, 0.25) },
];

/// (hit, false positives) for one run. With a hit, every other cylinder is a
/// false positive, a second or wrong-radius one on the true axis included;
/// without one, a wrong-radius (or wrong-kind) fit of the true pipe is the
/// miss itself, and only cylinders off its axis count. Planes left on the
/// true surface count too.
fn run_real(row: &Real, size: Size, seed: u64, sigma: f64) -> (bool, usize) {
    let (points, truth) = (row.scene)(size, seed, sigma);
    let report = segment_scan_points(&points, &options(row.voxel)).unwrap();
    let hit = report.cylinders.iter().any(|c| matches(c, &truth, row.radius_tolerance) && kind_matches(c, row.kind));
    let extra = if hit { report.cylinders.len() - 1 } else { report.cylinders.iter().filter(|c| !axis_matches(c, &truth)).count() };
    (hit, extra + doubled(&report, &truth, row.kind))
}

/// Cylinders reported plus planes moved into one: both must be 0.
fn run_decoy(row: &Decoy, size: Size, seed: u64, sigma: f64) -> usize {
    let report = segment_scan_points(&(row.scene)(size, seed, sigma), &options(row.voxel)).unwrap();
    report.cylinders.len() + report.stats.planes_absorbed_into_cylinders as usize
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
#[test]
fn asserted_wide_columns() {
    quick_real(&COLUMNS[..3]);
}
#[test]
fn asserted_faceted_columns() {
    quick_real(&COLUMNS[3..6]);
}
#[test]
fn asserted_fine_voxel_columns() {
    quick_real(&COLUMNS[6..]);
}
#[test]
fn asserted_wall_decoys_bays_and_apses() {
    quick_decoys(&WALL_DECOYS[..6]);
}
#[test]
fn asserted_wall_decoys_corners_and_blocks() {
    quick_decoys(&WALL_DECOYS[6..]);
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
            .chain(&COLUMNS)
            .map(|row| scope.spawn(move || real(row)))
            .chain(DECOYS.iter().chain(&WALL_DECOYS).map(|row| scope.spawn(move || decoy(row))))
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
