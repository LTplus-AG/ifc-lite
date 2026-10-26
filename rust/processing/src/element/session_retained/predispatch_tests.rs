// SPDX-License-Identifier: MPL-2.0
//! #7955: caller corrections preserve one actual armed SDK admission.
use super::*;
use super::adversarial_tests::with_case;
use super::super::session_tests::SOURCE;

#[test]
fn h2b_invalid_limits_return_the_same_armed_packet_for_corrected_retry() {
    with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let stage = issued.cancellation.stage.clone();
        let rejected = issued.execute(worker, f64::NAN, 15., MeshLimits::default()).err().unwrap();
        let returned = rejected.issued.expect("live caller fault returns the packet");
        assert!(Arc::ptr_eq(&stage, &returned.cancellation.stage));
        assert_eq!(stage.load(Ordering::Acquire), ISSUED);
        assert!(worker.retained_owner().incarnation().is_some());
        let receipt = returned.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        assert!(!receipt.realizations()[0].construction().unwrap().completion().tessellation.indices.is_empty());
        execution.accept(receipt, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert!(execution.issue_next(decoder, router, worker).unwrap().is_none());
        execution.validate_witness().unwrap();
    });
}

#[test]
fn h2b_foreign_worker_rejection_preserves_both_workers_and_original_admission() {
    with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let mut foreign = super::tests::worker().unwrap();
        let foreign_owner = foreign.retained_owner();
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let stage = issued.cancellation.stage.clone();
        let rejected = issued.execute(&mut foreign, 0.001, 15., MeshLimits::default()).err().unwrap();
        let returned = rejected.issued.unwrap();
        assert!(Arc::ptr_eq(&stage, &returned.cancellation.stage));
        assert!(foreign_owner.incarnation().is_some());
        assert!(worker.retained_owner().incarnation().is_some());
        let receipt = returned.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        execution.accept(receipt, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert_eq!(execution.discharged_count(), 1);
        assert!(foreign_owner.incarnation().is_some());
    });
}

#[test]
fn h2b_abandoning_returned_packet_retires_only_its_captured_domain() {
    with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let foreign = super::tests::worker().unwrap();
        let foreign_owner = foreign.retained_owner();
        let owner = worker.retained_owner();
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let rejected = issued.execute(worker, 0., 15., MeshLimits::default()).err().unwrap();
        assert!(rejected.issued.is_some());
        drop(rejected);
        assert!(owner.incarnation().is_none());
        assert!(foreign_owner.incarnation().is_some());
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.traversal_plan().is_none());
    });
}

#[test]
fn h2b_terminal_resource_fault_precedes_invalid_limits_and_foreign_worker() {
    let original = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    with_case(Some(&original), SOURCE, |execution, decoder, router, worker, _, _| {
        let mut foreign = super::tests::worker().unwrap();
        let foreign_owner = foreign.retained_owner();
        let owner = worker.retained_owner();
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        original.cancel();
        let rejected = issued.execute(&mut foreign, f64::NAN, -1., MeshLimits { max_bytes: 0 }).err().unwrap();
        assert!(matches!(rejected.reason, RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
        assert!(rejected.issued.is_none());
        assert!(owner.incarnation().is_none());
        assert!(foreign_owner.incarnation().is_some());
        assert_eq!(execution.discharged_count(), 0);
    });
}

#[test]
fn h2b_expired_source_precedes_invalid_limits_without_a_recoverable_packet() {
    with_case(None, SOURCE, |execution, decoder, router, worker, model, _| {
        let owner = worker.retained_owner();
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        model.invalidate_source();
        let rejected = issued.execute(worker, f64::NAN, 15., MeshLimits::default()).err().unwrap();
        assert!(matches!(rejected.reason, RetainedExecutionError::Source(_)));
        assert!(rejected.issued.is_none());
        assert!(owner.incarnation().is_none());
        assert_eq!(execution.discharged_count(), 0);
    });
}
