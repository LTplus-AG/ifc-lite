// SPDX-License-Identifier: MPL-2.0
//! Synthetic 2x4x3 source invariant, actual SDK receipt and lifecycle (review 1-4).
//! This is not a real-authoring-tool IFC or broad geometry qualification witness.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_geometry::analytic::extract_analytic_extrusion;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::document::{
    EvaluationContract, GeometryDocument, RetainedExtrusion, RetainedRequest,
};
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker, WorkerError};

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP actual SDK retained receipt: build pinned adapter and set IFCLITE_SMLIB_WORKER"
        );
        return None;
    };
    Some(SmlibWorker::spawn(path).unwrap())
}
fn request(worker: &SmlibWorker) -> (GeometryDocument, RetainedRequest) {
    let input = b"#1=IFCCARTESIANPOINT((1.,2.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,3.);";
    let mut decoder = EntityDecoder::with_index(input, build_entity_index(input));
    let entity = decoder.decode_by_id(5).unwrap();
    let source = extract_analytic_extrusion(&entity, &mut decoder);
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion {
            source,
            length_unit_scale: 1.,
            source_epoch: 1,
            source_revision: 1,
        })
        .unwrap();
    let request = document
        .prepare_retained_extrusion(
            definition,
            EvaluationContract::RetainedBrep,
            worker.incarnation(),
        )
        .unwrap();
    (document, request)
}
#[test]
fn actual_sdk_receipt_binds_exact_packet_handle_and_live_owner() {
    let Some(mut worker) = worker() else { return };
    let (mut document, request) = request(&worker);
    let receipt = worker
        .evaluate_retained_extrusion(request, 0.001, 15., MeshLimits::default())
        .unwrap();
    receipt.validate_live().unwrap();
    let solid = receipt.solid();
    assert!((worker.volume(solid, 1e-8).unwrap() - 24.).abs() < 1e-6);
    assert!(worker.is_manifold(solid).unwrap());
    let packet = receipt.completion();
    assert!(!packet.tessellation.indices.is_empty());
    for (axis, expected) in [2., 4., 3.].into_iter().enumerate() {
        let coordinates: Vec<_> = packet
            .tessellation
            .positions
            .chunks_exact(3)
            .map(|v| v[axis])
            .collect();
        let min = coordinates.iter().copied().fold(f64::INFINITY, f64::min);
        let max = coordinates
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(min.abs() < 1e-6 && (max - expected).abs() < 1e-6);
    }
    let owner = receipt.owner().clone();
    let pid = worker.process_id();
    owner.retire();
    assert_eq!(worker.incarnation(), 0);
    assert!(receipt.validate_live().is_err());
    assert!(document
        .publish_retained_display(receipt.completion(), owner.incarnation().unwrap_or(0), &[])
        .is_err());
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    // The exact owned buffers remain available for rejection diagnostics.
    assert!(!receipt.completion().tessellation.positions.is_empty());
}
#[test]
fn actual_sdk_retained_limit_error_with_successful_cleanup_preserves_session() {
    let Some(mut worker) = worker() else { return };
    let (_, request) = request(&worker);
    let old = worker.incarnation();
    assert!(matches!(
        worker.evaluate_retained_extrusion(request, 0.001, 15., MeshLimits { max_bytes: 0 }),
        Err(WorkerError::ResourceLimit(_))
    ));
    assert_eq!(worker.incarnation(), old);
    let solid = worker.create_box([0.; 3], [2.; 3]).unwrap();
    assert!((worker.volume(solid, 1e-8).unwrap() - 8.).abs() < 1e-6);
    worker.release(solid).unwrap();
}

// P2 sealed-empty witness. Actual SDK execution is required; no mesh/host
// substitute establishes the classification. Keep the result handles alive
// for the identity cases; independent managed Drop is exercised separately.
#[test]
fn actual_sdk_sealed_empty_boolean_identities_preserve_independent_operands() {
    use ifc_lite_geometry::document::BooleanOperation::{Union, Intersection, Difference};
    use ifc_lite_geometry_runtime::{NumericalOutcome, RetainedDependency};
    let Some(mut worker) = worker() else { return };
    let (_, first) = request(&worker); let (_, second) = request(&worker);
    let a = worker.evaluate_retained_extrusion(first, 0.001, 5., MeshLimits::default()).unwrap();
    let b = worker.evaluate_retained_extrusion(second, 0.001, 5., MeshLimits::default()).unwrap();
    let identity = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
    let mut far = identity; far[12] = 100.;
    let source = |realization, world_from_source| RetainedDependency::Source { realization, world_from_source };
    let empty = worker.evaluate_retained_boolean(source(&a, identity), source(&b, far),
        Intersection, 0.001, 5., MeshLimits::default()).unwrap();
    let removed = worker.evaluate_retained_boolean(source(&a, identity), source(&a, identity),
        Difference, 0.001, 5., MeshLimits::default()).unwrap();
    let mut results = Vec::new();
    for operation in [Union, Intersection, Difference] {
        let result = worker.evaluate_retained_boolean(RetainedDependency::Result(&empty),
            RetainedDependency::Result(&removed), operation, 0.001, 5., MeshLimits::default()).unwrap();
        assert!(result.is_empty()); result.validate_live().unwrap(); results.push(result);
    }
    for zero in [&empty, &removed] {
        assert_eq!(zero.outcome(), NumericalOutcome::Empty);
        assert!(zero.is_empty()); assert!(zero.mesh().positions.is_empty());
        assert!(worker.is_empty(zero.solid()).unwrap());
        for operation in [Union, Intersection, Difference] {
            for reverse in [false, true] {
                let (left, right) = if reverse {
                    (source(&a, identity), RetainedDependency::Result(zero))
                } else { (RetainedDependency::Result(zero), source(&a, identity)) };
                let result = worker.evaluate_retained_boolean(left, right, operation,
                    0.001, 5., MeshLimits::default()).unwrap();
                let expected = operation == Intersection || (operation == Difference && !reverse);
                assert_eq!(result.is_empty(), expected);
                assert_eq!(worker.is_empty(result.solid()).unwrap(), expected);
                assert_eq!(result.mesh().indices.is_empty(), expected);
                if !expected { assert!((worker.volume(result.solid(), 1e-8).unwrap() - 24.).abs() < 1e-6); }
                a.validate_live().unwrap(); b.validate_live().unwrap(); zero.validate_live().unwrap();
                assert!((worker.volume(a.solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
                results.push(result);
            }
        }
    }
    // Explicit per-handle release preserves the independent inputs. This does
    // not qualify dropping a native result, whose existing Drop retires owner.
    worker.release(empty.solid()).unwrap();
    assert!(empty.validate_live().is_err());
    a.validate_live().unwrap(); b.validate_live().unwrap(); removed.validate_live().unwrap();
    assert!(worker.is_empty(removed.solid()).unwrap());
}

#[test]
fn actual_sdk_managed_sources_and_chained_results_have_independent_lifetimes() {
    use ifc_lite_geometry::document::BooleanOperation;
    use ifc_lite_geometry_runtime::RetainedDependency;
    let Some(mut worker) = worker() else { return };
    let identity = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
    let mut shifted = identity;
    shifted[12] = 1.;
    let (_, first) = request(&worker);
    let (_, second) = request(&worker);
    let a = worker.evaluate_retained_extrusion(first, 0.001, 15., MeshLimits::default()).unwrap();
    let b = worker.evaluate_retained_extrusion(second, 0.001, 15., MeshLimits::default()).unwrap();
    let first = worker.evaluate_retained_boolean(
        RetainedDependency::Source { realization: &a, world_from_source: identity },
        RetainedDependency::Source { realization: &b, world_from_source: shifted },
        BooleanOperation::Union, 0.001, 15., MeshLimits::default()).unwrap();
    let chained = worker.evaluate_retained_boolean(
        RetainedDependency::Result(&first),
        RetainedDependency::Source { realization: &b, world_from_source: shifted },
        BooleanOperation::Difference, 0.001, 15., MeshLimits::default()).unwrap();
    assert!((worker.volume(first.solid(), 1e-8).unwrap() - 36.).abs() < 1e-6);
    assert!((worker.volume(chained.solid(), 1e-8).unwrap() - 12.).abs() < 1e-6);
    let stale_intermediate = first.solid();
    drop(first);
    assert!(matches!(worker.volume(stale_intermediate, 1e-8), Err(WorkerError::WrongWorker)));
    // A sibling command drains the intermediate, then performs actual SDK work.
    assert!((worker.volume(b.solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
    let original = a.solid();
    drop(a);
    assert!(matches!(worker.release(original), Err(WorkerError::WrongWorker)));
    worker.release(b.solid()).unwrap();
    assert!(b.validate_live().is_err()); // explicit raw release before acceptance
    drop(b);
    worker.flush_releases().unwrap();
    // Actual result-copy survival after both sources and the intermediate die.
    assert!((worker.volume(chained.solid(), 1e-8).unwrap() - 12.).abs() < 1e-6);
    assert!(worker.is_manifold(chained.solid()).unwrap());
    let copy = worker.copy_transform(chained.solid(), identity).unwrap();
    drop(chained);
    worker.flush_releases().unwrap();
    assert!((worker.volume(copy, 1e-8).unwrap() - 12.).abs() < 1e-6);
    worker.release(copy).unwrap();
}

#[test]
fn actual_sdk_consumed_raw_escape_survives_managed_cleanup_and_slot_reuse() {
    let Some(mut worker) = worker() else { return };
    let (_, source) = request(&worker);
    let receipt = worker.evaluate_retained_extrusion(source, 0.001, 15., MeshLimits::default()).unwrap();
    let (raw, packet) = receipt.into_host_trusted_parts();
    worker.flush_releases().unwrap();
    assert!((worker.volume(raw, 1e-8).unwrap() - 24.).abs() < 1e-6);
    assert!(!packet.tessellation.indices.is_empty());
    worker.release(raw).unwrap();
    let replacement = worker.create_box([0.; 3], [3.; 3]).unwrap();
    worker.flush_releases().unwrap();
    assert!(matches!(worker.volume(raw, 1e-8), Err(WorkerError::WrongWorker)));
    assert!((worker.volume(replacement, 1e-8).unwrap() - 27.).abs() < 1e-6);
    worker.release(replacement).unwrap();
}

#[test]
fn actual_sdk_explicit_raw_release_invalidates_receipt_before_accept_and_preserves_replacement() {
    let Some(mut worker) = worker() else { return };
    let (_, source) = request(&worker);
    let receipt = worker.evaluate_retained_extrusion(source, 0.001, 15., MeshLimits::default()).unwrap();
    let old = receipt.solid();
    worker.release(old).unwrap();
    assert!(receipt.validate_live().is_err());
    let replacement = worker.create_box([0.; 3], [3.; 3]).unwrap();
    drop(receipt); // stale final Drop must not queue release for a reused slot
    worker.flush_releases().unwrap();
    assert!((worker.volume(replacement, 1e-8).unwrap() - 27.).abs() < 1e-6);
    assert!(matches!(worker.release(old), Err(WorkerError::WrongWorker)));
    worker.release(replacement).unwrap();
}

#[test]
fn actual_sdk_affine_chain_preserves_raw_lineage_and_independent_brep_ownership() {
    use ifc_lite_geometry::document::BooleanOperation;
    use ifc_lite_geometry_runtime::{RetainedDependency, RetainedLineage, RetainedTransformInput};
    let Some(mut worker)=worker() else { return };
    let (_document,request)=request(&worker);
    let source=worker.evaluate_retained_extrusion(request.clone(),0.001,5.,MeshLimits::default()).unwrap();
    let identity=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
    let reflected=[-2.,0.,0.,0.,0.,3.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
    let first=worker.copy_retained_affine(RetainedTransformInput::Source(&source),reflected).unwrap();
    assert_eq!(first.operation_identity().input,source.solid());
    assert_eq!(first.operation_identity().column_major,reflected);
    assert!((worker.volume(first.solid(),1e-8).unwrap()-144.).abs()<144e-5);
    let second=worker.copy_retained_affine(RetainedTransformInput::Affine(&first),identity).unwrap();
    worker.release(source.solid()).unwrap();
    assert!(source.validate_live().is_err()); first.validate_live().unwrap(); second.validate_live().unwrap();
    let RetainedLineage::AffineCopy { input,.. }=second.lineage() else { panic!("missing repeated-copy lineage") };
    let RetainedLineage::AffineCopy { input,column_major,.. }=input.as_ref() else { panic!("missing first transform") };
    assert_eq!(*column_major,reflected);
    let RetainedLineage::Definition { request:original,.. }=input.as_ref() else { panic!("missing original source coefficients") };
    assert_eq!(original.as_ref(),&request);
    let result=worker.evaluate_retained_boolean(
        RetainedDependency::Affine {copy:&first,world_from_affine:identity},
        RetainedDependency::Affine {copy:&second,world_from_affine:identity},
        BooleanOperation::Union,0.001,5.,MeshLimits::default()).unwrap();
    let final_copy=worker.copy_retained_affine(RetainedTransformInput::Result(&result),reflected).unwrap();
    assert!((worker.volume(final_copy.solid(),1e-8).unwrap()-864.).abs()<864e-5);
    let RetainedLineage::AffineCopy { input,.. }=final_copy.lineage() else { panic!("missing result-copy operation") };
    assert!(matches!(input.as_ref(),RetainedLineage::Boolean { .. }));
    worker.release(first.solid()).unwrap();
    second.validate_live().unwrap(); result.validate_live().unwrap(); final_copy.validate_live().unwrap();
    assert!((worker.volume(second.solid(),1e-8).unwrap()-144.).abs()<144e-5);
    worker.release(second.solid()).unwrap(); worker.release(final_copy.solid()).unwrap();
    worker.release(result.solid()).unwrap();
}
