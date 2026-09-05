// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn tetrahedron(offset: [f32; 3]) -> Mesh {
    let mut mesh = Mesh::new();
    for p in [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
        mesh.positions.extend((0..3).map(|i| p[i] + offset[i]));
    }
    mesh.indices = vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh
}

#[test]
fn issue_3925_audit_rejects_holes_reversed_and_duplicated_faces() {
    let mesh = tetrahedron([0.0; 3]);
    assert!(closed_boundary(&mesh));
    let mut hole = mesh.clone();
    hole.indices.truncate(9);
    assert!(!closed_boundary(&hole));
    let mut reversed = mesh.clone();
    reversed.indices.swap(0, 1);
    assert!(!closed_boundary(&reversed));
    let mut duplicate = mesh.clone();
    duplicate.indices.extend_from_slice(&mesh.indices);
    assert!(!closed_boundary(&duplicate), "balanced duplicate shells are not paired incidence");
    let mut collapsed = mesh.clone();
    collapsed.positions[3..6].copy_from_slice(&[0.0; 3]);
    assert!(!closed_boundary(&collapsed));
    let mut invalid = mesh.clone();
    invalid.positions[0] = f32::NAN;
    assert!(!closed_boundary(&invalid));
    let mut invalid_index = mesh.clone();
    invalid_index.indices[0] = u32::MAX;
    assert!(!closed_boundary(&invalid_index));
    assert!(!closed_boundary(&Mesh::new()));
}

#[test]
fn issue_3925_a_closed_union_keeps_its_original_coordinates() {
    let a = tetrahedron([0.0; 3]);
    let b = tetrahedron([2.0, 0.0, super::super::SNAP_GRID as f32]);
    let operands = [&a, &b];
    let plain = union_many_preserving_coordinates(&operands);
    assert!(closed_after_consolidation(&plain));
    let moved = arrange(&operands, true);
    assert_ne!(moved.positions, plain.positions, "control must expose unconditional promotion");
    let result = union_many(&operands);
    assert_eq!(result.positions, plain.positions);
    assert_eq!(result.indices, plain.indices);
}

#[test]
fn issue_3925_an_unsuccessful_repair_preserves_the_completed_arrangement() {
    let mut a = tetrahedron([0.0; 3]);
    a.indices.truncate(3);
    let mut b = tetrahedron([2.0, 0.0, super::super::SNAP_GRID as f32]);
    b.indices.truncate(3);
    let operands = [&a, &b];
    let plain = union_many_preserving_coordinates(&operands);
    assert!(!closed_after_consolidation(&plain));
    let moved = arrange(&operands, true);
    assert!(!closed_after_consolidation(&moved));
    let result = union_many(&operands);
    assert_eq!(result.positions, plain.positions);
    assert_eq!(result.indices, plain.indices);
}
