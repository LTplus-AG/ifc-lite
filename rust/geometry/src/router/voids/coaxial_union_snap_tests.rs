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

fn tri(p: [[f64; 2]; 3]) -> Vec<Point2<f64>> {
    p.iter().map(|q| Point2::new(q[0], q[1])).collect()
}

/// The cap triangles of rectangle #12681 (both caps, first) and pentagon
/// #13475 (both caps) on ISSUE_129 slab #12381, as the coaxial union receives
/// them in the cut frame, where their shared seam runs at 23 degrees. They
/// overlap for 1.32 m: pentagon corner `P` lies on the rectangle's edge, and
/// rectangle corner `R4` lies on the pentagon's edge.
fn slab_12381_rect_and_pentagon() -> Vec<Vec<Point2<f64>>> {
    let r1 = [-14.803767204284668, -12.266097068786621];
    let r2 = [-12.963177680969238, -13.048550605773926];
    let r3 = [-14.604242324829102, -11.796749114990234];
    let r4 = [-12.763653755187988, -12.579201698303223];
    let p = [-13.977116584777832, -12.063344955444336];
    let p2 = [-11.437104225158691, -13.143129348754883];
    let p3 = [-5.561490535736084, -10.772904396057129];
    let p4 = [-10.280028343200684, -3.3665621280670166];
    let p5 = [-3.617096185684204, -6.19904088973999];
    [
        [r1, r2, r3],
        [r4, r3, r2],
        [r3, r1, r2],
        [r2, r4, r3],
        [p4, p3, p5],
        [p3, p, p2],
        [p, p3, p4],
        [p3, p5, p4],
        [p, p2, p3],
        [p3, p4, p],
    ]
    .map(tri)
    .into_iter()
    .map(|c| crate::bool2d::ensure_ccw(&c))
    .collect()
}

#[test]
fn issue_8190_snapping_alone_leaves_the_12381_pair_as_two_shapes() {
    // `P` snaps onto the rectangle's edge, but `R4` is a corner of the EARLIER
    // contour and the pentagon's far corner is out of reach, so the pentagon's
    // edge stays 0.8 um off `R4`: two prisms, and a strip of host between them.
    let mut contours = slab_12381_rect_and_pentagon();
    let tau = noise_radius(&contours);
    assert!(snap_onto_earlier(&mut contours, tau) > 0, "P moves");
    assert_eq!(union_contours_to_shapes(&contours).len(), 2);
}

#[test]
fn issue_8190_closed_t_junctions_fuse_the_12381_pair() {
    let mut contours = slab_12381_rect_and_pentagon();
    let area_in: f64 = contours.iter().map(|c| crate::bool2d::compute_signed_area(c).abs()).sum::<f64>() / 2.0;
    reconcile(&mut contours);
    let shapes = union_contours_to_shapes(&contours);
    assert_eq!(shapes.len(), 1, "one opening footprint, no strip");
    assert!(shapes[0].holes.is_empty());
    // Disjoint in the file, so the union's area is the two caps' sum, to
    // within the noise radius times the seam length.
    let area_out = crate::bool2d::compute_signed_area(&shapes[0].outer).abs();
    assert!((area_out - area_in).abs() < 1.5 * SNAP_GRID, "{area_in} -> {area_out}");
}

/// An earlier rectangle, and a later quad below it whose top edge runs from
/// beyond the rectangle's left corner to under its interior, `gaps` below it
/// at its two ends.
fn partial_overlap(gaps: [f64; 2]) -> Vec<Vec<Point2<f64>>> {
    vec![
        rect(0.0, 0.5, 2.0, 1.0),
        vec![
            Point2::new(-1.4, -1.0),
            Point2::new(1.3, -1.0),
            Point2::new(1.3, 0.5 - gaps[1]),
            Point2::new(-1.4, 0.5 - gaps[0]),
        ],
    ]
}

#[test]
fn a_partly_overlapping_flush_edge_fuses_and_the_earlier_boundary_stays() {
    for gaps in [[2e-6, 1e-6], [1e-5, -1e-5], [1.4e-5, 1.4e-5]] {
        let mut contours = partial_overlap(gaps);
        let tau = noise_radius(&contours);
        let mut snapped = contours.clone();
        snap_onto_earlier(&mut snapped, tau);
        assert_eq!(union_contours_to_shapes(&snapped).len(), 2, "{gaps:?}: snapping alone keeps the wedge");

        reconcile(&mut contours);
        let shapes = union_contours_to_shapes(&contours);
        assert_eq!(shapes.len(), 1, "{gaps:?}");
        assert!(shapes[0].holes.is_empty(), "{gaps:?}");
        // The earlier rectangle gains the later corner on its edge, exactly.
        let first = &contours[0];
        assert_eq!(first.len(), 5, "{gaps:?}");
        assert!(first.contains(&Point2::new(1.3, 0.5)), "{gaps:?}: {first:?}");
        for corner in &rect(0.0, 0.5, 2.0, 1.0) {
            assert!(first.contains(corner), "{gaps:?}: corner {corner:?} kept");
        }
    }
}

#[test]
fn a_t_junction_wider_than_the_noise_radius_is_left_open() {
    // 68 um below at both ends: the authored pier (#144568) the snap keeps.
    let mut contours = partial_overlap([68e-6, 68e-6]);
    assert_eq!(reconcile(&mut contours), 0);
    assert_eq!(contours, partial_overlap([68e-6, 68e-6]));
    assert_eq!(union_contours_to_shapes(&contours).len(), 2);
}
