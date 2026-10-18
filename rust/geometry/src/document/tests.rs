// SPDX-License-Identifier: MPL-2.0

use super::*;

fn box_mesh(min: [f32; 3], size: [f32; 3]) -> Mesh {
    let mut mesh = Mesh::new();
    for [x, y, z] in [
        [0., 0., 0.],
        [1., 0., 0.],
        [1., 1., 0.],
        [0., 1., 0.],
        [0., 0., 1.],
        [1., 0., 1.],
        [1., 1., 1.],
        [0., 1., 1.],
    ] {
        mesh.positions.extend([
            min[0] + x * size[0],
            min[1] + y * size[1],
            min[2] + z * size[2],
        ]);
    }
    mesh.indices = vec![
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4,
        3, 7, 6, 3, 6, 2,
    ];
    mesh
}

fn volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let point = |index: u32| {
                let index = index as usize * 3;
                nalgebra::Vector3::new(
                    mesh.positions[index] as f64,
                    mesh.positions[index + 1] as f64,
                    mesh.positions[index + 2] as f64,
                )
            };
            point(triangle[0]).dot(&point(triangle[1]).cross(&point(triangle[2]))) / 6.0
        })
        .sum::<f64>()
        .abs()
}

fn assert_volume(mesh: &Mesh, expected: f64) {
    assert!(
        (volume(mesh) - expected).abs() < 1e-6,
        "expected volume {expected}, got {}",
        volume(mesh)
    );
}

fn operands() -> (GeometryDocument, DefinitionHandle, DefinitionHandle) {
    let mut document = GeometryDocument::new();
    let left = document
        .add_mesh_definition(10, box_mesh([0.; 3], [2.; 3]))
        .unwrap();
    let right = document
        .add_mesh_definition(20, box_mesh([1., 0., 0.], [2.; 3]))
        .unwrap();
    (document, left, right)
}

// independent analytic boxes qualify exact execution through the document.
#[test]
fn exact_box_operations_preserve_inputs() {
    let (document, left, right) = operands();
    let original_left = document.mesh(left).unwrap().clone();
    let original_right = document.mesh(right).unwrap().clone();
    for (operation, expected) in [
        (BooleanOperation::Difference, 4.),
        (BooleanOperation::Union, 12.),
        (BooleanOperation::Intersection, 4.),
    ] {
        let request = document
            .prepare_boolean(operation, left, right, EvaluationContract::ExactPolyhedral)
            .unwrap();
        let result = document.evaluate_exact(&request).unwrap();
        assert_volume(document.result_mesh(&result).unwrap(), expected);
    }
    for (handle, original) in [(left, original_left), (right, original_right)] {
        let mesh = document.mesh(handle).unwrap();
        assert_eq!(mesh.positions, original.positions);
        assert_eq!(mesh.normals, original.normals);
        assert_eq!(mesh.indices, original.indices);
    }
}

#[test]
fn different_openings_of_same_source_do_not_share_results() {
    let (mut document, host, first_cut) = operands();
    let second_cut = document
        .add_mesh_definition(20, box_mesh([1.5, 0., 0.], [2.; 3]))
        .unwrap();
    let evaluate = |cut| {
        let request = document
            .prepare_boolean(
                BooleanOperation::Difference,
                host,
                cut,
                EvaluationContract::ExactPolyhedral,
            )
            .unwrap();
        (request, document.evaluate_exact(&request).unwrap())
    };
    let (first_request, first) = evaluate(first_cut);
    let (second_request, second) = evaluate(second_cut);
    assert_ne!(first_request, second_request);
    assert_volume(document.result_mesh(&first).unwrap(), 4.);
    assert_volume(document.result_mesh(&second).unwrap(), 6.);
}

#[test]
fn stale_output_cannot_be_published_after_edit() {
    let (mut document, left, right) = operands();
    let request = document
        .prepare_boolean(
            BooleanOperation::Difference,
            left,
            right,
            EvaluationContract::ExactPolyhedral,
        )
        .unwrap();
    let result = document.evaluate_exact(&request).unwrap();
    let replacement = document
        .replace_mesh_definition(right, box_mesh([1.5, 0., 0.], [2.; 3]))
        .unwrap();
    assert!(matches!(
        document.mesh(right),
        Err(DocumentError::StaleHandle)
    ));
    assert!(matches!(
        document.evaluate_exact(&request),
        Err(DocumentError::StaleRevision)
    ));
    assert!(matches!(
        document.result_mesh(&result),
        Err(DocumentError::StaleRevision)
    ));
    assert_eq!(
        document.publish_result(30, &result),
        Err(DocumentError::StaleRevision)
    );
    let request = document
        .prepare_boolean(
            BooleanOperation::Difference,
            left,
            replacement,
            EvaluationContract::ExactPolyhedral,
        )
        .unwrap();
    let result = document.evaluate_exact(&request).unwrap();
    let published = document.publish_result(30, &result).unwrap();
    assert_volume(document.mesh(published).unwrap(), 6.);
}

#[test]
fn retained_brep_request_is_refused_without_substitution() {
    let (document, left, right) = operands();
    let request = document
        .prepare_boolean(
            BooleanOperation::Difference,
            left,
            right,
            EvaluationContract::RetainedBrep,
        )
        .unwrap();
    assert!(matches!(
        document.evaluate_exact(&request),
        Err(DocumentError::UnsupportedContract)
    ));
}

#[test]
fn empty_geometric_intersection_is_success() {
    let (mut document, left, _) = operands();
    let right = document
        .add_mesh_definition(30, box_mesh([10.; 3], [1.; 3]))
        .unwrap();
    let request = document
        .prepare_boolean(
            BooleanOperation::Intersection,
            left,
            right,
            EvaluationContract::ExactPolyhedral,
        )
        .unwrap();
    let result = document.evaluate_exact(&request).unwrap();
    assert!(document.result_mesh(&result).unwrap().is_empty());
}

#[test]
fn invalid_meshes_are_rejected_before_kernel_and_leave_request_live() {
    let (mut document, left, right) = operands();
    let request = document
        .prepare_boolean(
            BooleanOperation::Difference,
            left,
            right,
            EvaluationContract::ExactPolyhedral,
        )
        .unwrap();
    let mut invalid = vec![box_mesh([0.; 3], [1.; 3]); 5];
    invalid[0].positions[0] = f32::NAN;
    invalid[1].indices[0] = u32::MAX;
    invalid[2].positions.pop();
    invalid[3].indices.pop();
    invalid[4].normals.push(0.);
    for mesh in invalid {
        assert!(matches!(
            document.add_mesh_definition(99, mesh),
            Err(DocumentError::InvalidMesh(_))
        ));
    }
    let result = document.evaluate_exact(&request).unwrap();
    assert_volume(document.result_mesh(&result).unwrap(), 4.);
}

#[test]
fn framed_mesh_cannot_silently_lose_origin() {
    let mut document = GeometryDocument::new();
    let mut mesh = box_mesh([0.; 3], [1.; 3]);
    mesh.origin = [5_000_000., 0., 0.];
    assert_eq!(
        document.add_mesh_definition(1, mesh),
        Err(DocumentError::UnsupportedFrame)
    );
}

#[test]
fn occurrences_keep_double_precision_placement_and_invalidate_on_removal() {
    let (mut document, definition, _) = operands();
    let transform = [
        1.,
        0.,
        0.,
        5_000_000.1234567,
        0.,
        1.,
        0.,
        0.,
        0.,
        0.,
        1.,
        0.,
        0.,
        0.,
        0.,
        1.,
    ];
    let occurrence = document.add_occurrence(definition, 100, transform).unwrap();
    let placed = document.occurrence(occurrence).unwrap();
    let mesh = document.mesh(placed.definition).unwrap();
    let world_x = placed.local_to_model[3] + mesh.positions[3] as f64;
    assert_eq!(world_x, 5_000_002.1234567);
    assert_volume(mesh, 8.);
    document.remove_definition(definition).unwrap();
    assert!(matches!(
        document.occurrence(occurrence),
        Err(DocumentError::StaleHandle)
    ));
    document.remove_occurrence(occurrence).unwrap();
    assert!(matches!(
        document.occurrence(occurrence),
        Err(DocumentError::StaleHandle)
    ));
}

#[test]
fn occurrence_transform_validation_refuses_nonfinite_projective_and_singular() {
    let (mut document, definition, _) = operands();
    let identity = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    for (index, value) in [(3, f64::INFINITY), (12, 1.), (0, 0.)] {
        let mut transform = identity;
        transform[index] = value;
        assert_eq!(
            document.add_occurrence(definition, 100, transform),
            Err(DocumentError::InvalidTransform)
        );
    }
}

#[test]
fn cross_document_handles_never_alias_same_slots() {
    let (first, left, _) = operands();
    let (second, _, _) = operands();
    assert_ne!(first.id(), second.id());
    assert!(matches!(
        second.mesh(left),
        Err(DocumentError::WrongDocument)
    ));
}
