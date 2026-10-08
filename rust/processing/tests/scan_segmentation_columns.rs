// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Wide round and faceted columns, and the plane/column precedence (#6893).
//! The recall matrix is `scan_cylinder_acceptance.rs`; these pin the
//! mechanisms one at a time on seeded scenes.
//!
//! Tolerances: a column matches when its axis is within 2 degrees of
//! vertical, the axis passes within 3 cm of the true one, and its radius (the
//! circumradius when faceted) is within 1 cm.

mod scan_matrix;

use ifc_lite_processing::scan_segmentation::{segment_scan_points, ScanCylinder, ScanSegmentationOptions, ScanSegmentationReport};
use scan_matrix::columns as cm;
use scan_matrix::{Size, Truth};
use std::f64::consts::PI;

fn options(voxel: f64) -> ScanSegmentationOptions {
    ScanSegmentationOptions { voxel_size_metres: voxel, ..Default::default() }
}

fn matches(c: &ScanCylinder, truth: &Truth) -> bool {
    let off = (c.axis_start[0] - truth.point[0]).hypot(c.axis_start[1] - truth.point[1]);
    c.axis_direction[2] >= 2_f64.to_radians().cos() && off <= 0.03 && (c.radius - truth.radius).abs() <= 0.01
}

/// Vertical planes whose centroid lies within 5 cm of the column's surface
/// band (`inner` to the radius from the axis).
fn planes_on(report: &ScanSegmentationReport, truth: &Truth, inner: f64) -> usize {
    report
        .planes
        .iter()
        .filter(|p| {
            let off = (p.centroid[0] - truth.point[0]).hypot(p.centroid[1] - truth.point[1]);
            p.normal[2].abs() < 0.2 && off >= inner - 0.05 && off <= truth.radius + 0.05
        })
        .count()
}

#[test]
fn issue_6893_a_wide_column_is_one_cylinder_not_a_ring_of_strip_planes() {
    for r in [1.0, 1.5] {
        let (points, truth) = cm::wide_column(Size::Compact, 7, 0.003, r, true);
        let report = segment_scan_points(&points, &options(0.03)).unwrap();
        assert_eq!(report.cylinders.len(), 1, "r {r}: {:?}", report.cylinders);
        let column = &report.cylinders[0];
        assert!(matches(column, &truth) && column.faceted.is_none(), "r {r}: {column:?}");
        // Precedence: the strips leave the plane output (only the floor and
        // the two walls remain) and join the cylinder, whose arc covers them.
        assert_eq!(planes_on(&report, &truth, r), 0, "r {r}: strips still reported");
        assert_eq!(report.planes.len(), 3, "r {r}: {:?}", report.planes.iter().map(|p| p.centroid).collect::<Vec<_>>());
        assert!(report.stats.plane_rings >= 1 && report.stats.planes_absorbed_into_cylinders >= 4, "r {r}: {:?}", report.stats);
        assert!(column.arc_degrees >= 170., "r {r}: arc {}", column.arc_degrees);
    }
}

#[test]
fn issue_6893_column_pieces_cut_apart_by_strip_planes_are_one_cylinder() {
    // At 3 mm noise an r 0.8 column grows two isolated strip planes (no ring)
    // that cut its other voxels into three arcs of 50..70 degrees, each
    // refused alone for the 90 degree minimum arc. Pooled with the strips they
    // are one cylinder.
    let (points, truth) = cm::wide_column(Size::Compact, 101, 0.003, 0.8, true);
    let report = segment_scan_points(&points, &options(0.03)).unwrap();
    assert_eq!(report.cylinders.len(), 1, "{:?}", report.stats);
    assert!(matches(&report.cylinders[0], &truth), "{:?}", report.cylinders[0]);
    assert_eq!(planes_on(&report, &truth, 0.8), 0);
}

#[test]
fn issue_6893_a_twelve_sided_column_reports_its_faces() {
    let phi = 0.1;
    let (points, truth) = cm::polygon_column(Size::Compact, 11, 0.003, 12, 0.7, phi);
    let report = segment_scan_points(&points, &options(0.03)).unwrap();
    assert_eq!(report.cylinders.len(), 1, "{:?}", report.cylinders);
    let column = &report.cylinders[0];
    assert!(matches(column, &truth.cylinder), "{column:?}");
    let facets = column.faceted.as_ref().expect("faceted");
    assert_eq!(facets.faces, 12);
    assert!((facets.apothem - 0.7 * (PI / 12.).cos()).abs() <= 0.01, "{facets:?}");
    // The reported face normal is a true one: within 2 degrees of the truth
    // modulo 30 degrees, and the one nearest +x.
    let angle = facets.face_normal[1].atan2(facets.face_normal[0]);
    let step = PI / 6.;
    let off = (angle - truth.face_angle).rem_euclid(step);
    assert!(off.min(step - off).to_degrees() <= 2., "face normal at {} deg", angle.to_degrees());
    assert!(angle.abs() <= step / 2. + 1e-9, "not the face nearest +x: {} deg", angle.to_degrees());
    assert_eq!(planes_on(&report, &truth.cylinder, facets.apothem), 0, "faces still reported as planes");
}

#[test]
fn issue_6893_a_rectangular_column_stays_four_planes() {
    // A rectangle is not a column of six or more faces: its faces turn 90
    // degrees, beyond the ring's 65. It is reported as its four planes.
    let points = cm::rectangular_column(Size::Compact, 5, 0.003, 0.4, 0.4, false);
    let report = segment_scan_points(&points, &options(0.03)).unwrap();
    assert!(report.cylinders.is_empty(), "{:?}", report.cylinders);
    let faces = report.planes.iter().filter(|p| p.normal[2].abs() < 0.2 && (p.centroid[0] - 3.).hypot(p.centroid[1] - 2.) < 0.3).count();
    assert_eq!(faces, 4);
    assert_eq!(report.stats.planes_absorbed_into_cylinders, 0);
}

#[test]
fn issue_6893_a_polygonal_room_seen_from_inside_is_hollow() {
    // Five faces of an octagon bulging out of the room are a regular ring,
    // but the floor runs inside them: not a solid column.
    let points = cm::polygonal_apse(Size::Compact, 3, 0.003, 1.2);
    let report = segment_scan_points(&points, &options(0.03)).unwrap();
    assert!(report.cylinders.is_empty(), "{:?}", report.cylinders);
    assert!(report.stats.plane_rings_rejected_as_hollow >= 1, "{:?}", report.stats);
    assert_eq!(report.stats.planes_absorbed_into_cylinders, 0);
}

#[test]
fn issue_6893_seeds_follow_the_noise_floor_of_fine_noisy_voxels() {
    // At 8 mm noise on 2 cm voxels at 16,000 points per m^2 under 0.1 % of
    // the voxels passed the 0.02 seed gate and nothing grew, not even the
    // floor; the gate rises to the flattest 5 %. On clean data it stays exactly at
    // the option.
    let (points, truth) = cm::wide_column_dense(Size::Compact, 9, 0.008, 16_000., 0.3, true);
    let report = segment_scan_points(&points, &options(0.02)).unwrap();
    assert!(report.stats.seed_curvature > 0.02, "{:?}", report.stats);
    assert!(report.cylinders.iter().any(|c| matches(c, &truth)), "{:?}", report.cylinders);
    assert_eq!(report.planes.len(), 3);
    let (points, _) = cm::wide_column_dense(Size::Compact, 9, 0.003, 16_000., 0.3, true);
    assert_eq!(segment_scan_points(&points, &options(0.02)).unwrap().stats.seed_curvature, 0.02);
}

#[test]
fn issue_6893_columns_do_not_depend_on_point_order() {
    let (round, _) = cm::wide_column(Size::Compact, 21, 0.008, 1.0, true);
    let (faceted, _) = cm::polygon_column(Size::Compact, 22, 0.008, 8, 0.47, 0.3);
    for points in [round, faceted] {
        let reversed: Vec<f32> = points.chunks_exact(3).rev().flatten().copied().collect();
        let a = segment_scan_points(&points, &options(0.03)).unwrap();
        let b = segment_scan_points(&reversed, &options(0.03)).unwrap();
        assert_eq!(a.cylinders.len(), 1);
        assert_eq!(a, b);
    }
}
