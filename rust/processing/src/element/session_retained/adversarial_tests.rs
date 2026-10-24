// SPDX-License-Identifier: MPL-2.0
//! #7955: actual sealed receipts, source authority and original account ancestry.
use super::super::session_tests::{job, metadata, options, SOURCE};
use super::*;
use super::tests::router;
use ifc_lite_core::SourceBundle;
use resource::{Cost, Dimension, ExecutionAccount, ExecutionPolicy, ResourceLimits};
fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}
pub(super) fn with_case(
    original: Option<&ExecutionAccount>,
    source_text: &str,
    test: impl FnOnce(
        &mut RetainedProductExecution<'_>,
        &mut EntityDecoder<'_>,
        &GeometryRouter,
        &mut SmlibWorker,
        &ProductionModel,
        &Arc<OwnedMeshProductionContext>,
    ),
) {
    let Some(mut worker) = super::tests::worker() else {
        return;
    };
    let source = SourceBundle::new(source_text.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(Default::default());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let create = || {
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap()
    };
    let mut execution = match original {
        Some(account) => account.scope(create),
        None => {
            let mut create = create;
            create()
        }
    };
    test(
        &mut execution,
        &mut decoder,
        &router,
        &mut worker,
        &model,
        &context,
    );
}
fn complete(
    e: &mut RetainedProductExecution,
    d: &mut EntityDecoder,
    r: &GeometryRouter,
    w: &mut SmlibWorker,
) -> CompletedCommonConstruction {
    e.issue_next(d, r, w)
        .unwrap()
        .unwrap()
        .execute(w, 0.001, 15., MeshLimits::default())
        .unwrap()
}
fn accept(
    e: &mut RetainedProductExecution,
    receipt: CompletedCommonConstruction,
    d: &mut EntityDecoder,
    r: &GeometryRouter,
) {
    e.accept(receipt, d, r)
        .unwrap_or_else(|e| panic!("{:?}", e.reason));
}
#[test]
fn common_retained_foreign_expired_receiver_wrong_stage_and_owner_return_intact_receipt() {
    with_case(None, SOURCE, |e, d, r, w, _, ctx| {
        let receipt = complete(e, d, r, w);
        let address = receipt
            .realizations()[0].construction().unwrap()
            .completion()
            .tessellation
            .positions
            .as_ptr();
        let foreign_router = GeometryRouter::new();
        let rejected = e.accept(receipt, d, &foreign_router).err().unwrap();
        assert_eq!(
            address,
            rejected
                .work
                .realizations()[0].construction().unwrap()
                .completion()
                .tessellation
                .positions
                .as_ptr()
        );
        let stage = e.pending.as_ref().unwrap().cancellation.stage.clone();
        stage.store(ISSUED, Ordering::Release);
        let rejected = e.accept(rejected.work, d, r).err().unwrap();
        stage.store(DELIVERED, Ordering::Release);
        let foreign_model = ProductionModel::from_source(ctx.source().unwrap().clone());
        let foreign_context = foreign_model.snapshot(Default::default());
        let mut other_decoder = ctx.source().unwrap().decoder();
        let other_router = router(&mut other_decoder);
        let entity = other_decoder.decode_by_id(20).unwrap();
        let metadata = metadata(20);
        let job = job(&entity, &metadata);
        let mut foreign = RetainedProductExecution::begin(
            &job,
            &foreign_context,
            &options(),
            &mut other_decoder,
            &other_router,
        )
        .unwrap();
        foreign_model.invalidate_source();
        let rejected = foreign
            .accept(rejected.work, &mut other_decoder, &other_router)
            .err()
            .unwrap();
        assert!(rejected.work.realizations()[0].construction().unwrap().validate_live().is_ok());
        assert_eq!(
            address,
            rejected
                .work
                .realizations()[0].construction().unwrap()
                .completion()
                .tessellation
                .positions
                .as_ptr()
        );
        accept(e, rejected.work, d, r);
        assert_eq!(e.discharged_count(), 1);
    });
}
#[test]
fn common_retained_own_source_expiry_retires_captured_owner_and_preserves_buffers() {
    with_case(None, SOURCE, |e, d, r, w, model, _| {
        let receipt = complete(e, d, r, w);
        let address = receipt
            .realizations()[0].construction().unwrap()
            .completion()
            .tessellation
            .positions
            .as_ptr();
        model.invalidate_source();
        let rejected = e.accept(receipt, d, r).err().unwrap();
        assert!(matches!(rejected.reason, RetainedExecutionError::Source));
        assert!(rejected.work.realizations()[0].construction().unwrap().owner().incarnation().is_none());
        assert_eq!(
            address,
            rejected
                .work
                .realizations()[0].construction().unwrap()
                .completion()
                .tessellation
                .positions
                .as_ptr()
        );
        assert_eq!(e.discharged_count(), 0);
    });
}
#[test]
fn common_retained_wrong_original_admission_rejects_before_consumption_then_duplicate_rejects() {
    with_case(None, SOURCE, |e, d, r, w, _, _| {
        let receipt = complete(e, d, r, w);
        let pending = e.pending.as_mut().unwrap();
        let mut document = GeometryDocument::new();
        let PendingRetainedOperation::Construction { request, .. } = &mut pending.operations[0] else { panic!("fixture construction") };
        let RetainedRecipe::Extrusion(recipe) = request.recipe() else {
            panic!("fixture extrusion")
        };
        let definition = document.add_retained_extrusion(recipe.clone()).unwrap();
        let wrong = document
            .prepare_retained(definition, w.incarnation())
            .unwrap();
        let original = std::mem::replace(request, wrong);
        let rejected = e.accept(receipt, d, r).err().unwrap();
        assert_eq!(e.discharged_count(), 0);
        let PendingRetainedOperation::Construction { request, .. } = &mut e.pending.as_mut().unwrap().operations[0]
            else { panic!("fixture construction") };
        *request = original;
        // A test-only duplicated envelope still shares the real sealed object.
        let duplicate = CompletedCommonConstruction {
            cancellation: rejected.work.cancellation.clone(),
            realizations: rejected.work.realizations.clone(),
        };
        accept(e, rejected.work, d, r);
        let rejected = e.accept(duplicate, d, r).err().unwrap();
        assert!(rejected.work.realizations()[0].construction().unwrap().validate_live().is_ok());
        assert_eq!(e.discharged_count(), 1);
    });
}
#[test]
fn outer_and_inner_ticket_mismatch_rejects_before_take() {
    with_case(None, SOURCE, |e, d, r, w, _, ctx| {
        let receipt = complete(e, d, r, w);
        let mut decoder = ctx.source().unwrap().decoder();
        let router = router(&mut decoder);
        let entity = decoder.decode_by_id(20).unwrap();
        let metadata = metadata(20);
        let job = job(&entity, &metadata);
        let mut other =
            RetainedProductExecution::begin(&job, ctx, &options(), &mut decoder, &router).unwrap();
        let other_receipt = complete(&mut other, &mut decoder, &router, w);
        let pending = e.pending.as_mut().unwrap();
        let original_outer = std::mem::replace(&mut pending.outer, other.outer.unwrap());
        let rejected = e.accept(receipt, d, r).err().unwrap();
        let pending = e.pending.as_mut().unwrap();
        pending.outer = original_outer;
        let original_inner =
            std::mem::replace(&mut pending.common, other.pending.as_ref().unwrap().common);
        let rejected = e.accept(rejected.work, d, r).err().unwrap();
        e.pending.as_mut().unwrap().common = original_inner;
        assert_eq!(e.discharged_count(), 0);
        accept(e, rejected.work, d, r);
        accept(&mut other, other_receipt, &mut decoder, &router);
    });
}
#[test]
fn common_retained_repeated_source_occurrences_keep_independent_sealed_objects() {
    let text = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    with_case(None, &text, |e, d, r, w, _, _| {
        let first = complete(e, d, r, w);
        let first_solid = first.realizations()[0].construction().unwrap().solid();
        accept(e, first, d, r);
        let second = complete(e, d, r, w);
        assert_ne!(first_solid, second.realizations()[0].construction().unwrap().solid());
        accept(e, second, d, r);
        assert!(e.issue_next(d, r, w).unwrap().is_none());
        assert_eq!(e.traversal_plan().unwrap().values.len(), 2);
        assert_eq!(e.discharged_count(), 2);
        e.validate_witness().unwrap();
    });
}
#[test]
fn common_retained_released_actual_object_is_rejected_with_intact_receipt() {
    with_case(None, SOURCE, |e, d, r, w, _, _| {
        let receipt = complete(e, d, r, w);
        let address = receipt
            .realizations()[0].construction().unwrap()
            .completion()
            .tessellation
            .positions
            .as_ptr();
        w.release(receipt.realizations()[0].construction().unwrap().solid()).unwrap();
        let rejected = e.accept(receipt, d, r).err().unwrap();
        assert_eq!(
            address,
            rejected
                .work
                .realizations()[0].construction().unwrap()
                .completion()
                .tessellation
                .positions
                .as_ptr()
        );
        assert_eq!(e.discharged_count(), 0);
    });
}
#[test]
fn original_account_cancelled_after_issue_refuses_sdk_execution_outside_scope() {
    let original = account();
    with_case(Some(&original), SOURCE, |e, d, r, w, _, _| {
        let issued = e.issue_next(d, r, w).unwrap().unwrap();
        let before = original.usage().work;
        original.cancel();
        let rejected = issued.execute(w, 0.001, 15., MeshLimits::default()).err().unwrap();
        assert!(matches!(rejected.reason, RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
        assert!(rejected.issued.is_none());
        assert_eq!(original.usage().work, before);
        assert!(w.retained_owner().incarnation().is_none());
        assert_eq!(e.discharged_count(), 0);
    });
}
#[test]
fn original_cancellation_before_accept_wins_over_absent_or_foreign_ambient_account() {
    for foreign_scope in [false, true] {
        let original = account();
        with_case(Some(&original), SOURCE, |e, d, r, w, _, _| {
            let receipt = complete(e, d, r, w);
            original.cancel();
            let foreign = account();
            let rejected = if foreign_scope {
                foreign.scope(|| e.accept(receipt, d, r))
            } else {
                e.accept(receipt, d, r)
            }
            .err()
            .unwrap();
            assert!(matches!(
                rejected.reason,
                RetainedExecutionError::Stopped(ProgramStop::Cancelled)
            ));
            assert!(rejected.work.realizations()[0].construction().unwrap().validate_live().is_ok());
            assert_eq!(foreign.usage(), resource::Usage::default());
            assert_eq!(e.discharged_count(), 0);
        });
    }
}
#[test]
fn actual_sealed_acceptance_charges_ledger_backing_to_original_account_after_caller_drop() {
    let original = account();
    with_case(Some(&original), SOURCE, |e, d, r, w, _, _| {
        let receipt = complete(e, d, r, w);
        assert_eq!(e.ledger.capacity(), 0);
        let before = original.usage();
        let foreign = account();
        foreign.scope(|| accept(e, receipt, d, r));
        assert!(original.usage().live_bytes > before.live_bytes);
        assert_eq!(foreign.usage(), resource::Usage::default());
        assert!(e.ledger.capacity() >= 1);
    });
}
#[test]
fn original_reached_work_allowance_refuses_issue_under_a_fresh_foreign_account() {
    let original = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(1_000_000),
        ..Default::default()
    }));
    with_case(Some(&original), SOURCE, |e, d, r, w, _, _| {
        let remaining = 1_000_000 - original.usage().work;
        original.scope(|| {
            resource::charge(Cost {
                work: remaining,
                ..Default::default()
            })
            .unwrap()
            .retain()
        });
        let foreign = account();
        assert!(
            matches!(foreign.scope(|| e.issue_next(d,r,w)),Err(RetainedExecutionError::Stopped(ProgramStop::ResourceRefused(failure))) if failure.dimension==Dimension::Work)
        );
        assert_eq!(foreign.usage(), resource::Usage::default());
    });
}

#[test]
fn actual_pending_and_accepted_geometry_retain_original_resident_permit_until_owner_drop() {
    let original = account();
    with_case(Some(&original), SOURCE, |e, d, r, w, _, _| {
        let receipt = complete(e, d, r, w);
        let bytes = original.usage().live_bytes;
        let retained = receipt.realizations[0].clone();
        accept(e, receipt, d, r);
        assert!(original.usage().live_bytes >= bytes);
        let permit = std::mem::take(&mut e.permits);
        let ledger = std::mem::take(&mut e.ledger);
        drop((permit, ledger));
        let before_drop = original.usage().live_bytes;
        drop(retained);
        assert!(
            original.usage().live_bytes < before_drop,
            "sealed realization owns its resident permit"
        );
    });
}
#[test]
fn unaccounted_retained_handoff_excludes_later_cancelled_scope() {
    with_case(None, SOURCE, |e, d, r, w, _, _| {
        let foreign = account();
        foreign.cancel();
        foreign.scope(|| {
            let receipt = complete(e, d, r, w);
            accept(e, receipt, d, r);
            assert!(e.issue_next(d, r, w).unwrap().is_none());
            e.validate_witness().unwrap();
            assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled));
        });
        assert_eq!(foreign.usage(), resource::Usage::default());
    });
}

#[test]
fn actual_borrowed_source_resource_authority_precedes_stopped_worker_ambient() {
    let source_bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let context = ProductionModel::from_source(source_bundle).snapshot(Default::default());
    let mut decoder = context.source().unwrap().decoder();
    let original = account();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let transport = original.scope(resource::current_source_context);
    let source = work.source_borrow_scope_with_resources(transport);
    let captured = std::thread::scope(|threads| {
        threads
            .spawn(|| {
                let foreign = account();
                foreign.cancel();
                foreign.scope(|| {
                    let captured = super::super::session_canonical::with_source_resources(
                        &mut decoder,
                        |_| OwnedResourceContext::capture_current(),
                    );
                    captured.with_scope(|| {
                        resource::charge(Cost {
                            work: 1,
                            ..Cost::default()
                        })
                        .unwrap()
                    });
                    assert_eq!(foreign.usage(), resource::Usage::default());
                    assert_eq!(
                        resource::check_current(),
                        Err(ProgramStop::Cancelled),
                        "borrowed source scope restores the worker's unrelated first fault"
                    );
                    captured
                })
            })
            .join()
            .unwrap()
    });
    assert_eq!(
        original.usage().work,
        1,
        "actual source account, not worker ambient, admitted work"
    );
    drop(source);
    work.commit(decoder.execution_identity()).unwrap();
    assert_eq!(
        captured.check(),
        Ok(()),
        "resource-only ownership survives ended source work"
    );
    assert!(
        decoder.try_source_execution_lease().unwrap().is_none(),
        "no source execution authority escaped"
    );
}

#[test]
fn original_compatibility_terminal_is_checked_before_fresh_owner_work_epoch() {
    let source_bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let context = ProductionModel::from_source(source_bundle).snapshot(Default::default());
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let compatibility = ExecutionAccount::new(ExecutionPolicy::Compatibility);
    compatibility.scope(|| {
        resource::stop(ProgramStop::Cancelled);
        let metadata = metadata(10);
        let job = job(&entity, &metadata);
        let result =
            RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router);
        assert!(matches!(
            result,
            Err(RetainedExecutionError::Stopped(ProgramStop::Cancelled))
        ));
    });
    assert_eq!(resource::check_current(), Ok(()));
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
}

// #7955: the caller drops its pool account before the detached SDK work runs.
#[test]
fn original_pool_allowance_survives_caller_execution_and_witness_drop_in_order() {
    use resource::{ModelResourcePool, RequestAdmission};
    let Some(mut worker) = super::tests::worker() else {
        return;
    };
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let pool = ModelResourcePool::new(1_000_000);
    let limits = ResourceLimits {
        live_bytes: Some(1_000_000),
        ..Default::default()
    };
    let original = match pool.admit(limits).unwrap() {
        RequestAdmission::Ready(account) => account,
        RequestAdmission::WaitingForCapacity => panic!("fresh pool refused fixture"),
    };
    let mut execution = original.scope(|| {
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap()
    });
    let issued = execution
        .issue_next(&mut decoder, &router, &worker)
        .unwrap()
        .unwrap();
    drop(original);
    assert!(matches!(
        pool.admit(limits).unwrap(),
        RequestAdmission::WaitingForCapacity
    ));
    let receipt = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    accept(&mut execution, receipt, &mut decoder, &router);
    assert!(execution
        .issue_next(&mut decoder, &router, &worker)
        .unwrap()
        .is_none());
    let witness = execution.into_witness().unwrap();
    witness.validate().unwrap();
    assert_eq!(pool.resident_bytes(), 1_000_000);
    drop(witness);
    assert_eq!(pool.resident_bytes(), 0);
    assert!(matches!(
        pool.admit(limits).unwrap(),
        RequestAdmission::Ready(_)
    ));
}
