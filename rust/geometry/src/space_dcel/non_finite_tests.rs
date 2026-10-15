// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Non-finite input at the `SpacePlate` boundary (#7674, GEOM-12).
//!
//! A NaN coordinate from JS (a `Float64Array` fed by a division by zero
//! upstream) used to be stored as-is: `drag_vertex` wrote it into a shared
//! vertex, `split_edge` inserted a NaN vertex, and `add_face` persisted a NaN
//! room because every `abs() < EPS` check is false for NaN. The edit ops now
//! reject it; `build` drops the segment, since a build never fails.

use super::geom2d::representative_point;
use super::*;

fn rect_segments(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<InputSegment> {
    let c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    (0..4).map(|i| InputSegment::new(c[i], c[(i + 1) % 4], Some(i as u32))).collect()
}

fn square_plate() -> SpacePlate {
    SpacePlate::build(&rect_segments(0.0, 0.0, 4.0, 3.0), BuildOptions::default())
}

/// Every live vertex position, for "the edit changed nothing" checks.
fn positions(plate: &SpacePlate) -> Vec<[f64; 2]> {
    (0..plate.vertices.len() as u32).filter_map(|v| plate.vertex_position(VertexId(v))).collect()
}

const BAD: [f64; 3] = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY];

#[test]
fn drag_vertex_rejects_non_finite_and_leaves_the_plate_unchanged() {
    for bad in BAD {
        let mut plate = square_plate();
        let before = positions(&plate);
        let v = plate.find_vertex_near(0.0, 0.0, 1e-6).expect("corner vertex");
        assert!(plate.drag_vertex(v, bad, 1.0).is_err(), "accepted a non-finite coordinate");
        assert!(plate.drag_vertex(v, 1.0, bad).is_err(), "accepted a non-finite coordinate");
        assert_eq!(positions(&plate), before, "a rejected drag must not move the vertex ({bad})");
        // A finite drag still works (control).
        assert!(plate.drag_vertex(v, 0.5, 0.5).is_ok());
    }
}

#[test]
fn split_edge_rejects_non_finite_and_adds_no_vertex() {
    for bad in BAD {
        let mut plate = square_plate();
        let vertices = plate.vertices.len();
        let room = plate.rooms().next().expect("room");
        let edge = plate.bounding_elements(room)[0].0;
        assert!(plate.split_edge(edge, bad, 0.0).is_err(), "accepted a non-finite coordinate");
        assert!(plate.split_edge(edge, 0.0, bad).is_err(), "accepted a non-finite coordinate");
        assert_eq!(plate.vertices.len(), vertices, "a rejected split must not insert a vertex ({bad})");
    }
}

#[test]
fn add_face_rejects_a_non_finite_ring_and_persists_no_room() {
    for bad in BAD {
        let mut plate = square_plate();
        let rooms = plate.room_count();
        let ring = [[10.0, 0.0], [12.0, 0.0], [12.0, bad], [10.0, 2.0]];
        assert!(plate.add_face(&ring, None).is_err(), "accepted a non-finite coordinate");
        assert_eq!(plate.room_count(), rooms, "no NaN room may be persisted ({bad})");
    }
    // Control: the same ring with a finite corner is accepted.
    let mut plate = square_plate();
    assert!(plate.add_face(&[[10.0, 0.0], [12.0, 0.0], [12.0, 2.0], [10.0, 2.0]], None).is_ok());
}

#[test]
fn build_drops_non_finite_segments() {
    let clean = square_plate();
    let mut segs = rect_segments(0.0, 0.0, 4.0, 3.0);
    // More than 20 poisoned segments, crossing the room, so any of them that
    // reached the arrangement would add cut points to the real walls.
    for i in 0..24 {
        let bad = BAD[i % 3];
        let y = 0.1 * i as f64;
        segs.push(InputSegment::new([-1.0, y], [bad, y], None));
        segs.push(InputSegment::new([bad, bad], [2.0, y], None));
    }
    let plate = SpacePlate::build(&segs, BuildOptions::default());
    assert_eq!(plate.room_patches(), clean.room_patches());
    assert!(positions(&plate).iter().all(|p| p[0].is_finite() && p[1].is_finite()));
}

#[test]
fn build_from_wall_rects_drops_non_finite_rects() {
    let rects = vec![
        [[-0.1, -0.1], [4.1, -0.1], [4.1, 0.1], [-0.1, 0.1]],
        [[-0.1, 2.9], [4.1, 2.9], [4.1, 3.1], [-0.1, 3.1]],
        [[-0.1, -0.1], [0.1, -0.1], [0.1, 3.1], [-0.1, 3.1]],
        [[3.9, -0.1], [4.1, -0.1], [4.1, 3.1], [3.9, 3.1]],
    ];
    let clean = SpacePlate::build_from_wall_rects(&rects, BuildOptions::default());
    assert_eq!(clean.room_count(), 1);
    let mut poisoned = rects.clone();
    poisoned.insert(1, [[1.0, 1.0], [2.0, f64::NAN], [2.0, 2.0], [1.0, 2.0]]);
    let plate = SpacePlate::build_from_wall_rects(&poisoned, BuildOptions::default());
    assert_eq!(plate.room_patches(), clean.room_patches());
}

/// `representative_point` sorts the ring's y values and each scan line's x
/// crossings. A ring past the 20-element insertion-sort cutoff with NaN
/// vertices used to hit `partial_cmp(..).unwrap_or(Equal)`, which may panic.
#[test]
fn representative_point_survives_nan_vertices_past_insertion_sort_cutoff() {
    // A concave comb (so the centroid is rejected and the scan runs), with
    // every fourth vertex replaced by NaN.
    let mut ring: Vec<[f64; 2]> = Vec::new();
    for k in 0..12 {
        let x = k as f64;
        ring.push([x, 0.0]);
        ring.push([x + 0.5, if k % 2 == 0 { 3.0 } else { 1.0 }]);
    }
    ring.push([12.0, 0.0]);
    ring.push([12.0, -1.0]);
    ring.push([0.0, -1.0]);
    for (i, p) in ring.iter_mut().enumerate() {
        if i % 4 == 1 {
            *p = [f64::NAN, f64::NAN];
        }
    }
    assert!(ring.len() > 20);
    let _ = representative_point(&ring);
}
