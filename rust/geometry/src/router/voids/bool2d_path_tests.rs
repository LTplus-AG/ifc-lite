// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the 2D opening-subtraction eligibility logic
//! ([`super`]). Split into a `*_tests.rs` file (module-size-ratchet exempt) and
//! attached to the parent via `#[path]` so it keeps access to the parent's
//! private helpers.

use super::*;
use nalgebra::Rotation3;

/// A unit-square opening solid at `center` (host-local XY), swept `depth`
/// along `axis` (host-local), with `dir_sign`.
fn opening(
    center: (f64, f64, f64),
    axis: Vector3<f64>,
    depth: f64,
    dir_sign: f64,
) -> ExtrudedSolidLike {
    // Rotate the profile's local +Z onto `axis`, then translate to `center`.
    let z = Vector3::new(0.0, 0.0, 1.0);
    let rot = Rotation3::rotation_between(&z, &axis)
        .unwrap_or_else(Rotation3::identity)
        .to_homogeneous();
    let m = Matrix4::new_translation(&Vector3::new(center.0, center.1, center.2)) * rot;
    let profile = Profile2D::new(vec![
        Point2::new(-0.5, -0.5),
        Point2::new(0.5, -0.5),
        Point2::new(0.5, 0.5),
        Point2::new(-0.5, 0.5),
    ]);
    ExtrudedSolidLike {
        profile,
        depth,
        dir_sign,
        m,
    }
}

// Host: extruded +Z over [0, 4], identity placement → host frame == world.
const HZ_MIN: f64 = 0.0;
const HZ_MAX: f64 = 4.0;
fn host_axis() -> Vector3<f64> {
    Vector3::new(0.0, 0.0, 1.0)
}
fn hm_inv() -> Matrix4<f64> {
    Matrix4::identity()
}

#[test]
fn parallel_through_opening_is_eligible() {
    // +Z, full host depth: a clean through-cut → footprint recovered.
    let op = opening((1.0, 1.0, 0.0), host_axis(), HZ_MAX, 1.0);
    let fp = opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 0.04);
    assert!(
        fp.is_some(),
        "a parallel full-depth opening must be eligible"
    );
    assert_eq!(fp.unwrap().len(), 4);
}

#[test]
fn perpendicular_opening_defers() {
    // Swept along +X (through the host thickness): perpendicular to the host
    // axis → ineligible (the exact kernel handles it).
    let op = opening((1.0, 1.0, 2.0), Vector3::new(1.0, 0.0, 0.0), 1.0, 1.0);
    assert!(
        opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 0.04).is_none(),
        "a perpendicular opening must defer"
    );
}

#[test]
fn partial_depth_opening_defers() {
    // Parallel but only 1 m of the 4 m host depth (a recess/pocket) → defer.
    let op = opening((1.0, 1.0, 0.0), host_axis(), 1.0, 1.0);
    assert!(
        opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 0.04).is_none(),
        "a partial-depth opening must defer"
    );
}

#[test]
fn annular_opening_defers() {
    // An opening whose own profile carries a hole can't reduce to one
    // subtracted footprint → defer.
    let mut op = opening((1.0, 1.0, 0.0), host_axis(), HZ_MAX, 1.0);
    op.profile.add_hole(vec![
        Point2::new(-0.2, -0.2),
        Point2::new(-0.2, 0.2),
        Point2::new(0.2, 0.2),
        Point2::new(0.2, -0.2),
    ]);
    assert!(
        opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 0.04).is_none(),
        "an annular opening must defer"
    );
}

#[test]
fn footprint_interior_gates_boundary_breach() {
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ]);
    let interior = vec![
        Point2::new(2.0, 2.0),
        Point2::new(3.0, 2.0),
        Point2::new(3.0, 3.0),
        Point2::new(2.0, 3.0),
    ];
    let breaching = vec![
        Point2::new(-1.0, 2.0),
        Point2::new(3.0, 2.0),
        Point2::new(3.0, 3.0),
        Point2::new(-1.0, 3.0),
    ];
    assert!(footprint_interior(&interior, &profile));
    assert!(!footprint_interior(&breaching, &profile));
}
