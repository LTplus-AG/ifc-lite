// SPDX-License-Identifier: MPL-2.0
//! Sealed empty retained Boolean outcomes on an actual SMLib worker. The
//! classification comes from the result solid itself; no mesh, volume or host
//! substitute establishes it. An empty result is an independently owned
//! operand of later Booleans, and producing one never retires the worker.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion, RetainedRequest};
use ifc_lite_geometry_runtime::protocol::BooleanOperation::{Difference, Intersection, Union};
use ifc_lite_geometry_runtime::{
    MeshLimits, NumericalOutcome, RetainedDependency, RetainedDependencyResult, RetainedLineage,
    RetainedRealization, SmlibWorker,
};

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP actual sealed empty: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER"
        );
        return None;
    };
    Some(SmlibWorker::spawn(path).expect("configured worker must start"))
}

/// A 2 x 4 x 3 m rectangle extrusion (24 m3) with its minimum corner at the origin.
fn request(worker: &SmlibWorker) -> RetainedRequest {
    let data = "#1=IFCCARTESIANPOINT((1.,2.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);#5=IFCDIRECTION((0.,0.,1.));\
#6=IFCEXTRUDEDAREASOLID(#4,$,#5,3.);";
    let mut decoder =
        EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let entity = decoder.decode_by_id(6).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion {
            source,
            length_unit_scale: 1.,
        })
        .unwrap();
    document
        .prepare_retained(definition, worker.incarnation())
        .unwrap()
}

fn evaluate(worker: &mut SmlibWorker) -> RetainedRealization {
    let request = request(worker);
    worker
        .evaluate_retained(request, 0.001, 5., MeshLimits::default())
        .unwrap()
}

fn source(realization: &RetainedRealization, dx: f64) -> RetainedDependency<'_> {
    let mut world_from_source = IDENTITY;
    world_from_source[12] = dx;
    RetainedDependency::Source {
        realization,
        world_from_source,
    }
}

fn boolean(
    worker: &mut SmlibWorker,
    left: RetainedDependency<'_>,
    right: RetainedDependency<'_>,
    operation: ifc_lite_geometry_runtime::protocol::BooleanOperation,
) -> RetainedDependencyResult {
    worker
        .evaluate_retained_boolean(left, right, operation, 0.001, 5., MeshLimits::default())
        .unwrap()
}

fn assert_empty(worker: &mut SmlibWorker, result: &RetainedDependencyResult) {
    assert_eq!(result.outcome(), NumericalOutcome::Empty);
    assert!(result.is_empty());
    let mesh = result.mesh();
    assert!(mesh.positions.is_empty() && mesh.indices.is_empty());
    assert!(mesh.corner_normals.is_empty() && mesh.source_faces.is_empty());
    assert_eq!(mesh.source_face_count, 0);
    assert!(worker.is_empty(result.solid()).unwrap());
    assert!(matches!(result.lineage(), RetainedLineage::Boolean { .. }));
    result.validate_live().unwrap();
}

fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
}

#[test]
fn actual_sdk_sealed_empty_boolean_identities_preserve_independent_operands() {
    let Some(mut worker) = worker() else { return };
    let incarnation = worker.incarnation();
    let a = evaluate(&mut worker);
    let b = evaluate(&mut worker);
    assert!(!worker.is_empty(a.solid()).unwrap());
    // Disjoint intersection and self-difference are distinct empty producers.
    let empty = boolean(&mut worker, source(&a, 0.), source(&b, 100.), Intersection);
    let removed = boolean(&mut worker, source(&a, 0.), source(&a, 0.), Difference);
    assert_empty(&mut worker, &empty);
    assert_empty(&mut worker, &removed);
    assert_ne!(empty.solid(), removed.solid());

    let mut results = Vec::new();
    for operation in [Union, Intersection, Difference] {
        let both = boolean(
            &mut worker,
            RetainedDependency::Result(&empty),
            RetainedDependency::Result(&removed),
            operation,
        );
        assert_empty(&mut worker, &both);
        results.push(both);
    }
    for zero in [&empty, &removed] {
        for operation in [Union, Intersection, Difference] {
            for reverse in [false, true] {
                let (left, right) = if reverse {
                    (source(&a, 0.), RetainedDependency::Result(zero))
                } else {
                    (RetainedDependency::Result(zero), source(&a, 0.))
                };
                let result = boolean(&mut worker, left, right, operation);
                let expected = operation == Intersection || (operation == Difference && !reverse);
                if expected {
                    assert_empty(&mut worker, &result);
                } else {
                    assert_eq!(result.outcome(), NumericalOutcome::NonEmpty);
                    assert!(!result.mesh().indices.is_empty());
                    assert!(!worker.is_empty(result.solid()).unwrap());
                    close(worker.volume(result.solid(), 1e-8).unwrap(), 24.);
                }
                // Every operand is unchanged and still independently live.
                for live in [&empty, &removed] {
                    live.validate_live().unwrap();
                    assert!(worker.is_empty(live.solid()).unwrap());
                }
                a.validate_live().unwrap();
                b.validate_live().unwrap();
                close(worker.volume(a.solid(), 1e-8).unwrap(), 24.);
                results.push(result);
            }
        }
    }
    assert_eq!(
        worker.incarnation(),
        incarnation,
        "empty outcomes never retire"
    );

    // Dropping one empty result releases only that solid.
    let stale = empty.solid();
    drop(empty);
    assert!(worker.is_empty(stale).is_err());
    assert_empty(&mut worker, &removed);
    for result in &results {
        result.validate_live().unwrap();
    }
    close(worker.volume(b.solid(), 1e-8).unwrap(), 24.);
    drop(results);
    drop(removed);
    close(worker.volume(a.solid(), 1e-8).unwrap(), 24.);
    assert_eq!(worker.incarnation(), incarnation);
}
