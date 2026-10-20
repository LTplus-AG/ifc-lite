// SPDX-License-Identifier: MPL-2.0

use super::*;

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

fn triangle() -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0., 0., 0., 2., 0., 0., 0., 1., 0.];
    mesh.indices = vec![0, 1, 2];
    mesh
}

#[test]
fn admissions_advance_revision_and_keep_source_attribution() {
    let mut document = GeometryDocument::new();
    assert_eq!(document.revision(), 0);
    let definition = document.add_mesh_definition(10, triangle()).unwrap();
    assert_eq!(document.revision(), 1);
    let occurrence = document.add_occurrence(definition, 20, IDENTITY).unwrap();
    assert_eq!(document.revision(), 2);
    assert_eq!(document.source_entity_id(definition), Ok(10));
    let placed = document.occurrence(occurrence).unwrap();
    assert_eq!(placed.source_entity_id, 20);
    assert_eq!(placed.definition, definition);
    assert_eq!(document.mesh(definition).unwrap().positions, triangle().positions);
}

#[test]
fn malformed_meshes_are_refused_without_a_revision() {
    let mut document = GeometryDocument::new();
    let mut partial = triangle();
    partial.positions.pop();
    let mut nonfinite = triangle();
    nonfinite.positions[0] = f32::NAN;
    let mut normals = triangle();
    normals.normals = vec![0., 0., 1.];
    let mut index = triangle();
    index.indices[2] = 3;
    for mesh in [partial, nonfinite, normals, index] {
        assert!(matches!(
            document.add_mesh_definition(1, mesh),
            Err(DocumentError::InvalidMesh(_))
        ));
    }
    assert_eq!(document.revision(), 0);
}

#[test]
fn framed_mesh_cannot_silently_lose_its_frame() {
    let mut document = GeometryDocument::new();
    let mut origin = triangle();
    origin.origin = [5_000_000., 0., 0.];
    let mut rtc = triangle();
    rtc.rtc_applied = true;
    let mut placed = triangle();
    placed.local_to_world = Some(IDENTITY);
    for mesh in [origin, rtc, placed] {
        assert_eq!(
            document.add_mesh_definition(1, mesh),
            Err(DocumentError::UnsupportedFrame)
        );
    }
    assert_eq!(document.revision(), 0);
}

#[test]
fn occurrences_keep_double_precision_placement() {
    let mut document = GeometryDocument::new();
    let definition = document.add_mesh_definition(1, triangle()).unwrap();
    let mut transform = IDENTITY;
    transform[3] = 5_000_000.1234567;
    let occurrence = document.add_occurrence(definition, 100, transform).unwrap();
    let placed = document.occurrence(occurrence).unwrap();
    let mesh = document.mesh(placed.definition).unwrap();
    let world_x = placed.local_to_model[3] + mesh.positions[3] as f64;
    assert_eq!(world_x, 5_000_002.1234567);
    // The definition buffers stay object-local.
    assert_eq!(mesh.positions[3], 2.);
}

#[test]
fn occurrence_transform_validation_refuses_nonfinite_projective_and_singular() {
    let mut document = GeometryDocument::new();
    let definition = document.add_mesh_definition(1, triangle()).unwrap();
    for (index, value) in [(3, f64::INFINITY), (12, 1.), (0, 0.)] {
        let mut transform = IDENTITY;
        transform[index] = value;
        assert_eq!(
            document.add_occurrence(definition, 100, transform),
            Err(DocumentError::InvalidTransform)
        );
    }
    assert_eq!(document.revision(), 1);
}

#[test]
fn cross_document_handles_never_alias_same_slots() {
    let mut first = GeometryDocument::new();
    let mut second = GeometryDocument::new();
    assert_ne!(first.id(), second.id());
    let foreign = first.add_mesh_definition(1, triangle()).unwrap();
    let foreign_occurrence = first.add_occurrence(foreign, 1, IDENTITY).unwrap();
    let own = second.add_mesh_definition(2, triangle()).unwrap();
    second.add_occurrence(own, 2, IDENTITY).unwrap();
    assert_eq!(second.mesh(foreign).unwrap_err(), DocumentError::WrongDocument);
    assert_eq!(second.source_entity_id(foreign), Err(DocumentError::WrongDocument));
    assert!(matches!(
        second.occurrence(foreign_occurrence),
        Err(DocumentError::WrongDocument)
    ));
    assert_eq!(
        second.add_occurrence(foreign, 3, IDENTITY),
        Err(DocumentError::WrongDocument)
    );
    assert_eq!(second.revision(), 2);
}
