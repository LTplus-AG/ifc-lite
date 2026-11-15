// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the outer-bound region helpers in `bounds.rs` (#9945).
//! Split out so `bounds.rs` stays under the module-size ratchet.

use super::*;

fn p(x: f64, y: f64) -> Point2<f64> {
    Point2::new(x, y)
}

#[test]
fn a_tiny_loop_is_still_a_region_and_a_collinear_one_is_not_issue_9945() {
    let square = |x: f64, y: f64, s: f64| vec![Point3::new(x, y, 0.), Point3::new(x + s, y, 0.), Point3::new(x + s, y + s, 0.), Point3::new(x, y + s, 0.)];
    let (big, tiny) = (square(0., 0., 10.), square(20., 0., 5e-7));
    let regions = outer_bound_regions(&[&big, &tiny]).unwrap();
    assert_eq!(regions.len(), 2, "a 0.5 micrometre loop in metres is a region of its own");
    let line = vec![Point3::new(0., 0., 0.), Point3::new(1., 0., 0.), Point3::new(2., 0., 0.)];
    assert_eq!(outer_bound_regions(&[&big, &line]).unwrap().len(), 1, "a collinear loop bounds nothing");
}

#[test]
fn a_rectangle_over_a_v_dip_is_a_region_even_when_its_edge_runs_through_the_slot_vertices_issue_9945() {
    // A 10 x 10 square with a slot cut in from the top (x 3 to 3.2, down to y 2) that ends in a V-dip to (3.1, 1).
    // The rectangle (1,0.5)-(9,2) has every vertex and edge midpoint in the square and only touches the slot's
    // lower vertices (3,2) and (3.2,2) with its top edge, so neither the crossing nor the midpoint test sees
    // the dip. The dip's apex (3.1, 1) lies strictly inside the rectangle, so the rectangle is not inside the square.
    let p3 = |x: f64, y: f64| Point3::new(x, y, 0.);
    let outer = vec![p3(0., 0.), p3(10., 0.), p3(10., 10.), p3(3.2, 10.), p3(3.2, 2.), p3(3.1, 1.), p3(3., 2.), p3(3., 10.), p3(0., 10.)];
    let rectangle = vec![p3(1., 0.5), p3(9., 0.5), p3(9., 2.), p3(1., 2.)];
    let regions = outer_bound_regions(&[&outer, &rectangle]).unwrap();
    assert_eq!(regions.len(), 2, "the rectangle is a region of its own, not the square's opening");
    assert!(regions.iter().all(|region| region.holes.is_empty()));
}

#[test]
fn a_rectangle_around_a_thin_slit_whose_ends_touch_its_edges_is_a_region_issue_9945() {
    // A 10 x 10 square with a thin slit from the top down to (3.1, 2). The rectangle (1,2)-(9,9) has the slit's
    // ends on its own edges (3,9), (3.2,9) on the top and (3.1,2) on the bottom, so no vertex of the square is
    // strictly inside it, yet the whole slit is: it is not inside the square.
    let p3 = |x: f64, y: f64| Point3::new(x, y, 0.);
    let outer = vec![p3(0., 0.), p3(10., 0.), p3(10., 10.), p3(3.2, 10.), p3(3.2, 9.), p3(3.1, 2.), p3(3., 9.), p3(3., 10.), p3(0., 10.)];
    let rectangle = vec![p3(1., 2.), p3(9., 2.), p3(9., 9.), p3(1., 9.)];
    let regions = outer_bound_regions(&[&outer, &rectangle]).unwrap();
    assert_eq!(regions.len(), 2, "the rectangle is a region of its own, not the square's opening");
}

#[test]
fn a_touch_is_no_crossing_whichever_way_the_outer_edge_runs_issue_9945() {
    // The segment (5,0)-(7,3) only touches the line y = 0 at its start.
    assert!(!segments_cross(&p(5., 0.), &p(7., 3.), &p(0., 0.), &p(10., 0.)));
    assert!(!segments_cross(&p(5., 0.), &p(7., 3.), &p(10., 0.), &p(0., 0.)));
    assert!(!segments_cross(&p(7., 3.), &p(5., 0.), &p(10., 0.), &p(0., 0.)));
    // The same segments at 1e-7 scale (a tiny fixture) still cross or touch exactly as before.
    let k = 1e-7;
    assert!(!segments_cross(&p(5. * k, 0.), &p(7. * k, 3. * k), &p(0., 0.), &p(10. * k, 0.)));
    assert!(segments_cross(&p(5. * k, -k), &p(7. * k, 3. * k), &p(0., 0.), &p(10. * k, 0.)));
    assert!(segments_cross(&p(5. * k, -k), &p(7. * k, 3. * k), &p(10. * k, 0.), &p(0., 0.)));
    // A real crossing is one in every direction.
    assert!(segments_cross(&p(5., -1.), &p(7., 3.), &p(0., 0.), &p(10., 0.)));
    assert!(segments_cross(&p(5., -1.), &p(7., 3.), &p(10., 0.), &p(0., 0.)));
}
