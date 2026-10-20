// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::router::GeometryRouter;
use crate::Vector3;

#[test]
fn remote_floor_does_not_shorten_a_new_blind_recess() {
    for inward in [false, true] {
        let mut host =
            GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(4.0, 2.0, 2.0));
        host.merge(&GeometryRouter::make_box_mesh(
            Point3::new(10.0, 0.0, 0.2),
            Point3::new(12.0, 2.0, 0.4),
        ));
        if inward {
            for t in host.indices.chunks_exact_mut(3) {
                t.swap(1, 2);
            }
        }
        let cutter =
            GeometryRouter::make_box_mesh(Point3::new(1.0, 0.5, 0.2), Point3::new(2.0, 1.5, 1.5));
        let out = GeometryRouter::extend_opening_mesh_through_host(&cutter, &host, Vector3::z());
        assert_eq!(
            out.positions, cutter.positions,
            "a remote floor must not raise the authored recess floor"
        );
    }
}

#[test]
fn finite_contact_includes_crossing_triangles_without_inside_vertices() {
    let cutter =
        GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    let frame = CutterFrame::new(&cutter, Vector3::z()).unwrap();
    assert!(overlaps(
        &frame,
        [
            Point3::new(-2.0, 0.5, 0.0),
            Point3::new(3.0, 0.5, 0.0),
            Point3::new(0.5, 3.0, 0.0)
        ]
    ));
    assert!(!overlaps(
        &frame,
        [
            Point3::new(-2.0, 0.5, 0.0),
            Point3::new(0.5, 3.0, 0.0),
            Point3::new(-2.0, 3.0, 0.0)
        ]
    ));
}

#[test]
fn finite_contact_keeps_boundary_and_uncertain_arithmetic() {
    let cutter =
        GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    let frame = CutterFrame::new(&cutter, Vector3::z()).unwrap();
    assert!(overlaps(
        &frame,
        [
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
            Point3::new(1.0, 1.0, 0.0)
        ]
    ));
    assert!(overlaps(
        &frame,
        [
            Point3::new(f64::NAN, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
            Point3::new(1.0, 1.0, 0.0)
        ]
    ));
}
