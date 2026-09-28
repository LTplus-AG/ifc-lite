// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1474: `local_bounds`/`local_to_world` must capture the mesh's
//! object-space extent and the exact placement `apply_placement` resolved,
//! independent of `origin` (a world-space AABB-centre translation captured
//! by this same function for an unrelated reason — f32 precision).
use super::super::mat4_to_row_major;
use super::*;
use crate::Mesh;
use nalgebra::{Rotation3, Translation3};

/// A unit box [0,1]^3, un-rotated, in object space.
fn unit_box() -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
    ];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh.indices = (0..8).collect();
    mesh
}

#[test]
fn captures_local_bounds_and_transform_independent_of_origin() {
    // 90 degree rotation about Z, then translate far from the origin (so
    // `mesh.origin`, a WORLD-space AABB-centre, ends up nowhere near the
    // object-space [0,1]^3 box local_bounds must still report).
    let rotation = Rotation3::from_axis_angle(&Vector3::z_axis(), std::f64::consts::FRAC_PI_2);
    let translation = Translation3::new(1000.0, 2000.0, 3000.0);
    let transform = translation.to_homogeneous() * rotation.to_homogeneous();

    let router = GeometryRouter::new();

    // Relativized path (local-frame origin factored out).
    let mut mesh = unit_box();
    router.transform_mesh_world_framed(&mut mesh, &transform, true);
    assert_eq!(
        mesh.local_bounds,
        Some([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]),
        "local_bounds must be the pre-rotation object-space box, not the world box"
    );
    assert_eq!(
        mesh.local_to_world,
        Some(mat4_to_row_major(&transform)),
        "local_to_world must be exactly the resolved placement"
    );
    assert_ne!(
        mesh.origin, [0.0; 3],
        "sanity: origin should have picked up the world-space translation"
    );

    // Absolute (non-relativized) path — same capture, different `origin` handling.
    let mut mesh2 = unit_box();
    router.transform_mesh_world_framed(&mut mesh2, &transform, false);
    assert_eq!(mesh2.local_bounds, mesh.local_bounds);
    assert_eq!(mesh2.local_to_world, mesh.local_to_world);
    assert_eq!(mesh2.origin, [0.0; 3], "absolute path never sets origin");
}

#[test]
fn issue_4550_router_local_frame_policy_is_explicit_per_instance() {
    let transform = Translation3::new(12.345, 67.891, 0.1).to_homogeneous();
    let mut framed = unit_box();
    GeometryRouter::with_scale_and_local_frame(1.0, true)
        .transform_mesh_world(&mut framed, &transform);
    assert_ne!(framed.origin, [0.0; 3]);

    let mut absolute = unit_box();
    GeometryRouter::with_scale_and_local_frame(1.0, false)
        .transform_mesh_world(&mut absolute, &transform);
    assert_eq!(absolute.origin, [0.0; 3]);
}
