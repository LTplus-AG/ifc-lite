// SPDX-License-Identifier: MPL-2.0
//! Actual source + native SDK handoff under captured resource ownership.
//! SDK cases require IFCLITE_SMLIB_WORKER and remain unqualified until executed.
use super::*;
use super::tests::{context, execution, worker};
use super::super::session_tests::{job, metadata, options, router};
use ifc_lite_geometry::resource::{self, Cost, Dimension, ExecutionAccount, ExecutionPolicy, ResourceFailure, ResourceLimits};
use ifc_lite_geometry_runtime::MeshLimits;

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}
#[test]
fn retained_constructor_refuses_original_zero_work_before_source_root_is_planned() {
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { work: Some(0), ..ResourceLimits::default() }));
    let result = account.scope(|| RetainedProductExecution::new(&job(&entity, &metadata(10)),
        &context, &options(), &mut decoder, &router));
    assert!(matches!(result, Err(RetainedExecutionError::Stopped(ProgramStop::ResourceRefused(
        ResourceFailure { dimension: Dimension::Work, .. })))));
    assert_eq!(account.usage().work, 0);
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
    assert!(resource::current_account().is_none());
}

#[test]
fn original_account_cancelled_after_issue_refuses_sdk_execution_outside_scope() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let account = account();
    let mut execution = account.scope(|| execution(&context, &mut decoder, &router));
    let issued = execution.issue_next(&worker, &mut decoder, &router).unwrap().unwrap();
    let work_before = account.usage().work;
    account.cancel();
    assert!(matches!(issued.execute(&mut worker, 0.001, 15., MeshLimits::default()),
        Err(RetainedExecutionError::Stopped(ProgramStop::Cancelled))));
    assert_eq!(account.usage().work, work_before, "cancelled original account admits no SDK work unit");
    assert_eq!(execution.discharged_count(), 0);
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    assert_eq!(worker.incarnation(), 0, "terminal execution retires its captured owner");
}

#[test]
fn original_cancellation_before_accept_wins_over_absent_or_foreign_ambient_account() {
    for foreign_scope in [false, true] {
        let Some(mut worker) = worker() else { return };
        let (_, context) = context();
        let mut decoder = context.source().unwrap().decoder();
        let router = router(&mut decoder);
        let original = account();
        let mut execution = original.scope(|| execution(&context, &mut decoder, &router));
        let issued = execution.issue_next(&worker, &mut decoder, &router).unwrap().unwrap();
        let receipt = issued.execute(&mut worker, 0.001, 15., MeshLimits::default()).unwrap();
        assert!((worker.volume(receipt.realization().expect("construction result").solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
        original.cancel();
        let foreign = account();
        let rejected = if foreign_scope {
            foreign.scope(|| execution.accept(receipt, &mut decoder, &router)).unwrap_err()
        } else { execution.accept(receipt, &mut decoder, &router).unwrap_err() };
        assert!(matches!(rejected.reason, RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.pending.as_ref().unwrap().reply.is_some(), "no original engine reply consumed");
        assert!(rejected.work.realization().expect("construction result").validate_live().is_ok(), "intact rejection still owns actual geometry");
        assert_eq!(foreign.usage(), resource::Usage::default());
        foreign.scope(|| resource::charge(Cost { work: 1, ..Cost::default() }).unwrap());
        assert_eq!(foreign.usage().work, 1, "ambient authority restored after rejection");
    }
}

#[test]
fn unaccounted_retained_handoff_excludes_later_cancelled_scope_and_keeps_actual_geometry() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, &mut decoder, &router);
    let foreign = account(); foreign.cancel();
    foreign.scope(|| {
        let issued = execution.issue_next(&worker, &mut decoder, &router).unwrap().unwrap();
        let receipt = issued.execute(&mut worker, 0.001, 15., MeshLimits::default()).unwrap();
        assert!((worker.volume(receipt.realization().expect("construction result").solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
        execution.accept(receipt, &mut decoder, &router).unwrap();
        assert!(execution.issue_next(&worker, &mut decoder, &router).unwrap().is_none());
        assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled));
    });
    assert_eq!(foreign.usage(), resource::Usage::default());
    assert_eq!(execution.discharged_count(), 1);
    assert!(execution.traversal_plan().is_some());
    assert!(resource::current_account().is_none());
}

#[test]
fn actual_sealed_acceptance_charges_ledger_backing_to_original_account_after_caller_drop() {
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let original = account();
    let mut execution = original.scope(|| execution(&context, &mut decoder, &router));
    let issued = execution.issue_next(&worker, &mut decoder, &router).unwrap().unwrap();
    let receipt = issued.execute(&mut worker, 0.001, 15., MeshLimits::default()).unwrap();
    let before = original.usage();
    let observer = original.clone(); drop(original);
    let foreign = account();
    foreign.scope(|| execution.accept(receipt, &mut decoder, &router)).unwrap();
    assert!(observer.usage().live_bytes >= before.live_bytes + std::mem::size_of::<DischargedValue>() as u64);
    assert!(observer.usage().work > before.work);
    assert_eq!(foreign.usage(), resource::Usage::default());
    assert_eq!(execution.discharged_count(), 1);
}

#[test]
fn original_reached_work_allowance_refuses_issue_under_a_fresh_foreign_account() {
    let Some(worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let original = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(1), ..ResourceLimits::default()
    }));
    let mut execution = original.scope(|| execution(&context, &mut decoder, &router));
    assert_eq!(original.usage().work, 1, "root admission consumed the only allowed work unit");
    let foreign = account();
    let result = foreign.scope(|| execution.issue_next(&worker, &mut decoder, &router));
    assert!(matches!(result, Err(RetainedExecutionError::Stopped(ProgramStop::ResourceRefused(
        ResourceFailure { dimension: Dimension::Work, .. })))));
    assert!(execution.pending.is_none(), "a stopped reached admission cannot escape as SDK work");
    assert_eq!(execution.discharged_count(), 0);
    assert_eq!(foreign.usage(), resource::Usage::default());
    assert_ne!(worker.incarnation(), 0, "no issued operation acquired retirement authority");
}

#[test]
fn actual_borrowed_source_resource_authority_precedes_stopped_worker_ambient() {
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let original = account();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let transport = original.scope(resource::current_source_context);
    let source = work.source_borrow_scope_with_resources(transport);
    let captured = std::thread::scope(|threads| threads.spawn(|| {
        let foreign = account(); foreign.cancel();
        foreign.scope(|| {
            let captured = super::super::session_canonical::with_source_resources(&mut decoder,
                |_| OwnedResourceContext::capture_current());
            captured.with_scope(|| resource::charge(Cost { work: 1, ..Cost::default() }).unwrap());
            assert_eq!(foreign.usage(), resource::Usage::default());
            assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled),
                "borrowed source scope restores the worker's unrelated first fault");
            captured
        })
    }).join().unwrap());
    assert_eq!(original.usage().work, 1, "actual source account, not worker ambient, admitted work");
    drop(source);
    work.commit(decoder.execution_identity()).unwrap();
    assert_eq!(captured.check(), Ok(()), "resource-only ownership survives ended source work");
    assert!(decoder.try_source_execution_lease().unwrap().is_none(), "no source execution authority escaped");
}

#[test]
fn original_compatibility_terminal_is_checked_before_fresh_owner_work_epoch() {
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let compatibility = ExecutionAccount::new(ExecutionPolicy::Compatibility);
    compatibility.scope(|| {
        resource::stop(ProgramStop::Cancelled);
        let result = RetainedProductExecution::new(&job(&entity, &metadata(10)),
            &context, &options(), &mut decoder, &router);
        assert!(matches!(result, Err(RetainedExecutionError::Stopped(ProgramStop::Cancelled))));
    });
    assert_eq!(resource::check_current(), Ok(()));
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
}

#[test]
fn actual_pending_and_accepted_geometry_retain_original_resident_permit_until_owner_drop() {
    use ifc_lite_geometry::resource::{ModelResourcePool, RequestAdmission};
    let Some(mut worker) = worker() else { return };
    let (_, context) = context();
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let pool = ModelResourcePool::new(1_000_000);
    let limits = ResourceLimits { live_bytes: Some(1_000_000), ..ResourceLimits::default() };
    let original = match pool.admit(limits).unwrap() {
        RequestAdmission::Ready(account) => account,
        RequestAdmission::WaitingForCapacity => panic!("fresh pool must admit retained fixture"),
    };
    let mut execution = original.scope(|| execution(&context, &mut decoder, &router));
    let issued = execution.issue_next(&worker, &mut decoder, &router).unwrap().unwrap();
    drop(original);
    assert!(matches!(pool.admit(limits).unwrap(), RequestAdmission::WaitingForCapacity));
    let receipt = issued.execute(&mut worker, 0.001, 15., MeshLimits::default()).unwrap();
    assert!((worker.volume(receipt.realization().expect("construction result").solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
    execution.accept(receipt, &mut decoder, &router).unwrap();
    assert_eq!(pool.resident_bytes(), 1_000_000, "accepted ledger still owns the request permit");
    drop(execution);
    assert_eq!(pool.resident_bytes(), 0, "last owned account releases the entire resident allowance");
    assert!(matches!(pool.admit(limits).unwrap(), RequestAdmission::Ready(_)));
}
