// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `axis.rs` (ratchet-exempt sibling file).

use super::*;

#[test]
fn zup_to_yup_maps_vertical_axis() {
    // IFC Z is up; after the swap the vertical value must land in Y, and the
    // old Y (depth) must land negated in Z.
    assert_eq!(zup_to_yup(1.0, 2.0, 3.0), (1.0, 3.0, -2.0));
    assert_eq!(zup_to_yup_f64([1.0, 2.0, 3.0]), [1.0, 3.0, -2.0]);
}

/// The f32 and f64 helpers must agree — the origin offsets the positions, so a
/// mismatch would place geometry relative to a differently-rotated frame.
#[test]
fn f32_and_f64_swaps_agree() {
    let (x, y, z) = zup_to_yup(10.0, 20.0, 30.0);
    assert_eq!(zup_to_yup_f64([10.0, 20.0, 30.0]), [x as f64, y as f64, z as f64]);
}

#[test]
fn mesh_to_yup_rotates_positions_normals_and_origin_together() {
    let mut mesh = MeshData::new(
        1,
        "IfcSlab".to_string(),
        vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        // Two copies of the IFC "up" normal (0,0,1).
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 1, 2],
        [0.5, 0.5, 0.5, 1.0],
    )
    .with_origin([100.0, 200.0, 300.0]);

    mesh_to_yup_in_place(&mut mesh);

    assert_eq!(mesh.positions, vec![1.0, 3.0, -2.0, 4.0, 6.0, -5.0]);
    // The IFC "up" normal (0,0,1) must become the Y-up normal (0,1,0).
    assert_eq!(mesh.normals, vec![0.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
    assert_eq!(mesh.origin, [100.0, 300.0, -200.0]);
}

/// Meshes with positions but no normals (advanced_brep) must not panic.
#[test]
fn mesh_to_yup_tolerates_missing_normals() {
    let mut mesh = MeshData::new(
        2,
        "IfcAdvancedBrep".to_string(),
        vec![1.0, 2.0, 3.0],
        Vec::new(),
        vec![0],
        [0.8, 0.8, 0.8, 1.0],
    );
    mesh_to_yup_in_place(&mut mesh);
    assert_eq!(mesh.positions, vec![1.0, 3.0, -2.0]);
    assert!(mesh.normals.is_empty());
}

/// A normal buffer that does NOT parallel the positions can't be rotated
/// per-vertex, and shipping it unrotated would put normals in Z-up while the
/// positions are Y-up. Drop it (the parquet path zero-fills for the same
/// reason) rather than emit a mixed-frame mesh.
#[test]
fn mesh_to_yup_drops_mismatched_normals_instead_of_leaving_them_zup() {
    let mut mesh = MeshData::new(
        3,
        "IfcAdvancedBrep".to_string(),
        vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        vec![0.0, 0.0, 1.0], // half as many normals as positions
        vec![0, 1, 2],
        [0.8, 0.8, 0.8, 1.0],
    );
    mesh_to_yup_in_place(&mut mesh);
    assert_eq!(mesh.positions, vec![1.0, 3.0, -2.0, 4.0, 6.0, -5.0]);
    assert!(mesh.normals.is_empty(), "mismatched normals must be dropped");
}

/// A truncated position buffer (not a whole number of triplets) must not index
/// past the end — in release `debug_assert` is a no-op, so this would panic the
/// request handler. Complete triplets are still converted.
#[test]
fn mesh_to_yup_does_not_panic_on_truncated_positions() {
    let mut mesh = MeshData::new(
        4,
        "IfcSlab".to_string(),
        vec![1.0, 2.0, 3.0, 4.0, 5.0], // 5 floats: one triplet + a partial
        Vec::new(),
        vec![0],
        [0.5, 0.5, 0.5, 1.0],
    );
    mesh_to_yup_in_place(&mut mesh);
    assert_eq!(mesh.positions, vec![1.0, 3.0, -2.0, 4.0, 5.0]);
}
