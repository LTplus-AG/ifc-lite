// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! M6: a bounded halfspace's cut-plane base and boundary sides are source faces; its far cap is not.
use super::face_attribution::{Extent, Role, Segment};
use super::face_surfaces::faces;
use ifc_lite_geometry::document::{PrismLoop, PrismRole, PrismSegment, RetainedPrism, RetainedRecipe};

fn prism(points: &[[f64; 2]]) -> RetainedPrism {
    let segments = (0..points.len()).map(|i| PrismSegment::Line { start: points[i], end: points[(i + 1) % points.len()] }).collect();
    RetainedPrism {
        source_id: 77, role: PrismRole::BoundedHalfSpace,
        frame: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.],
        direction: [0.2, 0., 1.], depth: 5., loops: vec![PrismLoop { outer: true, segments }],
    }
}
fn side_ends(recipe: &RetainedRecipe, payload: &ifc_lite_geometry::document::SweepPayload) -> Vec<(u32, [f64; 2], [f64; 2])> {
    let (faces, region) = faces(recipe, payload).unwrap();
    assert!(region.is_some());
    assert_eq!(faces.iter().filter(|f| f.role == Role::HalfSpace).count(), 1, "one base on the authored plane");
    assert!(faces.iter().all(|f| f.role != Role::Cap { end: true } && f.role != Role::Cap { end: false }), "far cap is never a source face");
    faces.iter().filter_map(|f| match (&f.role, &f.extent) {
        (Role::Side { boundary: 0, segment }, Extent::Side { segment: Segment::Line { a, b } }) => Some((*segment, *a, *b)),
        _ => None,
    }).collect()
}
#[test]
fn counter_clockwise_boundary_keeps_authored_segment_indices() {
    let points = [[0., 0.], [4., 0.], [4., 3.], [0., 3.]];
    let prism = prism(&points);
    let payload = prism.lower().unwrap();
    let sides = side_ends(&RetainedRecipe::Prism(prism), &payload);
    assert_eq!(sides.len(), 4);
    for (k, a, b) in sides { assert_eq!((a, b), (points[k as usize], points[(k as usize + 1) % 4])); }
}
#[test]
fn clockwise_boundary_is_reversed_by_the_encoder_but_keys_stay_authored() {
    let points = [[0., 0.], [0., 3.], [4., 3.], [4., 0.]];
    let prism = prism(&points);
    let payload = prism.lower().unwrap();
    let sides = side_ends(&RetainedRecipe::Prism(prism), &payload);
    assert_eq!(sides.len(), 4);
    // The request reverses the loop: each side runs end -> start of its authored segment.
    for (k, a, b) in sides { assert_eq!((a, b), (points[(k as usize + 1) % 4], points[k as usize])); }
}
