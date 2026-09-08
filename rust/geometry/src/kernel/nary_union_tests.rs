// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn tetrahedron(offset: [f32; 3]) -> Mesh {
    let mut mesh = Mesh::new();
    for p in [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ] {
        mesh.positions.extend((0..3).map(|i| p[i] + offset[i]));
    }
    mesh.indices = vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh
}

#[test]
fn issue_3925_coordinate_preserving_candidate_does_not_move_disjoint_vertices() {
    let a = tetrahedron([0.0; 3]);
    let b = tetrahedron([2.0, 0.0, super::super::SNAP_GRID as f32]);
    let operands = [&a, &b];
    let original_vertices: Vec<_> = operands
        .iter()
        .flat_map(|m| m.positions.chunks_exact(3).map(|p| [p[0], p[1], p[2]]))
        .collect();
    let plain = union_many_preserving_coordinates(&operands);
    assert!(!plain.is_empty());
    assert!(
        plain
            .positions
            .chunks_exact(3)
            .all(|p| original_vertices.contains(&[p[0], p[1], p[2]])),
        "disjoint solids have no intersection vertices to construct or move"
    );
    let moved = union_many(&operands);
    assert!(
        moved
            .positions
            .chunks_exact(3)
            .any(|p| !original_vertices.contains(&[p[0], p[1], p[2]])),
        "control must expose the mutually reconciled candidate"
    );
}
