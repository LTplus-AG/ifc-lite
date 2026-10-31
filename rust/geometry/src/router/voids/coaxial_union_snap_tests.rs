// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the footprint reconciliation (ratchet-exempt sibling).

use super::*;
use crate::bool2d::union_contours_to_shapes;

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Point2<f64>> {
    vec![
        Point2::new(x0, y0),
        Point2::new(x1, y0),
        Point2::new(x1, y1),
        Point2::new(x0, y1),
    ]
}

/// The ISSUE_129 #12381 layout near y = 3.1: a wide opening, and a narrower
/// one on top of it sharing its left end, `gap` apart.
fn stacked(gap: f64) -> Vec<Vec<Point2<f64>>> {
    vec![rect(21.23, -3.1, 26.83, 3.1), rect(21.23, 3.1 + gap, 25.23, 4.0)]
}


#[test]
fn a_micrometre_gap_leaves_two_shapes_in_the_plain_union() {
    // Without the snap the union keeps the 5 um strip between them: two
    // shapes, two prisms, and the host between them stands.
    assert_eq!(union_contours_to_shapes(&stacked(5e-6)).len(), 2, "the strip separates the footprints");
}

#[test]
fn snapped_flush_footprints_union_to_the_plain_l_shape() {
    for gap in [-5e-6, 1e-6, 5e-6, 1.5e-5] {
        let mut contours = stacked(gap);
        let tau = noise_radius(&contours);
        assert!(snap_onto_earlier(&mut contours, tau) >= 2, "gap {gap}: both seam corners move");
        let shapes = union_contours_to_shapes(&contours);
        assert_eq!(shapes.len(), 1, "gap {gap}");
        assert!(shapes[0].holes.is_empty(), "gap {gap}: no slit hole");
        assert_eq!(shapes[0].outer.len(), 6, "gap {gap}: the L-shape's six corners, no notch");
    }
}

#[test]
fn a_gap_wider_than_the_noise_radius_is_kept() {
    // 68 um: the authored pier the kernel prepass must not weld (#144568).
    let mut contours = stacked(68e-6);
    let tau = noise_radius(&contours);
    assert!(tau < 68e-6, "near the origin the radius is one cell, {tau}");
    assert_eq!(snap_onto_earlier(&mut contours, tau), 0);
    assert_eq!(contours, stacked(68e-6), "nothing moved");
}

#[test]
fn the_radius_is_one_cell_at_any_magnitude() {
    assert_eq!(noise_radius(&[rect(0.0, 0.0, 30.0, 1.0)]), SNAP_GRID);
    assert_eq!(noise_radius(&[rect(1_300.0, 0.0, 1_301.0, 1.0)]), SNAP_GRID);
}

#[test]
fn a_one_step_gap_at_1_3_km_is_not_welded() {
    // 2^-13 m is one f32 step at 1.3 km, eight cells: as wide as a narrow
    // authored pier, so it is left alone, like the kernel prepass leaves it.
    let step = 2f64.powi(-13);
    let gapped = || vec![rect(1_300.0, 0.0, 1_301.0, 3.0), rect(1_300.0, 3.0 + step, 1_300.5, 4.0)];
    let mut contours = gapped();
    assert_eq!(reconcile(&mut contours), 0);
    assert_eq!(contours, gapped());
}

#[test]
fn the_first_contour_never_moves() {
    let mut contours = stacked(5e-6);
    let first = contours[0].clone();
    snap_onto_earlier(&mut contours, 1e-3);
    assert_eq!(contours[0], first);
}

/// The ISSUE_129 #12381 shape the forward pass alone misses: the LATER
/// footprint's flush edge runs past both ends of the earlier one, so none of
/// its vertices is near; the earlier footprint's corners lie on it instead.
fn overhung(gap: f64) -> Vec<Vec<Point2<f64>>> {
    vec![rect(6.825, 16.0, 8.825, 16.57), rect(6.0, 16.57 + gap, 9.5, 17.08)]
}

#[test]
fn the_forward_pass_alone_misses_an_overhanging_later_edge() {
    let mut contours = overhung(1.2e-5);
    let tau = noise_radius(&contours);
    assert_eq!(snap_onto_earlier(&mut contours, tau), 0, "no later vertex is near");
    assert_eq!(union_contours_to_shapes(&contours).len(), 2, "the strip stands");
}

#[test]
fn reconcile_moves_the_earlier_corners_onto_an_overhanging_later_edge() {
    let mut contours = overhung(1.2e-5);
    assert_eq!(reconcile(&mut contours), 2, "the two near corners move");
    assert_eq!(contours[1], overhung(1.2e-5)[1], "the later footprint stays");
    let shapes = union_contours_to_shapes(&contours);
    assert_eq!(shapes.len(), 1);
    assert!(shapes[0].holes.is_empty());
}

#[test]
fn the_reverse_pass_keeps_a_vertex_another_was_snapped_onto() {
    // Forward: the later footprint's corner lands exactly on the earlier one's.
    // Reverse: that earlier corner finds the copy at distance 0 and stays.
    let mut contours = stacked(5e-6);
    let first = contours[0].clone();
    reconcile(&mut contours);
    assert_eq!(contours[0], first);
}
