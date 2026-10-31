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
fn the_radius_follows_the_f32_step_past_128_m() {
    let near = noise_radius(&[rect(0.0, 0.0, 30.0, 1.0)]);
    assert_eq!(near, SNAP_GRID);
    let far = noise_radius(&[rect(1_300.0, 0.0, 1_301.0, 1.0)]);
    // 1.3 km: f32 steps are 2^-13 m, 122 um.
    assert_eq!(far, 2f64.powi(-13));
}

#[test]
fn a_two_step_pier_survives_at_1_3_km() {
    // The narrowest pier f32 carries apart from rounding noise out there.
    let step = 2f64.powi(-13);
    let flush = || {
        vec![rect(1_300.0, 0.0, 1_301.0, 3.0), rect(1_300.0, 3.0 + 2.0 * step, 1_300.5, 4.0)]
    };
    let mut contours = flush();
    assert_eq!(reconcile(&mut contours), 0);
    assert_eq!(contours, flush());
    // One step is rounding noise and closes.
    let mut noisy = vec![rect(1_300.0, 0.0, 1_301.0, 3.0), rect(1_300.0, 3.0 + step, 1_300.5, 4.0)];
    assert!(reconcile(&mut noisy) >= 2);
    assert_eq!(union_contours_to_shapes(&noisy).len(), 1);
}

#[test]
fn the_first_contour_never_moves() {
    let mut contours = stacked(5e-6);
    let first = contours[0].clone();
    snap_onto_earlier(&mut contours, 1e-3);
    assert_eq!(contours[0], first);
}
