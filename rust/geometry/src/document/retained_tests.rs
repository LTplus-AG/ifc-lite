// SPDX-License-Identifier: MPL-2.0
//! Revision, worker and source identity of retained requests, and the
//! deliberate retained -> display boundary.

use super::*;
use crate::analytic::{extract_analytic_extrusion, with_source_capture};
use crate::document::RegionQualification;
use ifc_lite_core::{build_entity_index, EntityDecoder};

const SOLID: &[u8] = b"#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,1.);";

fn recipe(capture: bool) -> RetainedExtrusion {
    let mut decoder = EntityDecoder::with_index(SOLID, build_entity_index(SOLID));
    let entity = decoder.decode_by_id(5).unwrap();
    let source = if capture {
        with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder))
    } else {
        extract_analytic_extrusion(&entity, &mut decoder)
    };
    RetainedExtrusion {
        source,
        length_unit_scale: 1.,
    }
}

fn tessellation(positions: Vec<f64>) -> RetainedTessellation {
    RetainedTessellation {
        positions,
        indices: vec![0, 1, 2],
        flat_corner_normals: vec![0., 0., 1., 0., 0., 1., 0., 0., 1.],
        revision_local_faces: vec![0],
        source_face_count: 1,
        boundary_edges: 0,
        spine_edges: 0,
    }
}

fn completion(request: RetainedRequest, positions: Vec<f64>) -> RetainedCompletion {
    let frame = request.payload();
    let (from, to) = (frame.source_from_evaluation, frame.evaluation_from_source);
    RetainedCompletion::new(request, tessellation(positions), from, to)
}

fn triangle() -> Vec<f64> {
    vec![0., 0., 0., 1., 0., 0., 0., 1., 0.]
}

fn admitted() -> (GeometryDocument, RetainedDefinitionHandle) {
    let mut document = GeometryDocument::new();
    let handle = document.add_retained_extrusion(recipe(true)).unwrap();
    (document, handle)
}

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

#[test]
fn uncaptured_source_is_refused_without_changing_the_document() {
    let mut document = GeometryDocument::new();
    assert_eq!(
        document.add_retained_extrusion(recipe(false)),
        Err(RetainedRefusal::SourceNotCaptured)
    );
    assert_eq!(document.revision(), 0);
}

#[test]
fn retained_definition_is_not_a_mesh_and_requests_carry_identity() {
    let (document, handle) = admitted();
    assert_eq!(document.revision(), 1);
    assert_eq!(document.retained_extrusion(handle).unwrap(), &recipe(true));
    assert_eq!(
        document.retained_payload(handle).unwrap().qualification,
        RegionQualification::Rectangle
    );
    assert_eq!(
        document.prepare_retained_extrusion(handle, 0).unwrap_err(),
        RetainedRefusal::WrongWorker
    );
    let request = document.prepare_retained_extrusion(handle, 7).unwrap();
    assert_eq!(
        (
            request.definition(),
            request.document_revision(),
            request.worker_incarnation()
        ),
        (handle, 1, 7)
    );
    assert_eq!(request.recipe().source.solid_id, 5);
    let other = GeometryDocument::new();
    assert_eq!(
        other.prepare_retained_extrusion(handle, 7).unwrap_err(),
        RetainedRefusal::Document(DocumentError::WrongDocument)
    );
}

#[test]
fn completions_are_bound_to_worker_revision_and_frame() {
    let (mut document, handle) = admitted();
    let packet = completion(
        document.prepare_retained_extrusion(handle, 7).unwrap(),
        triangle(),
    );
    assert_eq!(document.validate_retained_completion(&packet, 7), Ok(()));
    // A restarted worker is a different incarnation; nothing replays.
    assert_eq!(
        document.validate_retained_completion(&packet, 8),
        Err(RetainedRefusal::WrongWorker)
    );
    assert_eq!(
        document.validate_retained_completion(&packet, 0),
        Err(RetainedRefusal::WrongWorker)
    );
    let mut shifted = completion(
        document.prepare_retained_extrusion(handle, 7).unwrap(),
        triangle(),
    );
    shifted.source_from_evaluation[12] += 1.;
    assert_eq!(
        document.validate_retained_completion(&shifted, 7),
        Err(RetainedRefusal::FrameMismatch)
    );
    document.add_retained_extrusion(recipe(true)).unwrap();
    assert_eq!(
        document.validate_retained_completion(&packet, 7),
        Err(RetainedRefusal::Document(DocumentError::StaleRevision))
    );
}

#[test]
fn display_publication_is_explicit_flat_and_never_authored() {
    let (mut document, handle) = admitted();
    let packet = completion(
        document.prepare_retained_extrusion(handle, 7).unwrap(),
        triangle(),
    );
    for (contract, refusal) in [
        (
            RetainedDisplayContract::PersistentIfcFaces,
            RetainedRefusal::PersistentFaceProvenanceUnavailable,
        ),
        (
            RetainedDisplayContract::AnalyticSurfaceNormals,
            RetainedRefusal::AnalyticNormalsUnavailable,
        ),
        (
            RetainedDisplayContract::IfcAppearance,
            RetainedRefusal::IfcAppearanceUnavailable,
        ),
    ] {
        assert_eq!(
            document
                .publish_retained_display(&packet, 7, contract, &[])
                .unwrap_err(),
            refusal
        );
    }
    let mut singular = IDENTITY;
    singular[0] = 0.;
    assert_eq!(
        document
            .publish_retained_display(
                &packet,
                7,
                RetainedDisplayContract::UnstyledFlatSourceOnly,
                &[(9, IDENTITY), (9, singular)]
            )
            .unwrap_err(),
        RetainedRefusal::Document(DocumentError::InvalidTransform)
    );
    assert_eq!(
        document.revision(),
        1,
        "refusals leave the document unchanged"
    );
    let (definition, occurrences) = document
        .publish_retained_display(
            &packet,
            7,
            RetainedDisplayContract::UnstyledFlatSourceOnly,
            &[(9, IDENTITY)],
        )
        .unwrap();
    assert_eq!(document.revision(), 3);
    assert_eq!(document.source_entity_id(definition).unwrap(), 5);
    assert_eq!(document.mesh(definition).unwrap().positions.len(), 9);
    assert_eq!(
        document
            .occurrence(occurrences[0])
            .unwrap()
            .source_entity_id,
        9
    );
    // Publication is a mutation: the same packet is now stale.
    assert_eq!(
        document
            .publish_retained_display(
                &packet,
                7,
                RetainedDisplayContract::UnstyledFlatSourceOnly,
                &[]
            )
            .unwrap_err(),
        RetainedRefusal::Document(DocumentError::StaleRevision)
    );
    // The retained source stays authoritative beside its display mesh.
    assert_eq!(document.retained_extrusion(handle).unwrap(), &recipe(true));
}

#[test]
fn flat_corners_are_expanded_without_averaging_normals() {
    let (mut document, handle) = admitted();
    let mut packet = completion(
        document.prepare_retained_extrusion(handle, 7).unwrap(),
        vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.],
    );
    packet.tessellation.indices = vec![0, 1, 2, 0, 3, 1];
    packet.tessellation.flat_corner_normals = vec![
        0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 1., 0., 0., 1., 0., 0., 1., 0.,
    ];
    packet.tessellation.revision_local_faces = vec![0, 1];
    packet.tessellation.source_face_count = 2;
    let (definition, _) = document
        .publish_retained_display(
            &packet,
            7,
            RetainedDisplayContract::UnstyledFlatSourceOnly,
            &[],
        )
        .unwrap();
    let mesh = document.mesh(definition).unwrap();
    assert_eq!(
        mesh.positions.len(),
        18,
        "shared corners split at the crease"
    );
    assert_eq!(&mesh.positions[..3], &mesh.positions[9..12]);
    assert_ne!(mesh.indices[0], mesh.indices[3]);
    assert_eq!(&mesh.normals[..3], &[0., 0., 1.]);
    assert_eq!(&mesh.normals[9..12], &[0., 1., 0.]);
}

#[test]
fn invalid_tessellations_are_refused_and_kept() {
    let (mut document, handle) = admitted();
    let request = document.prepare_retained_extrusion(handle, 7).unwrap();
    let collapsing = completion(
        request.clone(),
        vec![1., 0., 0., 1. + 1e-12, 0., 0., 1., 1., 0.],
    );
    let mut open = completion(request.clone(), triangle());
    open.tessellation.boundary_edges = 3;
    let mut faces = completion(request, triangle());
    faces.tessellation.revision_local_faces = vec![1];
    for (packet, reason) in [
        (&collapsing, "display narrowing collapses triangle"),
        (&open, "open or non-manifold solid"),
        (&faces, "buffer shape"),
    ] {
        assert_eq!(
            document
                .publish_retained_display(
                    packet,
                    7,
                    RetainedDisplayContract::UnstyledFlatSourceOnly,
                    &[]
                )
                .unwrap_err(),
            RetainedRefusal::InvalidTessellation(reason)
        );
    }
    // The owned f64 evidence survives refusal.
    assert!(collapsing.tessellation.positions[3] > collapsing.tessellation.positions[0]);
    assert_eq!(document.revision(), 1);
}
