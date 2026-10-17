// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::SourceHygiene;
use crate::Mesh;

// Analytic triangular prism with a collinear point in each cap boundary. The
// zero-area cap ears join one long edge to two short side-wall edges (#7292).
fn collinear_cap_prism(apex_offset: f32, copied_cap_edge: bool) -> Mesh {
    let bottom = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, apex_offset, 0.0], [0.5, 1.0, 0.0]];
    let top = bottom.map(|p| [p[0], p[1], 1.0]);
    let mut mesh = Mesh::new();
    mesh.positions.extend(bottom.into_iter().flatten());
    mesh.positions.extend(top.into_iter().flatten());
    for normal in [[0.0, 0.0, -1.0], [0.0, 0.0, 1.0]] {
        for _ in 0..4 { mesh.normals.extend(normal); }
    }
    mesh.indices.extend([0, 1, 2, 1, 0, 3, 5, 4, 6, 4, 5, 7]);
    for (a, b, normal) in [(0, 2, [0.0, -1.0, 0.0]), (2, 1, [0.0, -1.0, 0.0]),
        (1, 3, [1.0, 0.5, 0.0]), (3, 0, [-1.0, 0.5, 0.0])] {
        let base = mesh.vertex_count() as u32;
        for point in [bottom[a], bottom[b], top[b], top[a]] {
            mesh.positions.extend(point); mesh.normals.extend(normal);
        }
        mesh.indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    if copied_cap_edge {
        // Coordinate-identical edge on different indices: a repair could need
        // another face's attributes, so ExactIndexed must refuse it.
        for slot in [3, 4, 9, 10] {
            let old = mesh.indices[slot] as usize * 3;
            let point = [mesh.positions[old], mesh.positions[old + 1], mesh.positions[old + 2]];
            let normal = [mesh.normals[old], mesh.normals[old + 1], mesh.normals[old + 2]];
            let index = mesh.vertex_count() as u32;
            mesh.positions.extend(point); mesh.normals.extend(normal); mesh.indices[slot] = index;
        }
    }
    mesh
}

fn array_bits(values: &[f32]) -> Vec<u32> { values.iter().map(|v| v.to_bits()).collect() }

#[test]
fn issue_7292_boolean_operand_preserves_exact_collinear_cap_subdivision() {
    let mut mesh = collinear_cap_prism(0.0, false);
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    assert!(!crate::exact_topology::strict_closed_mesh(&legacy), "legacy removal opens the boundary");
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert!(crate::exact_topology::strict_closed_mesh(&mesh), "positive triangles pair every exact edge");
    assert_eq!(array_bits(&mesh.positions), positions, "reuse existing cap indices; no position append/move");
    assert_eq!(array_bits(&mesh.normals), normals, "parallel vertex buffers retain their index domain");
    assert_eq!(mesh.indices.len(), 36, "two zero-area ears removed, two neighbours split");
}

#[test]
fn issue_7292_boolean_operand_nonzero_thin_faces_keep_legacy_cleanup() {
    let mut mesh = collinear_cap_prism(2.0f32.powi(-20), false);
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert_eq!(mesh.indices, legacy.indices, "positive-area sub-grid faces get no exact-only repair");
    assert_eq!(array_bits(&mesh.positions), positions); assert_eq!(array_bits(&mesh.normals), normals);
}

#[test]
fn issue_7292_boolean_operand_refuses_coordinate_only_other_face_apex() {
    let mut mesh = collinear_cap_prism(0.0, true);
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert_eq!(mesh.indices, legacy.indices, "different edge indices cannot borrow or append another face's apex");
    assert_eq!(array_bits(&mesh.positions), positions); assert_eq!(array_bits(&mesh.normals), normals);
}

#[test]
fn issue_7292_boolean_operand_open_invalid_and_nonfinite_keep_legacy_cleanup() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0,0.0,0.0, 1.0,0.0,0.0, 0.5,0.0,0.0, 0.0,1.0,0.0, f32::NAN,0.0,0.0];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh.indices = vec![0,1,2, 0,2,3, 0,1,999, 0,0,1, 0,1,4];
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert_eq!(mesh.indices, legacy.indices, "no fabricated closure or malformed-input exception");
    assert_eq!(array_bits(&mesh.positions), positions); assert_eq!(array_bits(&mesh.normals), normals);
    assert!(mesh.positions.iter().any(|v| !v.is_finite()), "legacy leaves nonfinite handling upstream");
}

#[test]
fn issue_7292_index_only_and_preserved_face_order_keep_legacy_indices() {
    let original = collinear_cap_prism(0.0, false);
    let mut legacy = original.clone(); legacy.clean_degenerate();
    let mut textured = original.clone(); SourceHygiene::IndexOnly.apply(&mut textured);
    assert_eq!(textured.indices, legacy.indices, "textured IndexOnly keeps its existing face-index contract");
    let router = super::GeometryRouter::new();
    router.set_preserve_triangle_order(true);
    let mut ordered = original;
    SourceHygiene::BooleanOperand.for_router(&router).apply(&mut ordered);
    assert_eq!(ordered.indices, legacy.indices, "IfcIndexedColourMap's source-face order forbids inserted triangles");
    assert_eq!(array_bits(&ordered.positions), array_bits(&legacy.positions));
    assert_eq!(array_bits(&ordered.normals), array_bits(&legacy.normals));
}
