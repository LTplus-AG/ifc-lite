// SPDX-License-Identifier: MPL-2.0
//! Retained-authored round1: interpreted source, explicit execution, document consumer.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_geometry::document::{retained_sweep, EvaluationContract, RetainedRefusal};
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
use ifc_lite_processing::authored_geometry::{
    evaluator::{AuthoredRetainedDocument, RetainedDisplayContract},
    plan_authored_geometry, AuthoredDefinition,
};
use nalgebra::{Matrix4, Vector4};
use std::collections::HashSet;

const MODEL: &str = include_str!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
fn model(circle: bool) -> String {
    MODEL
        .replace(
            "#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
            "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
        )
        .replace(
            "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);",
            if circle {
                "#8=IFCCIRCLEPROFILEDEF(.AREA.,$,#7,2000.);"
            } else {
                "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,2000.,4000.);"
            },
        )
        .replace(
            "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
            "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,3000.);",
        )
        .replace(
            "#28=IFCCARTESIANPOINT((0.0,0.0,0.));",
            "#28=IFCCARTESIANPOINT((5000000000.,0.,0.));",
        )
        .replace(
            "#6=IFCCARTESIANPOINT((0.,0.));",
            "#6=IFCCARTESIANPOINT((250.,-500.));",
        )
        .replace(
            "#10=IFCCARTESIANPOINT((0.,0.,0.));",
            "#10=IFCCARTESIANPOINT((1000.,2000.,3000.));",
        )
}
#[test]
fn retained_round1_units_and_separate_source_frames_remain_f64_and_replayable() {
    for circle in [false] {
        let input = model(circle);
        let plan = plan_authored_geometry(input.as_bytes(), Some(&HashSet::from([31])));
        assert_eq!(plan.recipes.len(), 1, "{:?}", plan.diagnostics);
        let key = &plan.recipes[0].source;
        let doc = AuthoredRetainedDocument::admit_source(&plan, key, 5, 7).unwrap();
        assert!(matches!(
            doc.prepare(key, EvaluationContract::ExactPolyhedral, 1),
            Err(RetainedRefusal::Contract)
        ));
        let request = doc
            .prepare(key, EvaluationContract::RetainedBrep, 1)
            .unwrap();
        assert_eq!(request.recipe().source.depth, Some(3000.));
        let payload = retained_sweep::lower(request.recipe()).unwrap();
        let a = Matrix4::from_column_slice(&payload.source_from_evaluation);
        let b = Matrix4::from_column_slice(&payload.evaluation_from_source);
        assert!((a * b - Matrix4::identity()).norm() < 1e-9);
        let world = Matrix4::from_column_slice(&plan.recipes[0].world_from_source) * a;
        let p = world * Vector4::new(0., 0., 0., 1.);
        // Rectangle anchor is its first authored corner; circle anchor its centre.
        let expected_x = 5_000_000. + 1. + 0.25 - if circle { 0. } else { 1. };
        let expected_y = 2. - 0.5 - if circle { 0. } else { 2. };
        assert!((p[0] - expected_x).abs() < 1e-9, "{p:?}");
        assert!((p[1] - expected_y).abs() < 1e-12);
        assert!((p[2] - 3.).abs() < 1e-12);
        assert_eq!(
            payload.bytes,
            retained_sweep::lower(request.recipe()).unwrap().bytes
        );
        assert_eq!(
            request
                .recipe()
                .source
                .profile
                .as_ref()
                .unwrap()
                .profile_position
                .unwrap()[12],
            250.
        );
    }
}

#[test]
fn retained_round1_holed_profiles_refuse_before_kernel_instead_of_becoming_empty() {
    let mut plan = plan_authored_geometry(MODEL.as_bytes(), Some(&HashSet::from([31])));
    let key = plan.recipes[0].source.clone();
    let AuthoredDefinition::Extrusion(source) = &mut plan.definitions[0] else {
        panic!("extrusion")
    };
    let profile = source.source.profile.as_mut().unwrap();
    let mut inner = profile.loops[0].clone();
    inner.kind = ifc_lite_geometry::analytic::ProfileLoopKind::Inner;
    profile.loops.push(inner);
    assert!(matches!(
        AuthoredRetainedDocument::admit_source(&plan, &key, 1, 1),
        Err(RetainedRefusal::UnqualifiedRegion)
    ));
}

#[test]
fn retained_round1_actual_sdk_extrusion_is_consumed_without_touching_exact_default() {
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP real SDK geometry: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER"
        );
        return;
    };
    let mut worker = SmlibWorker::spawn(executable).unwrap();
    for circle in [false] {
        let input = model(circle);
        let plan = plan_authored_geometry(input.as_bytes(), Some(&HashSet::from([31])));
        let key = &plan.recipes[0].source;
        let mut doc = AuthoredRetainedDocument::admit_source(&plan, key, 5, 7).unwrap();
        let request = doc
            .prepare(key, EvaluationContract::RetainedBrep, worker.incarnation())
            .unwrap();
        let actual = worker
            .evaluate_retained_extrusion(request, 0.0001, 3., MeshLimits::default())
            .unwrap();
        let expected = if circle {
            12. * std::f64::consts::PI
        } else {
            24.
        };
        assert!((worker.volume(actual.solid(), 1e-8).unwrap() - expected).abs() < 1e-5);
        let m = &actual.completion().tessellation;
        let mut six_volume = 0.;
        for tri in m.indices.chunks_exact(3) {
            let point = |i: u32| {
                nalgebra::Vector3::from_row_slice(&m.positions[i as usize * 3..i as usize * 3 + 3])
            };
            six_volume += point(tri[0]).dot(&point(tri[1]).cross(&point(tri[2])));
        }
        assert!((six_volume.abs() / 6. - expected).abs() < expected * 0.002);
        let solid = actual.solid();
        let published = doc
            .publish_source(
                actual.into_host_trusted_parts().1,
                0,
                worker.incarnation(),
                RetainedDisplayContract::UnstyledFlatSourceOnly,
            )
            .unwrap();
        let display = doc.document().mesh(published.definition).unwrap();
        assert!(!display.indices.is_empty());
        assert_eq!(display.normals.len(), display.positions.len());
        let placement = &doc
            .document()
            .occurrence(published.occurrence)
            .unwrap()
            .local_to_model;
        assert!(placement[3] > 4_999_999. && placement[3] < 5_000_002.);
        assert_eq!(published.packet.tessellation.positions.len() % 3, 0);
        worker.release(solid).unwrap();
    }
}

#[test]
fn retained_round1_actual_restart_and_stale_document_reject_packets_intact() {
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP real SDK lifecycle: IFCLITE_SMLIB_WORKER unavailable");
        return;
    };
    let mut worker = SmlibWorker::spawn(&executable).unwrap();
    let plan = plan_authored_geometry(MODEL.as_bytes(), Some(&HashSet::from([31])));
    let key = &plan.recipes[0].source;
    let mut doc = AuthoredRetainedDocument::admit_source(&plan, key, 1, 1).unwrap();
    let request = doc
        .prepare(key, EvaluationContract::RetainedBrep, worker.incarnation())
        .unwrap();
    let actual = worker
        .evaluate_retained_extrusion(request.clone(), 0.001, 5., MeshLimits::default())
        .unwrap();
    let before = actual.completion().tessellation.positions.clone();
    worker.terminate().unwrap();
    let mut replacement = SmlibWorker::spawn(executable).unwrap();
    assert!(matches!(
        replacement.evaluate_retained_extrusion(request, 0.001, 5., MeshLimits::default()),
        Err(ifc_lite_geometry_runtime::WorkerError::WrongWorker)
    ));
    let rejected = doc
        .publish_source(
            actual.into_host_trusted_parts().1,
            0,
            replacement.incarnation(),
            RetainedDisplayContract::UnstyledFlatSourceOnly,
        )
        .err()
        .unwrap();
    assert_eq!(rejected.reason, RetainedRefusal::InvalidRuntime);
    assert_eq!(rejected.completion.tessellation.positions, before);
    let request = doc
        .prepare(
            key,
            EvaluationContract::RetainedBrep,
            replacement.incarnation(),
        )
        .unwrap();
    let actual = replacement
        .evaluate_retained_extrusion(request, 0.001, 5., MeshLimits::default())
        .unwrap();
    let solid = actual.solid();
    doc.document_mut()
        .add_mesh_definition(999, ifc_lite_geometry::Mesh::new())
        .unwrap();
    let rejected = doc
        .publish_source(
            actual.into_host_trusted_parts().1,
            0,
            replacement.incarnation(),
            RetainedDisplayContract::UnstyledFlatSourceOnly,
        )
        .err()
        .unwrap();
    assert!(matches!(
        rejected.reason,
        RetainedRefusal::Document(ifc_lite_geometry::document::DocumentError::StaleRevision)
    ));
    replacement.release(solid).unwrap();
}

#[test]
fn retained_round1_default_exact_consumer_is_still_operational_after_authored_admission() {
    use ifc_lite_processing::{process, ProcessingRequest};
    let request = ProcessingRequest::full_pass().instancing(false);
    let before = process(MODEL.as_bytes(), &request, &mut ());
    assert!(!before.meshes.is_empty());
    let plan = plan_authored_geometry(MODEL.as_bytes(), Some(&HashSet::from([31])));
    let key = &plan.recipes[0].source;
    let retained = AuthoredRetainedDocument::admit_source(&plan, key, 1, 1).unwrap();
    assert!(matches!(
        retained.prepare(key, EvaluationContract::ExactPolyhedral, 123),
        Err(RetainedRefusal::Contract)
    ));
    let after = process(MODEL.as_bytes(), &request, &mut ());
    assert_eq!(before.meshes.len(), after.meshes.len());
    for (a, b) in before.meshes.iter().zip(&after.meshes) {
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.normals, b.normals);
        assert_eq!(a.indices, b.indices);
        assert_eq!(a.origin, b.origin);
        assert_eq!(a.color, b.color);
        assert_eq!(a.express_id, b.express_id);
    }
}

#[test]
fn retained_round1_circle_is_refused_until_positive_sdk_sweep_qualification() {
    let input = model(true);
    let plan = plan_authored_geometry(input.as_bytes(), Some(&HashSet::from([31])));
    assert!(matches!(
        AuthoredRetainedDocument::admit_source(&plan, &plan.recipes[0].source, 1, 1),
        Err(RetainedRefusal::UnqualifiedRegion)
    ));
}

#[test]
fn retained_round1_supervised_transaction_reuses_one_definition_for_mapped_occurrences() {
    use ifc_lite_geometry_runtime::{SupervisedWorker, WorkerCommand, WorkerResult};
    use std::time::Duration;
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP real SDK supervision: IFCLITE_SMLIB_WORKER unavailable");
        return;
    };
    let worker = SupervisedWorker::new(executable, 1).unwrap();
    let timeout = Duration::from_secs(30);
    let WorkerResult::Incarnation(incarnation) = worker
        .submit(WorkerCommand::Incarnation, timeout)
        .unwrap()
        .wait()
        .unwrap()
    else {
        panic!("incarnation result")
    };
    let plan = plan_authored_geometry(MODEL.as_bytes(), Some(&HashSet::from([31, 38])));
    let key = &plan.recipes[0].source;
    let mut doc = AuthoredRetainedDocument::admit_source(&plan, key, 1, 1).unwrap();
    let request = doc
        .prepare(key, EvaluationContract::RetainedBrep, incarnation)
        .unwrap();
    let result = worker
        .submit(
            WorkerCommand::RetainedExtrusion {
                request: Box::new(request),
                chord_metres: 0.001,
                angle_degrees: 5.,
                limits: MeshLimits::default(),
            },
            timeout,
        )
        .unwrap()
        .wait()
        .unwrap();
    let WorkerResult::Retained(actual) = result else {
        panic!("retained result")
    };
    let solid = actual.solid();
    let rejected = doc
        .publish_source(
            actual.into_host_trusted_parts().1,
            0,
            incarnation,
            RetainedDisplayContract::PersistentIfcFaces,
        )
        .err()
        .unwrap();
    assert_eq!(
        rejected.reason,
        RetainedRefusal::PersistentFaceProvenanceUnavailable
    );
    let published = doc
        .publish_source(
            *rejected.completion,
            0,
            incarnation,
            RetainedDisplayContract::UnstyledFlatSourceOnly,
        )
        .unwrap();
    assert_eq!(published.mapped_occurrences.len(), 2);
    let mut x = Vec::new();
    for (_, occurrence) in &published.mapped_occurrences {
        let occurrence = doc.document().occurrence(*occurrence).unwrap();
        assert_eq!(occurrence.definition, published.definition);
        x.push(occurrence.local_to_model[3]);
    }
    assert!((x[1] - x[0] - 3.).abs() < 1e-12);
    worker
        .submit(WorkerCommand::Release { solid }, timeout)
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn retained_round1_nonuniform_occurrence_requires_qualification_before_execution() {
    let mut plan = plan_authored_geometry(MODEL.as_bytes(), Some(&HashSet::from([31])));
    let key = plan.recipes[0].source.clone();
    plan.recipes[0].world_from_source[0] *= 2.;
    assert!(matches!(
        AuthoredRetainedDocument::admit_source(&plan, &key, 1, 1),
        Err(RetainedRefusal::UnqualifiedOccurrenceTransform)
    ));
}
