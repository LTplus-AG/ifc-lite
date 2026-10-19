// SPDX-License-Identifier: MPL-2.0
//! Retained review round2: actual source authority, cache and lifetime invariants.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::{OwnedMeshProductionData, ProductionModel};
use std::sync::Arc;

const MODEL: &[u8] = include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");

#[test]
fn retained_round2_factory_owner_and_decoder_lease_are_required_even_for_cached_plan() {
    let source = SourceBundle::new(MODEL.to_vec());
    let same_bytes_other_load = SourceBundle::new(MODEL.to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let mut foreign = same_bytes_other_load.decoder();
    assert!(context.admit_authored_plan(&mut foreign).is_err());
    let first = context.admit_authored_plan(&mut decoder).unwrap();
    assert!(!first.plan().recipes.is_empty());
    let second = context.admit_authored_plan(&mut decoder).unwrap();
    assert!(Arc::ptr_eq(&first, &second), "one cached analysis per actual snapshot");
    let lease = decoder.try_execution_lease().unwrap();
    assert!(context.admit_authored_plan(&mut decoder).is_err());
    drop(lease);
    assert!(context.admit_authored_plan(&mut decoder).is_ok());
    let borrowed_model = ProductionModel::new();
    let borrowed = borrowed_model.snapshot(OwnedMeshProductionData::default());
    assert!(borrowed.admit_authored_plan(&mut decoder).is_err());
}

#[test]
fn retained_round2_invalidation_expires_bound_analysis_and_document_without_retaining_bytes() {
    let source = SourceBundle::new(MODEL.to_vec());
    let weak_source = Arc::downgrade(&source);
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    let key = plan.plan().recipes[0].source.clone();
    let document = plan.admit_source(&key).unwrap();
    model.invalidate_source();
    assert!(plan.admit_source(&key).is_err());
    assert!(context.admit_authored_plan(&mut decoder).is_err());
    drop(decoder); drop(context); drop(source); drop(model);
    assert!(weak_source.upgrade().is_none(), "bound numerical owner contains no SourceBundle");
    assert!(document.prepare(&key, ifc_lite_geometry::document::EvaluationContract::RetainedBrep, 1).is_err());
}

#[test]
fn retained_round2_model_drop_preserves_explicit_snapshot_contract_without_source_retention() {
    let source = SourceBundle::new(MODEL.to_vec());
    let weak_source = Arc::downgrade(&source);
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    let key = plan.plan().recipes[0].source.clone();
    let document = plan.admit_source(&key).unwrap();
    drop(decoder); drop(context); drop(source); drop(model);
    assert!(weak_source.upgrade().is_none());
    assert!(document.prepare(&key, ifc_lite_geometry::document::EvaluationContract::RetainedBrep, 1).is_ok());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn retained_round2_actual_receipt_foreign_acceptance_and_source_expiry_return_ownership_intact() {
    use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
    use ifc_lite_processing::authored_geometry::evaluator::RetainedDisplayContract;
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual retained receipt: set IFCLITE_SMLIB_WORKER to compiled SDK worker");
        return;
    };
    let source = SourceBundle::new(MODEL.to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    let key = &plan.plan().recipes.iter().find(|r| r.product_id == 31).unwrap().source;
    let mut document = plan.admit_source(key).unwrap();
    let mut foreign_document = plan.admit_source(key).unwrap();
    let mut worker = SmlibWorker::spawn(&executable).unwrap();
    let issued = document.issue(key, &worker).unwrap();
    assert!(document.issue(key, &worker).is_err(), "pending slot cannot be overwritten");
    let work = document.execute(issued, &mut worker, 0.001, 5., MeshLimits::default()).unwrap();
    let positions = work.realization().completion().tessellation.positions.clone();
    assert!((worker.volume(work.realization().solid(), 1e-8).unwrap() - 1.).abs() < 1e-8);
    let rejected = foreign_document.accept(work, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).err().unwrap();
    assert_eq!(rejected.work.realization().completion().tessellation.positions, positions);
    let published = document.accept(rejected.work, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).unwrap();
    assert!(!document.document().mesh(published.definition).unwrap().indices.is_empty());
    assert!(published.mapped_occurrences.len() >= 2);
    let live = published.work.realization().owner().clone();
    drop(published);
    assert_eq!(live.incarnation(), None, "captured resource domain retired and reaped on owner drop");

    let mut replacement = SmlibWorker::spawn(executable).unwrap();
    let issued = foreign_document.issue(key, &replacement).unwrap();
    let work = foreign_document.execute(issued, &mut replacement, 0.001, 5., MeshLimits::default()).unwrap();
    let owner = work.realization().owner().clone();
    let positions = work.realization().completion().tessellation.positions.clone();
    model.invalidate_source();
    let before = foreign_document.document().revision();
    let rejected = foreign_document.accept(work, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).err().unwrap();
    assert_eq!(owner.incarnation(), None, "source expiry retires allocation before rejection returns");
    assert_eq!(foreign_document.document().revision(), before);
    assert_eq!(rejected.work.realization().completion().tessellation.positions, positions);
    drop(rejected);
    assert_eq!(owner.incarnation(), None);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn retained_round2_actual_cancelled_or_dead_runtime_receipt_cannot_publish_or_replay() {
    use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
    use ifc_lite_processing::authored_geometry::evaluator::RetainedDisplayContract;
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual retained receipt cancellation: set IFCLITE_SMLIB_WORKER"); return;
    };
    let source = SourceBundle::new(MODEL.to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    let key = &plan.plan().recipes[0].source;
    let mut document = plan.admit_source(key).unwrap();
    let mut worker = SmlibWorker::spawn(executable).unwrap();
    let issued = document.issue(key, &worker).unwrap();
    let work = document.execute(issued, &mut worker, 0.001, 5., MeshLimits::default()).unwrap();
    document.cancel_pending();
    let rejected = document.accept(work, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).err().unwrap();
    let captured = rejected.work.realization().owner().clone();
    drop(rejected);
    assert_eq!(captured.incarnation(), None);
    assert!(document.issue(key, &worker).is_err(), "dead worker cannot create a replay implicitly");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn retained_round2_review_terminal_error_and_abandoned_ticket_free_only_their_slot() {
    use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker, WorkerError};
    use ifc_lite_processing::authored_geometry::evaluator::RetainedDisplayContract;
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual retained ticket cleanup: set IFCLITE_SMLIB_WORKER"); return;
    };
    let source = SourceBundle::new(MODEL.to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    let key = &plan.plan().recipes[0].source;
    let mut document = plan.admit_source(key).unwrap();
    let mut other = plan.admit_source(key).unwrap();
    let mut worker = SmlibWorker::spawn(executable).unwrap();
    let abandoned = document.issue(key, &worker).unwrap();
    drop(abandoned);
    let limited = document.issue(key, &worker).unwrap();
    assert!(matches!(document.execute(limited, &mut worker, 0.001, 5., MeshLimits { max_bytes: 0 }),
        Err(WorkerError::ResourceLimit(_))));
    // Real SDK limit cleanup released the solid and did not retire the session.
    let fresh = document.issue(key, &worker).unwrap();
    let other_pending = other.issue(key, &worker).unwrap();
    assert!(other.execute(fresh, &mut worker, 0.001, 5., MeshLimits::default()).is_err());
    assert!(other.issue(key, &worker).is_err(), "foreign work must not release the active ticket");
    let accepted = document.issue(key, &worker).unwrap();
    let completed = document.execute(accepted, &mut worker, 0.001, 5., MeshLimits::default()).unwrap();
    let published = document.accept(completed, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).unwrap();
    assert!(!document.document().mesh(published.definition).unwrap().indices.is_empty());
    drop(other_pending);
    assert!(other.issue(key, &worker).is_ok());
    drop(published);
}

#[test]
fn retained_round2_canonical_last_duplicate_and_prewarmed_cache_survive_model_admission() {
    use ifc_lite_processing::authored_geometry::AuthoredDefinition;
    // Stated IFC invariant: the canonical source index selects the last record
    // for duplicate STEP IDs, including when the selected record is prewarmed.
    let source_text = std::str::from_utf8(MODEL).unwrap().replace(
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);\n#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,7.0);\n#1000=IFCPOLYLOOP((#1,#10,#14));");
    let source = SourceBundle::new(source_text.into_bytes());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut warm = source.decoder();
    assert_eq!(warm.decode_by_id(12).unwrap().get_float(3), Some(7.));
    assert_eq!(warm.get_polyloop_coords_cached(1000).unwrap(), vec![(0., 0., 0.); 3]);
    assert_eq!(warm.point_cache_stats(), (0, 3));
    let points = warm.take_source_point_cache();
    let mut decoder = source.decoder();
    assert!(decoder.set_source_point_cache(points));
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    for source in &plan.plan().definitions {
        if let AuthoredDefinition::Extrusion(source) = source {
            assert_eq!(source.source.depth, Some(7.));
        }
    }
    assert_eq!(plan.plan().recipes.iter().filter(|r| r.product_id == 31).count(), 1);
    assert_eq!(decoder.get_polyloop_coords_cached(1000).unwrap(), vec![(0., 0., 0.); 3]);
    assert_eq!(decoder.point_cache_stats().1, 0, "admission preserves the authenticated warm point cache");
}

#[test]
fn retained_round2_cached_plan_cannot_authorize_later_untrusted_input_revision() {
    let source = SourceBundle::new(MODEL.to_vec());
    let mut decoder = source.decoder();
    decoder.set_point_cache(Default::default());
    assert!(!source.owns_decoder(&decoder));
    let model = ProductionModel::from_trusted_inputs(decoder.trusted_inputs().unwrap());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    assert!(!plan.plan().recipes.is_empty());
    decoder.set_point_cache(Default::default());
    assert!(context.admit_authored_plan(&mut decoder).is_err(), "cache hit must still authenticate input revision");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn retained_round2_review_expired_foreign_receiver_cannot_retire_valid_owner() {
    use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
    use ifc_lite_processing::authored_geometry::evaluator::RetainedDisplayContract;
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual expired foreign owner: set IFCLITE_SMLIB_WORKER"); return;
    };
    let source = SourceBundle::new(MODEL.to_vec());
    // The same immutable source can participate in distinct model lifecycles.
    let model_a = ProductionModel::from_source(source.clone());
    let model_b = ProductionModel::from_source(source.clone());
    let context_a = model_a.snapshot(OwnedMeshProductionData::default());
    let context_b = model_b.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan_a = context_a.admit_authored_plan(&mut decoder).unwrap();
    let plan_b = context_b.admit_authored_plan(&mut decoder).unwrap();
    let key = &plan_b.plan().recipes[0].source;
    let mut document_a = plan_a.admit_source(key).unwrap();
    let mut document_b = plan_b.admit_source(key).unwrap();
    let mut worker = SmlibWorker::spawn(executable).unwrap();
    let pending_a = document_a.issue(key, &worker).unwrap();
    let issued_b = document_b.issue(key, &worker).unwrap();
    let completed_b = document_b.execute(issued_b, &mut worker, 0.001, 5., MeshLimits::default()).unwrap();
    let owner_b = completed_b.realization().owner().clone();
    let before = owner_b.incarnation().unwrap();
    model_a.invalidate_source();
    let rejected = document_a.accept(completed_b, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).err().unwrap();
    assert_eq!(owner_b.incarnation(), Some(before), "foreign expiry is not runtime retirement authority");
    let published_b = document_b.accept(rejected.work, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).unwrap();
    assert!(!document_b.document().mesh(published_b.definition).unwrap().indices.is_empty());
    drop(pending_a);
    drop(published_b);
    assert_eq!(owner_b.incarnation(), None);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn retained_round3_released_object_cannot_publish_even_while_actual_process_is_live() {
    use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
    use ifc_lite_processing::authored_geometry::evaluator::RetainedDisplayContract;
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual retained release-before-accept: set IFCLITE_SMLIB_WORKER"); return;
    };
    let source = SourceBundle::new(MODEL.to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let plan = context.admit_authored_plan(&mut decoder).unwrap();
    let key = &plan.plan().recipes[0].source;
    let mut document = plan.admit_source(key).unwrap();
    let mut worker = SmlibWorker::spawn(executable).unwrap();
    let issued = document.issue(key, &worker).unwrap();
    let work = document.execute(issued, &mut worker, 0.001, 5., MeshLimits::default()).unwrap();
    let incarnation = worker.incarnation();
    let positions = work.realization().completion().tessellation.positions.clone();
    worker.release(work.realization().solid()).unwrap();
    assert_eq!(worker.incarnation(), incarnation, "individual release preserves a healthy process");
    assert!(work.realization().validate_live().is_err(), "process liveness cannot resurrect released object");
    let revision = document.document().revision();
    let rejected = document.accept(work, 0, RetainedDisplayContract::UnstyledFlatSourceOnly).err().unwrap();
    assert_eq!(document.document().revision(), revision, "rejection precedes display publication");
    assert_eq!(rejected.work.realization().completion().tessellation.positions, positions);
}
