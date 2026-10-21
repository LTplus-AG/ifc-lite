// SPDX-License-Identifier: MPL-2.0
//! Per-object lifetime of managed retained receipts on an actual SMLib worker:
//! dropping one receipt releases only its solid, copies and results survive
//! their sources, and the raw escape hands ownership to the caller.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion, RetainedRequest};
use ifc_lite_geometry_runtime::protocol::BooleanOperation;
use ifc_lite_geometry_runtime::{
    MeshLimits, RetainedDependency, RetainedLineage, RetainedRealization, SmlibWorker, WorkerError,
};

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP actual managed objects: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER"
        );
        return None;
    };
    Some(SmlibWorker::spawn(path).expect("configured worker must start"))
}

/// A 2 x 4 x 3 m rectangle extrusion with its minimum corner at the origin.
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
        .evaluate_retained(request, 0.001, 15., MeshLimits::default())
        .unwrap()
}

fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
}

/// World placement of the authored solid frame (x 0..2, y 0..4, z 0..3),
/// shifted by `dx` metres along X.
fn shifted(dx: f64) -> [f64; 16] {
    let mut frame = IDENTITY;
    frame[12] = dx;
    frame
}

#[test]
fn actual_sdk_managed_sources_and_chained_results_have_independent_lifetimes() {
    let Some(mut worker) = worker() else { return };
    let incarnation = worker.incarnation();
    let a = evaluate(&mut worker);
    let b = evaluate(&mut worker);
    let first = worker
        .evaluate_retained_boolean(
            RetainedDependency::Source {
                realization: &a,
                world_from_source: shifted(0.),
            },
            RetainedDependency::Source {
                realization: &b,
                world_from_source: shifted(1.),
            },
            BooleanOperation::Union,
            0.001,
            15.,
            MeshLimits::default(),
        )
        .unwrap();
    let chained = worker
        .evaluate_retained_boolean(
            RetainedDependency::Result(&first),
            RetainedDependency::Source {
                realization: &b,
                world_from_source: shifted(1.),
            },
            BooleanOperation::Difference,
            0.001,
            15.,
            MeshLimits::default(),
        )
        .unwrap();
    close(worker.volume(first.solid(), 1e-8).unwrap(), 36.);
    close(worker.volume(chained.solid(), 1e-8).unwrap(), 12.);
    let RetainedLineage::Boolean { left, .. } = chained.lineage() else {
        panic!("chained result lost its Boolean lineage");
    };
    assert!(matches!(**left, RetainedLineage::Boolean { .. }));

    // Dropping the intermediate invalidates it at once and releases only it.
    let stale_intermediate = first.solid();
    drop(first);
    assert!(matches!(
        worker.volume(stale_intermediate, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
    // A sibling command drains the queued release, then does actual SDK work.
    close(worker.volume(b.solid(), 1e-8).unwrap(), 24.);
    assert_eq!(
        worker.incarnation(),
        incarnation,
        "one object, never the process"
    );

    let original = a.solid();
    drop(a);
    // The dropped receipt's generation is gone: a raw release dispatches nothing.
    assert!(matches!(
        worker.release(original),
        Err(WorkerError::WrongWorker)
    ));
    // An explicit raw release invalidates its receipt before acceptance.
    worker.release(b.solid()).unwrap();
    assert!(b.validate_live().is_err());
    drop(b);
    worker.flush_releases().unwrap();

    // The result survives both sources and the intermediate, and so does a
    // raw copy of it after its own receipt is dropped.
    chained.validate_live().unwrap();
    close(worker.volume(chained.solid(), 1e-8).unwrap(), 12.);
    assert!(worker.is_manifold(chained.solid()).unwrap());
    let copy = worker.copy_transform(chained.solid(), IDENTITY).unwrap();
    drop(chained);
    worker.flush_releases().unwrap();
    close(worker.volume(copy, 1e-8).unwrap(), 12.);
    worker.release(copy).unwrap();
    assert_eq!(worker.incarnation(), incarnation);
}

#[test]
fn actual_sdk_consumed_raw_escape_survives_managed_cleanup_and_slot_reuse() {
    let Some(mut worker) = worker() else { return };
    let receipt = evaluate(&mut worker);
    let (raw, packet) = receipt.into_host_trusted_parts();
    worker.flush_releases().unwrap();
    close(worker.volume(raw, 1e-8).unwrap(), 24.);
    assert!(!packet.tessellation.indices.is_empty());
    worker.release(raw).unwrap();
    let replacement = worker.create_box([0.; 3], [3.; 3]).unwrap();
    worker.flush_releases().unwrap();
    // Slot reuse advanced the generation: the old raw handle stays stale.
    assert!(matches!(
        worker.volume(raw, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
    close(worker.volume(replacement, 1e-8).unwrap(), 27.);
    worker.release(replacement).unwrap();
}

#[test]
fn actual_sdk_explicit_raw_release_invalidates_receipt_and_preserves_replacement() {
    let Some(mut worker) = worker() else { return };
    let receipt = evaluate(&mut worker);
    let old = receipt.solid();
    worker.release(old).unwrap();
    assert!(receipt.validate_live().is_err());
    let replacement = worker.create_box([0.; 3], [3.; 3]).unwrap();
    // The stale final drop must not queue a release for the reused slot.
    drop(receipt);
    worker.flush_releases().unwrap();
    close(worker.volume(replacement, 1e-8).unwrap(), 27.);
    assert!(matches!(worker.release(old), Err(WorkerError::WrongWorker)));
    worker.release(replacement).unwrap();
}

#[test]
fn actual_sdk_dropped_receipts_release_objects_without_retiring_the_worker() {
    let Some(mut worker) = worker() else { return };
    let incarnation = worker.incarnation();
    // Far more receipts than any process-wide fallback would tolerate.
    for _ in 0..64 {
        let receipt = evaluate(&mut worker);
        receipt.validate_live().unwrap();
    }
    worker.flush_releases().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
    let kept = evaluate(&mut worker);
    let dropped = evaluate(&mut worker);
    let solid = dropped.solid();
    drop(dropped);
    kept.validate_live().unwrap();
    close(worker.volume(kept.solid(), 1e-8).unwrap(), 24.);
    assert!(matches!(
        worker.volume(solid, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
}
