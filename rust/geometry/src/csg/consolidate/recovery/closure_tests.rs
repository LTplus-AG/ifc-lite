// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::arrangement::cube_mesh;
use crate::kernel::mesh_bridge::tris_to_mesh;

#[test]
fn issue_7633_certificate_rejects_open_duplicate_and_collapsed_surfaces() {
    let cube = tris_to_mesh(&cube_mesh(0., 1.));
    assert!(closed_signature(&cube).is_ok());
    let mut open = cube.clone();
    open.indices.truncate(open.indices.len() - 3);
    assert_eq!(closed_signature(&open), Err(Rejected::Unpaired));
    let mut duplicate = cube.clone();
    duplicate.merge(&cube);
    assert_eq!(
        closed_signature(&duplicate),
        Err(Rejected::RepeatedDirection)
    );
    let mut collapsed = cube.clone();
    collapsed.indices.extend([0, 0, 1]);
    assert_eq!(closed_signature(&collapsed), Err(Rejected::Collapsed));
    let mut collinear = Mesh::new();
    collinear.positions = vec![0., 0., 0., 1., 1., 1., 2., 2., 2.];
    collinear.indices = vec![0, 1, 2];
    assert_eq!(closed_signature(&collinear), Err(Rejected::Collapsed));
}

#[test]
fn issue_7633_certificate_rejects_invalid_and_zero_volume_inputs() {
    let cube = tris_to_mesh(&cube_mesh(0., 1.));
    let mut invalid = cube.clone();
    invalid.indices[0] = u32::MAX;
    assert_eq!(closed_signature(&invalid), Err(Rejected::Invalid));
    let mut nonfinite = cube.clone();
    nonfinite.positions[0] = f32::NAN;
    assert_eq!(closed_signature(&nonfinite), Err(Rejected::Invalid));
    let mut beyond_grid = cube;
    beyond_grid.positions[0] = f32::MAX;
    assert_eq!(closed_signature(&beyond_grid), Err(Rejected::Invalid));
    let mut sheet = Mesh::new();
    sheet.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0.];
    sheet.indices = vec![0, 1, 2, 0, 2, 1];
    assert_eq!(closed_signature(&sheet), Err(Rejected::ZeroVolume));
    assert_eq!(closed_signature(&Mesh::new()), Err(Rejected::Empty));
}

#[test]
fn issue_7633_exact_volume_certificate_is_translation_and_tessellation_invariant() {
    let mut near = tris_to_mesh(&cube_mesh(0., 1.));
    for p in &mut near.positions {
        *p *= 4_194_304.;
    }
    let mut far = near.clone();
    for p in &mut far.positions {
        *p += 10_000_000_000_000.;
    }
    let a = closed_signature(&near).unwrap();
    let b = closed_signature(&far).unwrap();
    assert_eq!(
        a.volume6, b.volume6,
        "exact summation must not lose cancellation at large grid coordinates"
    );
    let triangle = [far.indices[0], far.indices[1], far.indices[2]];
    let center = far.vertex_count() as u32;
    let centroid: [f32; 3] = std::array::from_fn(|axis| {
        (triangle
            .iter()
            .map(|&i| f64::from(far.positions[i as usize * 3 + axis]))
            .sum::<f64>()
            / 3.) as f32
    });
    far.positions.extend(centroid);
    far.indices.splice(
        0..3,
        [
            triangle[0],
            triangle[1],
            center,
            triangle[1],
            triangle[2],
            center,
            triangle[2],
            triangle[0],
            center,
        ],
    );
    assert_eq!(
        closed_signature(&far).unwrap(),
        b,
        "interior-only face refinement preserves the exact closed solid"
    );
    // Reorder whole faces: the exact signature must depend on the solid,
    // regardless of an alternate triangle traversal and summation order.
    far.indices = far
        .indices
        .chunks_exact(3)
        .rev()
        .flatten()
        .copied()
        .collect();
    assert_eq!(closed_signature(&far).unwrap(), b);
    let mut inward = near;
    for triangle in inward.indices.chunks_exact_mut(3) {
        triangle.swap(1, 2);
    }
    assert_eq!(closed_signature(&inward).unwrap().volume6, -a.volume6);
}
