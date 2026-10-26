// SPDX-License-Identifier: MPL-2.0
//! #7955: action and typed reporting are separate executable obligations.
use super::*;
use super::super::session_tests::{job, metadata, options, SOURCE};
use crate::retained_native_contract::Code;

#[test]
fn source_allocation_refusal_retains_its_typed_origin() {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = super::tests::router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut entity = decoder.decode_by_id(10).unwrap();
    // Identical attribute bytes with a foreign allocation cannot authenticate.
    entity.attributes = Arc::new(entity.attributes.as_ref().clone());
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let error = RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router)
        .err().expect("foreign allocation must refuse");
    assert!(matches!(error, RetainedExecutionError::Source(RetainedContextError::Mismatched)));
    assert_eq!(error.code(), Code::SourceMismatch);
}

#[test]
fn charged_storage_releases_with_the_vector_while_original_account_stays_alive() {
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    let resources = account.scope(OwnedResourceContext::capture_current);
    let mut storage = Storage::default();
    let mut buffer: Vec<u64> = Vec::new();
    storage.reserve(&resources, &mut buffer, 32).unwrap();
    buffer.extend(0..32);
    assert!(account.usage().live_bytes >= 32 * 8);
    let foreign = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    foreign.scope(|| drop((buffer, storage)));
    assert_eq!(account.usage().live_bytes, 0);
    assert_eq!(foreign.usage(), resource::Usage::default());
    assert_eq!(resources.check(), Ok(()));
}

#[test]
fn source_stop_survives_the_original_scope_and_foreign_ambient_account() {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = super::tests::router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    let mut execution = account.scope(|| RetainedProductExecution::begin(
        &job, &context, &options(), &mut decoder, &router)).unwrap();
    let stop = ProgramStop::ResourceRefused(resource::ResourceFailure {
        dimension: resource::Dimension::Work, requested: 9, remaining: 2,
        reason: resource::RefusalReason::Limit,
    });
    execution.resources.with_scope(|| { resource::stop(stop); });
    let foreign = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    for ambient in [false, true] {
        let check = || execution.validate(&decoder, &router);
        let error = if ambient { foreign.scope(check) } else { check() }.unwrap_err();
        assert!(matches!(error, RetainedExecutionError::Stopped(actual) if actual == stop));
        assert_eq!(error.code(), Code::ResourceExhausted);
    }
    execution.cancel();
    assert!(execution.traversal_plan().is_none());
    assert_eq!(foreign.usage(), resource::Usage::default());
}

#[test]
fn source_admission_report_is_independent_of_the_refusal_action() {
    super::adversarial_tests::with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let work = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        let address = Arc::as_ptr(&work.realizations[0]);
        let pending = execution.pending.as_mut().unwrap();
        let PendingRetainedOperation::Construction { request, .. } = &mut pending.operations[0]
            else { panic!("source construction") };
        let RetainedRecipe::Extrusion(recipe) = request.recipe() else { panic!("extrusion") };
        let mut document = GeometryDocument::new();
        let definition = document.add_retained_extrusion(recipe.clone()).unwrap();
        *request = document.prepare_retained(definition, worker.incarnation()).unwrap();
        let rejected = execution.accept(work, decoder, router).expect_err("admission mismatch");
        assert!(matches!(rejected.reason, RetainedExecutionError::Receipt(ReceiptFailure::ForeignSourceAdmission)));
        assert_eq!(rejected.reason.code(), Code::ReceiptInvalid);
        assert_eq!(address, Arc::as_ptr(&rejected.work.realizations[0]));
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.pending.is_some());
    });
}

#[test]
fn reached_construction_backing_is_admitted_before_clone_and_owned_until_last_reference() {
    use ifc_lite_geometry::{analytic, document::RetainedExtrusion};
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let _router = super::tests::router(&mut decoder);
    let solid = decoder.decode_by_id(13).unwrap();
    let recipe = RetainedRecipe::Extrusion(RetainedExtrusion {
        source: analytic::with_source_capture(|| analytic::extract_analytic_extrusion(&solid, &mut decoder)),
        length_unit_scale: 1.,
    });
    let denied = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits {
        live_bytes: Some(0), ..Default::default()
    }));
    let resources = denied.scope(OwnedResourceContext::capture_current);
    let error = construction_storage::reserve(&resources, &recipe).err().expect("zero backing refuses");
    assert!(matches!(error, RetainedExecutionError::Stopped(ProgramStop::ResourceRefused(failure))
        if failure.dimension == resource::Dimension::LiveBytes));
    assert_eq!(denied.usage().live_bytes, 0);
    let original = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    let resources = original.scope(OwnedResourceContext::capture_current);
    let backing = construction_storage::reserve(&resources, &recipe).unwrap();
    let retained = backing.clone();
    let live = original.usage().live_bytes;
    assert!(live > 4096, "actual reached profile/source storage counted");
    drop(backing);
    assert_eq!(original.usage().live_bytes, live);
    drop(retained);
    assert_eq!(original.usage().live_bytes, 0);
}

#[test]
fn batch_length_and_stage_tampering_leave_the_original_reply_unconsumed() {
    super::adversarial_tests::with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let mut work = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        let actual = work.realizations.pop().unwrap();
        let mut rejected = execution.accept(work, decoder, router).expect_err("short batch");
        assert!(matches!(rejected.reason, RetainedExecutionError::Receipt(ReceiptFailure::RetainedBatchLengthMismatch)));
        assert_eq!(execution.discharged_count(), 0);
        rejected.work.realizations.push(actual);
        rejected.work.cancellation.stage.store(ISSUED, Ordering::Release);
        let rejected = execution.accept(rejected.work, decoder, router).expect_err("wrong stage");
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.pending.is_some());
        rejected.work.cancellation.stage.store(DELIVERED, Ordering::Release);
        execution.accept(rejected.work, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert_eq!(execution.discharged_count(), 1);
    });
}

#[test]
fn dead_original_worker_precedes_caller_fault_and_never_returns_a_retry_packet() {
    super::adversarial_tests::with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        worker.retained_owner().retire();
        let rejected = issued.execute(worker, f64::NAN, -1., MeshLimits { max_bytes: 0 }).err().unwrap();
        assert!(matches!(rejected.reason, RetainedExecutionError::DomainRetired));
        assert_eq!(rejected.reason.code(), Code::WorkerRetired);
        assert!(rejected.issued.is_none());
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.issue_next(decoder, router, worker).is_err());
        assert!(execution.failed);
    });
}

#[test]
fn issue_7955_m3_conflicting_outcome_poisons_only_its_domain_and_preserves_rejected_buffers() {
    super::adversarial_tests::with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let foreign = super::tests::worker().expect("real foreign SDK worker");
        let owner = worker.retained_owner();
        let foreign_owner = foreign.retained_owner();
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let work = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        let buffer = work.realizations[0].construction().unwrap().completion().tessellation.positions.as_ptr();
        let receipt = Arc::as_ptr(&work.realizations[0]);
        assert!(!work.realizations[0].is_empty(), "real constructed box is nonempty");
        execution.pending.as_ref().unwrap().operations[0].expected()
            .bind_numerical_outcome(true).unwrap();
        let rejected = execution.accept(work, decoder, router).expect_err("conflicting write-once outcome");
        assert!(matches!(rejected.reason,
            RetainedExecutionError::Receipt(ReceiptFailure::ConflictingRetainedNumericalOutcome)));
        assert_eq!(rejected.reason.code(), Code::ReceiptInvalid, "M3_CONFLICT_REPORT");
        assert!(execution.failed, "M3_CONFLICT_MUST_POISON_ATTEMPT");
        assert_eq!(execution.pending.as_ref().unwrap().cancellation.stage.load(Ordering::Acquire), CANCELLED);
        assert!(owner.incarnation().is_none());
        assert!(foreign_owner.incarnation().is_some());
        assert_eq!(receipt, Arc::as_ptr(&rejected.work.realizations[0]));
        assert_eq!(buffer, rejected.work.realizations[0].construction().unwrap().completion().tessellation.positions.as_ptr());
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.issue_next(decoder, router, worker).is_err());
        assert!(execution.validate_witness().is_err());
        let rejected_again = execution.accept(rejected.work, decoder, router).expect_err("poisoned attempt cannot retry");
        assert_eq!(buffer, rejected_again.work.realizations[0].construction().unwrap().completion().tessellation.positions.as_ptr());
        assert!(execution.traversal_plan().is_none());
        assert!(foreign_owner.incarnation().is_some());
    });
}
