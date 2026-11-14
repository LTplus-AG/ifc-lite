// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::router::GeometryRouter;
use crate::{Mesh, Vector3};

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

/// A 12 mm sheet and a cutter that enters from outside and stops 0.8 mm short
/// of the far face.
fn sheet_and_blind_cutter() -> (Mesh, Mesh) {
    let sheet = GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(3.0, 3.0, 0.012));
    let cutter = GeometryRouter::make_box_mesh(Point3::new(1.0, 1.0, -0.01), Point3::new(2.0, 2.0, 0.0112));
    (sheet, cutter)
}

/// The far face is inside the cap band, so the cap qualifies. It was pushed
/// through the skin, which read empty 4 mm out. With the skin seen and nothing
/// else told apart, it was pulled in a millimetre as a jamb instead.
#[test]
fn a_blind_end_behind_a_thin_skin_stays_where_authored() {
    let (sheet, cutter) = sheet_and_blind_cutter();
    let out = GeometryRouter::extend_opening_mesh_through_host(&cutter, &sheet, Vector3::z());
    assert_eq!(out.positions, cutter.positions);
}

/// The same cutter over a host that already carries the recess: the cap rests
/// on the floor of that void, so it is a jamb and is pulled inside the void.
#[test]
fn a_cap_resting_on_the_floor_of_an_existing_void_is_pulled_in() {
    let (_, cutter) = sheet_and_blind_cutter();
    let skin = GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0112), Point3::new(3.0, 3.0, 0.012));
    let out = GeometryRouter::extend_opening_mesh_through_host(&cutter, &skin, Vector3::z());
    let top = out.positions.chunks_exact(3).map(|p| p[2]).fold(f32::MIN, f32::max);
    assert!((f64::from(top) - 0.0102).abs() < 1.0e-6, "cap at {top}, expected 1 mm inside the void");
}

#[test]
fn contact_is_on_within_the_flush_band_and_band_beyond_it() {
    let (_, cutter) = sheet_and_blind_cutter();
    let frame = CutterFrame::new(&cutter, Vector3::z()).unwrap();
    let over = [Point3::new(0.0, 0.0, 0.0), Point3::new(3.0, 0.0, 0.0), Point3::new(0.0, 3.0, 0.0)];
    let beside = over.map(|p| p + Vector3::new(10.0, 0.0, 0.0));
    assert!(contact(&frame, over, 5.0e-5) == Contact::On);
    assert!(contact(&frame, over, -8.0e-4) == Contact::Band);
    assert!(contact(&frame, over, f64::NAN) == Contact::On);
    assert!(contact(&frame, beside, 0.0) == Contact::None);
    // 1 km out the f32 floor is 0.4 mm, so 0.3 mm is still on the cap.
    let far = over.map(|p| p + Vector3::new(1000.0, 0.0, 0.0));
    let far_cutter = GeometryRouter::make_box_mesh(Point3::new(999.0, 0.0, 0.0), Point3::new(1004.0, 4.0, 1.0));
    let far_frame = CutterFrame::new(&far_cutter, Vector3::z()).unwrap();
    assert!(contact(&far_frame, far, 3.0e-4) == Contact::On);
}
