// SPDX-License-Identifier: MPL-2.0
//! Real common continuation + sealed SDK receipt invariants. No transport mock.
//! These tests skip without the actual SDK worker and are not scene qualification.
use super::super::session_tests::{job, metadata, options, router, SOURCE};
use super::super::{OwnedMeshProductionData, ProductionModel};
use super::*;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::MeshLimits;

pub(super) fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP common retained SDK continuation: build pinned worker and set IFCLITE_SMLIB_WORKER");
        return None;
    };
    Some(SmlibWorker::spawn(path).expect("configured SDK worker must start"))
}
pub(super) fn context() -> (ProductionModel, Arc<OwnedMeshProductionContext>) {
    let model = ProductionModel::from_source(SourceBundle::new(SOURCE.as_bytes().to_vec()));
    let context = model.snapshot(OwnedMeshProductionData::default());
    (model, context)
}
pub(super) fn execution(
    context: &Arc<OwnedMeshProductionContext>,
    decoder: &mut EntityDecoder<'_>,
    router: &GeometryRouter,
) -> RetainedProductExecution {
    let entity = decoder.decode_by_id(10).unwrap();
    RetainedProductExecution::new(
        &job(&entity, &metadata(10)),
        context,
        &options(),
        decoder,
        router,
    )
    .unwrap()
}
#[test]
fn common_retained_actual_construction_is_consumed_and_original_product_resumes() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let caller_order = router.set_preserve_triangle_order(false);
    router.set_preserve_triangle_order(caller_order);
    let mut execution = execution(&context, &mut decoder, &router);
    let issued = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .unwrap();
    assert!(
        decoder.try_execution_lease().is_err(),
        "actual owner reservation remains dormant"
    );
    assert!(router.try_execution_lease().is_err());
    let restored_order = router.set_preserve_triangle_order(caller_order);
    assert_eq!(
        restored_order, caller_order,
        "lexical mode restored before handoff"
    );
    let common = execution.pending.as_ref().unwrap().outer.inner;
    let receipt = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    assert!((worker.volume(receipt.realization().solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
    assert_eq!(execution.pending.as_ref().unwrap().outer.inner, common);
    execution.accept(receipt, &mut decoder, &router).unwrap();
    assert_eq!(execution.discharged_count(), 1);
    assert!(execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .is_none());
    let plan = execution
        .traversal_plan()
        .expect("same common traversal finished");
    assert_eq!(plan.values.len(), 1);
    assert!(
        !plan.remaining.is_empty(),
        "leaf receipt cannot authorize final-net publication"
    );
    assert!(worker.incarnation() != 0);
}
#[test]
fn common_retained_foreign_expired_receiver_wrong_stage_and_owner_return_intact_receipt() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut owner = execution(&context, &mut decoder, &router);
    let issued = owner
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .unwrap();
    let receipt = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    let solid = receipt.realization().solid();
    let (foreign_model, foreign_context) = self::context();
    let mut foreign_decoder = foreign_context.source().unwrap().decoder();
    let foreign_router = self::router(&mut foreign_decoder);
    let mut foreign = execution(&foreign_context, &mut foreign_decoder, &foreign_router);
    foreign_model.invalidate_source();
    let rejected = foreign
        .accept(receipt, &mut foreign_decoder, &foreign_router)
        .unwrap_err();
    assert_eq!(rejected.work.realization().solid(), solid);
    assert_ne!(
        worker.incarnation(),
        0,
        "foreign source expiry cannot retire our worker"
    );
    owner
        .pending
        .as_ref()
        .unwrap()
        .stage
        .store(EXECUTING, Ordering::Release);
    let rejected = owner
        .accept(rejected.work, &mut decoder, &router)
        .unwrap_err();
    assert_eq!(owner.discharged_count(), 0);
    owner
        .pending
        .as_ref()
        .unwrap()
        .stage
        .store(DELIVERED, Ordering::Release);
    let rejected = owner
        .accept(rejected.work, &mut decoder, &foreign_router)
        .unwrap_err();
    assert_eq!(rejected.work.realization().solid(), solid);
    owner.accept(rejected.work, &mut decoder, &router).unwrap();
    assert_eq!(owner.discharged_count(), 1);
}
#[test]
fn common_retained_own_source_expiry_retires_captured_owner_and_preserves_buffers() {
    let Some(mut worker) = worker() else { return };
    let (model, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let issued = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .unwrap();
    let work = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    let positions = work
        .realization()
        .completion()
        .tessellation
        .positions
        .clone();
    model.invalidate_source();
    let rejected = execution.accept(work, &mut decoder, &router).unwrap_err();
    assert!(matches!(rejected.reason, RetainedExecutionError::Source));
    assert_eq!(worker.incarnation(), 0);
    assert_eq!(
        rejected
            .work
            .realization()
            .completion()
            .tessellation
            .positions,
        positions
    );
    assert_eq!(execution.discharged_count(), 0);
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
}
#[test]
fn common_retained_cancel_between_issue_and_execute_uses_independent_owner_capability() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let issued = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .unwrap();
    let cancellation = issued.cancellation();
    cancellation.cancel();
    assert!(issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .is_err());
    assert_eq!(worker.incarnation(), 0);
    assert_eq!(execution.discharged_count(), 0);
}
#[test]
fn common_retained_wrong_original_admission_rejects_before_consumption_then_duplicate_rejects() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let issued = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .unwrap();
    let original_request = execution.pending.as_ref().unwrap().request.clone();
    let work = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    let mut wrong_document = GeometryDocument::new();
    let definition = wrong_document
        .add_retained_construction(original_request.recipe().clone())
        .unwrap();
    let wrong_request = wrong_document
        .prepare_retained_extrusion(
            definition,
            EvaluationContract::RetainedBrep,
            worker.incarnation(),
        )
        .unwrap();
    execution.pending.as_mut().unwrap().request = wrong_request;
    let rejected = execution.accept(work, &mut decoder, &router).unwrap_err();
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    assert_eq!(execution.discharged_count(), 0);
    execution.pending.as_mut().unwrap().request = original_request.clone();
    // Internal hostile replay uses a second actual SDK result, never forged buffers.
    let duplicate = CompletedCommonConstruction {
        ticket: rejected.work.ticket.clone(),
        stage: rejected.work.stage.clone(),
        realization: worker
            .evaluate_retained_extrusion(original_request, 0.001, 15., MeshLimits::default())
            .unwrap(),
    };
    execution
        .accept(rejected.work, &mut decoder, &router)
        .unwrap();
    let rejected = execution
        .accept(duplicate, &mut decoder, &router)
        .unwrap_err();
    assert_eq!(execution.discharged_count(), 1);
    assert_ne!(
        worker.incarnation(),
        0,
        "duplicate rejected intact before retirement"
    );
    assert!(rejected.work.realization().validate_live().is_ok());
}

#[test]
fn common_retained_repeated_source_occurrences_keep_independent_sealed_objects() {
    let Some(mut worker) = worker() else { return };
    let source = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    let model = ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let mut solids = Vec::new();
    for _ in 0..2 {
        let issued = execution
            .issue_next(&worker, &mut decoder, &router)
            .unwrap()
            .unwrap();
        let work = issued
            .execute(&mut worker, 0.001, 15., MeshLimits::default())
            .unwrap();
        solids.push(work.realization().solid());
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert_ne!(solids[0], solids[1]);
    for solid in solids {
        assert!((worker.volume(solid, 1e-8).unwrap() - 24.).abs() < 1e-6);
    }
    assert!(execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .is_none());
    let plan = execution.traversal_plan().unwrap();
    assert_ne!(plan.values[0].slot(), plan.values[1].slot());
    assert_eq!(execution.discharged_count(), 2);
}

#[test]
fn common_retained_ordinary_product_acceptor_cannot_consume_logical_plan_admission() {
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let request = execution.state.request().unwrap().unwrap();
    assert_eq!(
        execution
            .state
            .execute(request, &context.borrowed(), &mut decoder, &router)
            .err(),
        Some(super::super::session_protocol::WorkError::RetainedContract)
    );
    let (reply, operation) = execution
        .state
        .execute_admission(request, &context.borrowed(), &mut decoder, &router)
        .unwrap();
    assert!(
        operation.is_none(),
        "first request is common representation admission"
    );
    let rejected = execution
        .state
        .accept(reply, &context.borrowed(), &mut decoder, &router)
        .unwrap_err();
    assert_eq!(
        rejected.error,
        super::super::session_protocol::WorkError::RetainedContract
    );
    execution
        .state
        .accept_admission(rejected.reply, &context.borrowed(), &mut decoder, &router)
        .unwrap();
    assert!(
        execution.state.request().unwrap().is_some(),
        "original admission remains resumable"
    );
}

#[test]
fn common_retained_released_actual_object_is_rejected_with_intact_receipt() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let issued = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
        .unwrap();
    let work = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    let solid = work.realization().solid();
    let positions = work
        .realization()
        .completion()
        .tessellation
        .positions
        .clone();
    worker.release(solid).unwrap();
    let rejected = execution.accept(work, &mut decoder, &router).unwrap_err();
    assert_eq!(rejected.work.realization().solid(), solid);
    assert_eq!(
        rejected
            .work
            .realization()
            .completion()
            .tessellation
            .positions,
        positions
    );
    assert_eq!(execution.discharged_count(), 0);
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    assert_ne!(
        worker.incarnation(),
        0,
        "rejection itself does not retire a healthy domain"
    );
}

#[test]
fn common_retained_entry_uses_actual_source_root_instead_of_caller_edited_snapshot() {
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut edited = decoder.decode_by_id(10).unwrap();
    Arc::make_mut(&mut edited.attributes)[6] = ifc_lite_core::AttributeValue::EntityRef(999_999);
    let mut execution = RetainedProductExecution::new(
        &job(&edited, &metadata(10)),
        &context,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap();
    loop {
        let request = execution
            .state
            .request()
            .unwrap()
            .expect("real source representation");
        let (reply, operation) = execution
            .state
            .execute_admission(request, &context.borrowed(), &mut decoder, &router)
            .unwrap();
        if let Some(operation) = operation {
            assert_eq!(
                operation.construction().solid_id(),
                13,
                "first construction came from the authenticated IFC root"
            );
            break;
        }
        execution
            .state
            .accept_admission(reply, &context.borrowed(), &mut decoder, &router)
            .unwrap();
    }
}
