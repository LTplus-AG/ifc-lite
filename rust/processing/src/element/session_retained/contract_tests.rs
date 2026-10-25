// SPDX-License-Identifier: MPL-2.0
//! #7955: action and typed reporting are separate executable obligations.
use super::*;
use super::super::session_tests::{job, metadata, options, SOURCE};
use crate::retained_inspection_contract::Code;

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
