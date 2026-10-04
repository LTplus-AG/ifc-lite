// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plane detection on seeded synthetic scans (#6870).
//!
//! Tolerances, stated once: a recovered plane matches an expected one when
//! their normals agree within `ANGLE_TOLERANCE_DEGREES` (unsigned) and their
//! offsets within `OFFSET_TOLERANCE_METRES`; areas within `AREA_TOLERANCE` of
//! the sampled area (voxel means lose up to a voxel along every boundary and
//! junction); in-plane extents within two voxels plus noise of the sampled
//! extent.

mod scan_synthetic;

use ifc_lite_processing::scan_segmentation::{
    segment_scan_points, NormalSource, PlaneOrientation, ScanPlane, ScanSegmentationOptions,
    ScanSegmentationReport, ScanVoxelizer,
};
use scan_synthetic::{banded_wall, pure_noise, shifted, two_rooms, ExpectedPlane, Kind, Rng, ScanSpec};
use std::sync::OnceLock;

const ANGLE_TOLERANCE_DEGREES: f64 = 1.5;
const OFFSET_TOLERANCE_METRES: f64 = 0.01;
const AREA_TOLERANCE: f64 = 0.12;

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Unsigned match: (angle in degrees, distance in metres of the expected
/// surface's centre from the found plane). Measuring the offset at the surface
/// rather than through `d` keeps a far-away frame origin from amplifying a
/// negligible tilt.
fn mismatch(found: &ScanPlane, expected: &ExpectedPlane) -> (f64, f64) {
    let cos = dot(found.normal, expected.normal);
    let angle = cos.abs().min(1.).acos().to_degrees();
    let offset = (dot(found.normal, expected.center) + found.d).abs();
    (angle, offset)
}

/// The found plane for `expected`: within tolerance, nearest centroid (two
/// rooms' walls share one plane equation).
fn find<'a>(planes: &'a [ScanPlane], expected: &ExpectedPlane) -> Option<(usize, &'a ScanPlane)> {
    let distance = |p: &ScanPlane| (0..3).map(|a| (p.centroid[a] - expected.center[a]).powi(2)).sum::<f64>();
    planes
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            let (angle, offset) = mismatch(p, expected);
            angle <= ANGLE_TOLERANCE_DEGREES && offset <= OFFSET_TOLERANCE_METRES
        })
        .min_by(|a, b| distance(a.1).total_cmp(&distance(b.1)))
}

fn options_with_scanner(scanner: [f64; 3]) -> ScanSegmentationOptions {
    ScanSegmentationOptions { scanner_position: Some(scanner), ..Default::default() }
}

/// The default scan is shared: segmentation in a debug build is the slow part.
fn default_scan() -> &'static (scan_synthetic::SyntheticScan, ScanSegmentationReport) {
    static SCAN: OnceLock<(scan_synthetic::SyntheticScan, ScanSegmentationReport)> = OnceLock::new();
    SCAN.get_or_init(|| {
        let scan = two_rooms(&ScanSpec::default());
        let report = segment_scan_points(&scan.positions, &options_with_scanner(scan.scanner)).unwrap();
        (scan, report)
    })
}

/// Count, normal, offset, area, orientation, extent and fit quality of every
/// sampled plane, with nothing extra reported.
fn assert_recovers(scan: &scan_synthetic::SyntheticScan, report: &ScanSegmentationReport, area_tolerance: f64, max_rms: f64) {
    let summary: Vec<_> = report
        .planes
        .iter()
        .map(|p| (p.normal.map(|v| (v * 1000.).round() / 1000.), (p.d * 1000.).round() / 1000., p.area_square_metres))
        .collect();
    assert_eq!(report.planes.len(), scan.planes.len(), "exactly the sampled planes, no extras: {summary:#?}");
    let mut used = vec![false; report.planes.len()];
    for expected in &scan.planes {
        let (index, found) = find(&report.planes, expected)
            .unwrap_or_else(|| panic!("{} not recovered within tolerance: {summary:#?}", expected.name));
        assert!(!used[index], "{} matched a plane already claimed", expected.name);
        used[index] = true;
        let area_error = (found.area_square_metres - expected.area).abs() / expected.area;
        assert!(area_error <= area_tolerance, "{}: area {} vs {}", expected.name, found.area_square_metres, expected.area);
        let orientation = match expected.kind {
            Kind::Horizontal => PlaneOrientation::Horizontal,
            Kind::Vertical => PlaneOrientation::Vertical,
            Kind::Sloped => PlaneOrientation::Sloped,
        };
        assert_eq!(found.orientation, orientation, "{}", expected.name);
        // Extents: the longer and the shorter in-plane side.
        let mut got = [found.extent.u_length, found.extent.v_length];
        got.sort_by(f64::total_cmp);
        let mut want = [expected.extent.0, expected.extent.1];
        want.sort_by(f64::total_cmp);
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() <= 0.08, "{}: extent {got:?} vs {want:?}", expected.name);
        }
        assert!(found.inlier_points > 0 && found.inlier_voxels > 0);
        assert!(found.rms_metres < max_rms, "{}: rms {}", expected.name, found.rms_metres);
    }
}

#[test]
fn issue_6870_recovers_every_room_plane_within_tolerance() {
    let (scan, report) = default_scan();
    assert_recovers(scan, report, AREA_TOLERANCE, 0.005);
}

#[test]
fn issue_6870_recovers_every_plane_under_heavier_noise_and_density_falloff() {
    // 8 mm noise is beyond a terrestrial scanner's spec at room range; voxel
    // means average it down, but more boundary voxels fail the MAD band, so
    // areas get a looser tolerance (20 %).
    let scan = two_rooms(&ScanSpec { seed: 5, noise_sigma: 0.008, density: 6_000., ..Default::default() });
    let report = segment_scan_points(&scan.positions, &options_with_scanner(scan.scanner)).unwrap();
    assert_recovers(&scan, &report, 0.2, 0.008);
}

#[test]
fn issue_6870_columns_are_not_reported_as_planes() {
    let (scan, report) = default_scan();
    // A strip of a column would be a vertical plane near the column's axis
    // (floor and ceiling centroids may legitimately sit above a column).
    for plane in report.planes.iter().filter(|p| p.orientation == PlaneOrientation::Vertical) {
        for column in &scan.columns {
            let r = (plane.centroid[0] - column.center[0]).hypot(plane.centroid[1] - column.center[1]);
            assert!(r > column.radius + 0.2, "plane at {:?} lies on a column", plane.centroid);
        }
    }
    assert!(report.stats.curved_regions_rejected > 0, "the column strips are rejected as curved");
}

#[test]
fn issue_6870_normals_face_the_scanner_when_its_position_is_given() {
    let (scan, report) = default_scan();
    for expected in scan.planes.iter().filter(|p| p.in_room_a) {
        let (_, found) = find(&report.planes, expected).unwrap_or_else(|| panic!("{} not found", expected.name));
        assert_eq!(found.normal_source, NormalSource::Scanner);
        assert!(dot(found.normal, expected.normal) > 0.99, "{}: {:?}", expected.name, found.normal);
    }
    // Without a scanner the orientation is canonical: horizontal planes face up.
    let unscanned = segment_scan_points(&scan.positions, &ScanSegmentationOptions::default()).unwrap();
    for plane in &unscanned.planes {
        assert_eq!(plane.normal_source, NormalSource::Canonical);
        if plane.orientation == PlaneOrientation::Horizontal {
            assert!(plane.normal[2] > 0.99, "{:?}", plane.normal);
        }
    }
    assert_eq!(unscanned.planes.len(), report.planes.len());
}

#[test]
fn issue_6870_segmentation_is_invariant_to_point_order() {
    let (scan, report) = default_scan();
    let mut shuffled = scan.positions.clone();
    Rng::new(99).shuffle_points(&mut shuffled);
    let again = segment_scan_points(&shuffled, &options_with_scanner(scan.scanner)).unwrap();
    assert_eq!(serde_json::to_string(&again).unwrap(), serde_json::to_string(report).unwrap());
}

#[test]
fn issue_6870_segmentation_is_invariant_to_chunking() {
    let (scan, report) = default_scan();
    let mut voxelizer = ScanVoxelizer::new(&options_with_scanner(scan.scanner)).unwrap();
    let mut rest = &scan.positions[..];
    let mut sizes = [1_usize, 7, 4_096, 77_777, 300_001].iter().cycle();
    while !rest.is_empty() {
        let take = (sizes.next().unwrap() * 3).min(rest.len());
        voxelizer.add_points(&rest[..take]).unwrap();
        rest = &rest[take..];
    }
    let chunked = voxelizer.segment().unwrap();
    assert_eq!(serde_json::to_string(&chunked).unwrap(), serde_json::to_string(report).unwrap());
}

#[test]
fn issue_6870_pure_noise_yields_no_planes() {
    let noise = pure_noise(7, 200_000, 3.);
    let report = segment_scan_points(&noise, &ScanSegmentationOptions::default()).unwrap();
    assert!(report.planes.is_empty(), "{:?}", report.planes.iter().map(|p| p.area_square_metres).collect::<Vec<_>>());
    assert_eq!(report.stats.accepted_points, 200_000);
}

#[test]
fn issue_6870_voxel_budget_coarsens_exactly_and_reports_it() {
    let scan = two_rooms(&ScanSpec { density: 1_500., ..Default::default() });
    let tight = ScanSegmentationOptions { voxel_size_metres: 0.03, max_voxels: 60_000, ..Default::default() };
    let coarse = segment_scan_points(&scan.positions, &tight).unwrap();
    assert!(coarse.stats.coarsenings >= 1, "budget forces at least one doubling");
    assert!(coarse.limits.voxel_budget_coarsened);
    assert!(coarse.stats.voxels <= 60_000);
    // Folding fine voxels into the coarse lattice is exact: identical to
    // voxelizing at the coarse size directly.
    let direct = ScanSegmentationOptions {
        voxel_size_metres: coarse.stats.voxel_size_metres,
        max_voxels: 1_500_000,
        ..Default::default()
    };
    let mut direct = segment_scan_points(&scan.positions, &direct).unwrap();
    assert_eq!(direct.stats.coarsenings, 0);
    direct.stats.coarsenings = coarse.stats.coarsenings;
    direct.limits.voxel_budget_coarsened = true;
    assert_eq!(serde_json::to_string(&direct).unwrap(), serde_json::to_string(&coarse).unwrap());
    // A 12 cm lattice cannot separate the 0.2 m partition's faces any more,
    // but still recovers the floor and both ceilings within tolerance.
    for expected in scan.planes.iter().filter(|p| matches!(p.kind, Kind::Horizontal)) {
        assert!(find(&coarse.planes, expected).is_some(), "{} on the coarse lattice", expected.name);
    }
}

#[test]
fn issue_6870_rejects_bad_options_and_counts_bad_points() {
    let bad = [
        ScanSegmentationOptions { voxel_size_metres: f64::NAN, ..Default::default() },
        ScanSegmentationOptions { voxel_size_metres: 0.001, ..Default::default() },
        ScanSegmentationOptions { max_voxels: 10, ..Default::default() },
        ScanSegmentationOptions { max_normal_angle_degrees: 90., ..Default::default() },
        ScanSegmentationOptions { up_axis: [0., 0., 0.], ..Default::default() },
        ScanSegmentationOptions { scanner_position: Some([f64::INFINITY, 0., 0.]), ..Default::default() },
    ];
    for options in bad {
        assert!(segment_scan_points(&[0., 0., 0.], &options).is_err(), "{options:?}");
    }
    assert!(segment_scan_points(&[0., 0.], &ScanSegmentationOptions::default()).is_err(), "xyz triples only");
    let points = [0., 0., 0., f32::NAN, 0., 0., 2e6, 0., 0., 1., 1., 1.];
    let report = segment_scan_points(&points, &ScanSegmentationOptions::default()).unwrap();
    assert_eq!((report.stats.input_points, report.stats.accepted_points, report.stats.rejected_points), (4, 2, 2));
    let json = r#"{"voxelSizeMetres":0.05,"surprise":1}"#;
    assert!(serde_json::from_str::<ScanSegmentationOptions>(json).is_err(), "unknown fields are refused");
    let parsed: ScanSegmentationOptions = serde_json::from_str(r#"{"voxelSizeMetres":0.05}"#).unwrap();
    assert_eq!(parsed.max_voxels, ScanSegmentationOptions::default().max_voxels);
}

#[test]
fn issue_6870_region_and_origin_frame_the_output() {
    let (scan, _) = default_scan();
    // Crop to room A only and shift the output frame.
    let options = ScanSegmentationOptions {
        region: Some(ifc_lite_processing::scan_segmentation::ScanRegion { min: [-0.5, -0.5, -0.5], max: [5.9, 4.5, 3.5] }),
        origin: [1000., 2000., 300.],
        ..options_with_scanner(scan.scanner)
    };
    let report = segment_scan_points(&scan.positions, &options).unwrap();
    assert!(report.stats.outside_region_points > 0);
    let floor = report.planes.iter().find(|p| p.orientation == PlaneOrientation::Horizontal && p.normal[2] > 0.).unwrap();
    // Floor z = 0 in the scan frame is z = 300 after the origin shift.
    let on_floor = [1003., 2002., 300.];
    assert!((dot(floor.normal, on_floor) + floor.d).abs() < OFFSET_TOLERANCE_METRES, "{:?} {}", floor.normal, floor.d);
    assert!(floor.centroid[0] > 1000. && floor.centroid[0] < 1006.);
    // Room B's walls are outside the region.
    assert!(report.planes.iter().all(|p| p.centroid[0] < 1006.));
}

#[test]
fn issue_6870_coplanar_regions_split_by_a_scan_gap_merge_into_one_plane() {
    // Review M7: disabling the merge must fail this test.
    let wall = banded_wall(&ScanSpec::default());
    let report = segment_scan_points(&wall, &ScanSegmentationOptions::default()).unwrap();
    assert!(report.stats.regions_merged > 0, "{:?}", report.stats);
    assert_eq!(report.planes.len(), 1, "{:?}", report.planes.iter().map(|p| (p.centroid, p.area_square_metres)).collect::<Vec<_>>());
    let wall = &report.planes[0];
    assert!(wall.normal[1].abs() > 0.9999 && wall.d.abs() < 0.005);
    assert!((wall.extent.v_length - 2.7).abs() < 0.08, "spans the gap: {}", wall.extent.v_length);
}

#[test]
fn issue_6870_far_from_origin_coordinates_are_flagged() {
    let scan = two_rooms(&ScanSpec { density: 1_500., ..Default::default() });
    let near = segment_scan_points(&scan.positions, &ScanSegmentationOptions::default()).unwrap();
    assert!(!near.limits.coordinate_precision_degraded);
    // 300 km out, f32 spacing is 3.1 cm: coarser than the 3 cm voxel.
    let far = segment_scan_points(&shifted(&scan.positions, [300_000., 0., 0.]), &ScanSegmentationOptions::default()).unwrap();
    assert!(far.limits.coordinate_precision_degraded, "{:?}", far.stats);
    assert!(far.stats.coordinate_spacing_metres > 0.03, "{}", far.stats.coordinate_spacing_metres);
    // 10 km out the spacing (about 1 mm) is still fine for 3 cm voxels.
    let town = segment_scan_points(&shifted(&scan.positions, [10_000., 0., 0.]), &ScanSegmentationOptions::default()).unwrap();
    assert!(!town.limits.coordinate_precision_degraded, "{}", town.stats.coordinate_spacing_metres);
}

/// Native throughput at 2M points (#6870 perf evidence). Run with
/// `cargo test --release -p ifc-lite-processing --test scan_segmentation_planes -- --ignored --nocapture`.
/// `SCAN_SYNTHETIC_DUMP=<path>` also writes the f32 xyz points for the wasm run.
#[test]
#[ignore]
fn issue_6870_throughput_at_two_million_points() {
    let mut spec = ScanSpec::default();
    let probe = two_rooms(&spec).positions.len() / 3;
    spec.density *= 2_000_000. / probe as f64;
    let scan = two_rooms(&spec);
    let n = scan.positions.len() / 3;
    if let Ok(path) = std::env::var("SCAN_SYNTHETIC_DUMP") {
        let bytes: Vec<u8> = scan.positions.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(path, bytes).unwrap();
    }
    let options = options_with_scanner(scan.scanner);
    let mut best = f64::INFINITY;
    let mut planes = 0;
    for _ in 0..3 {
        let start = std::time::Instant::now();
        let report = segment_scan_points(&scan.positions, &options).unwrap();
        best = best.min(start.elapsed().as_secs_f64());
        planes = report.planes.len();
    }
    println!("scan segmentation: {n} points, {planes} planes, best {best:.3} s, {:.0} points/s", n as f64 / best);
}
