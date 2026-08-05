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
fn near_parallel_oblique_opening_defers() {
    // A ~1° tilt from the host axis: the OLD 0.9995 dot threshold (≈1.8°) marked
    // this eligible and re-extruded the base contour STRAIGHT through the host —
    // but the real cutter sweeps ~70 mm sideways across the 4 m depth
    // (far corner ≠ base corner in host-XY), so the flat cut is wrong. Both the
    // tightened parallelism gate and the zero-lateral-sweep gate now defer it to
    // the exact kernel.
    let theta = 1.0_f64.to_radians();
    let axis = Vector3::new(theta.sin(), 0.0, theta.cos());
    // Anchor so the tilted sweep still spans the full host depth [0, 4] (it would
    // have passed the OLD through-cut + interior gates).
    let op = opening((1.0, 1.0, 0.5 * theta.sin()), axis, 4.0, 1.0);
    assert!(
        opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 0.04).is_none(),
        "a near-parallel oblique opening must defer to the exact kernel"
    );
}

#[test]
fn slightly_oblique_short_opening_defers_on_parallelism_alone() {
    // Isolates the parallelism gate (`host_axis.dot(op_axis).abs() < 1 -
    // 1e-6`) from the zero-lateral-sweep gate, which normally dominates: a
    // through-cut opening's depth is forced close to the host span, so its
    // lateral drift (depth * sin(theta)) almost always breaches `lat_tol`
    // before the parallelism threshold does. Here `z_tol` is deliberately
    // large (span check made vacuous) so a very SHORT, 3°-tilted opening can
    // satisfy the lateral-drift gate (drift = 0.005 * sin(3°) ≈ 2.6e-4 <
    // lat_tol ≈ 4.0e-4) while still being far outside the parallelism
    // threshold (cos(3°) ≈ 0.99863 < 1 - 1e-6). Only the parallelism gate can
    // reject this input.
    let theta = 3.0_f64.to_radians();
    let axis = Vector3::new(theta.sin(), 0.0, theta.cos());
    let op = opening((1.0, 1.0, 0.0), axis, 0.005, 1.0);
    assert!(
        opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 10.0).is_none(),
        "a 3-degree tilt must be rejected by the parallelism gate even when \
         the lateral-drift and through-cut-span gates are too loose to catch it"
    );
}

#[test]
fn degenerate_zero_area_footprint_defers() {
    // A collinear (zero-area) footprint must be rejected — `area_abs` can
    // never be negative (it is a `.abs()`), so the guard's only reachable
    // branch is the exact `== 0.0` case; weakening `<= 0.0` to `< 0.0` turns
    // it into dead code that never fires.
    let z = Vector3::new(0.0, 0.0, 1.0);
    let m = Matrix4::new_translation(&Vector3::new(1.0, 1.0, 0.0));
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(2.0, 0.0),
    ]);
    let op = ExtrudedSolidLike {
        profile,
        depth: HZ_MAX,
        dir_sign: 1.0,
        m: m * Matrix4::new_translation(&Vector3::new(0.0, 0.0, 0.0))
            * Rotation3::rotation_between(&z, &host_axis())
                .unwrap_or_else(Rotation3::identity)
                .to_homogeneous(),
    };
    assert!(
        opening_solid_footprint(&op, &hm_inv(), &host_axis(), HZ_MIN, HZ_MAX, 0.04).is_none(),
        "a zero-area (collinear) footprint must defer to the exact kernel"
    );
}

#[test]
fn reconcile_solid_rejects_volume_ratio_outside_tolerance() {
    // Host: unit square extruded to depth 1 -> volume 1, bounds [0,1]^3.
    let host_profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ]);
    let host = extrude_profile(&host_profile, 1.0, None).expect("host extrude");

    // Solid: same [0,1]^2 bounding box, but with a 0.5 x 0.1 notch cut into
    // the top edge (not touching the corners), so the AABB is UNCHANGED while
    // the volume drops to 0.95 (5% below the host) -> the ratio (0.95) lands
    // outside the real 0.97..1.03 tolerance but inside a loosened one, so
    // only the ratio check (not the bounds check) can reject it.
    let notched_profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.7, 1.0),
        Point2::new(0.7, 0.9),
        Point2::new(0.2, 0.9),
        Point2::new(0.2, 1.0),
        Point2::new(0.0, 1.0),
    ]);
    let solid = extrude_profile(&notched_profile, 1.0, None).expect("solid extrude");

    assert!(
        !reconcile_solid(&host, &solid),
        "a 5% volume-ratio discrepancy (0.95) must be rejected by the \
         0.97..1.03 tolerance even though the AABB matches exactly"
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
