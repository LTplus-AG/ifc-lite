// SPDX-License-Identifier: MPL-2.0
//! #7955: the async common loop suspends around actual SDK execution.
use super::*;
use super::adversarial_tests::with_case;
use super::super::session_tests::SOURCE;
use super::runtime::{AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedExecutor};
use std::future::{poll_fn, Future};
use std::task::{Context, Poll, Waker};

// Only scheduling is deferred. Geometry and sealed receipts come from the real
// native SDK process; this tests common async policy, not the browser transport.
struct DeferredNative<'a>(&'a mut SmlibWorker);
impl RetainedRuntime for DeferredNative<'_> {
    type Receipt = RealizationKind;
    fn domain(&self) -> RuntimeOwner { self.0.retained_owner() }
    fn incarnation(&self) -> u64 { self.0.incarnation() }
}
impl AsyncRetainedExecutor for DeferredNative<'_> {
    async fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits, resources: &ifc_lite_geometry::resource::OwnedResourceContext)
        -> Result<Self::Receipt, RetainedExecutionError> {
        let mut suspended = false;
        poll_fn(|cx| {
            assert!(resource::current_account().is_none(), "no captured resource TLS may cross await");
            if suspended { Poll::Ready(()) } else {
                suspended = true;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        }).await;
        RetainedExecutor::invoke(self.0, call, limits, resources)
    }
}
fn limits() -> NumericalLimits {
    NumericalLimits { chord_metres: 0.001, angle_degrees: 15., max_bytes: MeshLimits::default().max_bytes }
}

#[test]
fn j4_async_sdk_receipt_uses_common_acceptance_and_restores_resource_scope() {
    let original = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    with_case(Some(&original), SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let mut deferred = DeferredNative(worker);
        let mut future = Box::pin(issued.execute_async(&mut deferred, limits()));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(future.as_mut().poll(&mut cx).is_pending());
        assert!(resource::current_account().is_none());
        let Poll::Ready(result) = future.as_mut().poll(&mut cx) else { panic!("SDK call must complete") };
        let completed = result.unwrap();
        drop(future);
        let actual = deferred.0.volume(completed.realizations()[0].solid(), 1e-8).unwrap();
        assert!((actual - 24.).abs() <= 1e-7, "authored 2 x 4 x 3 box: {actual}");
        execution.accept(completed, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert_eq!(execution.discharged_count(), 1);
        assert!(execution.issue_next(decoder, router, deferred.0).unwrap().is_none());
        execution.validate_witness().unwrap();
    });
}

#[test]
fn j4_async_drop_or_cancellation_cannot_publish_and_retires_captured_sdk_domain() {
    for cancel_then_resume in [false, true] {
        with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
            let other = super::tests::worker().unwrap();
            let owner = worker.retained_owner();
            let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
            let cancellation = issued.cancellation();
            let mut deferred = DeferredNative(worker);
            let mut future = Box::pin(issued.execute_async(&mut deferred, limits()));
            let mut cx = Context::from_waker(Waker::noop());
            assert!(future.as_mut().poll(&mut cx).is_pending());
            if cancel_then_resume {
                cancellation.cancel();
                let Poll::Ready(result) = future.as_mut().poll(&mut cx) else { panic!("cancelled call must settle") };
                let rejected = result.err().unwrap();
                assert!(rejected.issued.is_none(), "an executing packet is never retryable");
            }
            drop(future);
            assert!(owner.incarnation().is_none());
            assert!(other.retained_owner().incarnation().is_some());
            assert_eq!(execution.discharged_count(), 0);
            assert!(execution.traversal_plan().is_none());
            assert!(resource::current_account().is_none());
        });
    }
}

#[test]
fn j4_original_stop_after_await_refuses_delivery_and_retires_only_captured_domain() {
    // #7955: cancellation while suspended must be checked before sealing or delivery.
    let original = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    with_case(Some(&original), SOURCE, |execution, decoder, router, worker, _, _| {
        let other = super::tests::worker().unwrap();
        let owner = worker.retained_owner();
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let mut deferred = DeferredNative(worker);
        let mut future = Box::pin(issued.execute_async(&mut deferred, limits()));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(future.as_mut().poll(&mut cx).is_pending());
        original.cancel();
        let Poll::Ready(result) = future.as_mut().poll(&mut cx) else { panic!("SDK must settle") };
        let rejected = result.err().expect("original cancellation after await must refuse delivery");
        assert!(matches!(rejected.reason, RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
        assert!(rejected.issued.is_none(), "no retry after dispatch");
        drop(future);
        assert!(owner.incarnation().is_none());
        assert!(other.retained_owner().incarnation().is_some());
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.traversal_plan().is_none());
        assert!(resource::current_account().is_none());
    });
}

#[test]
fn j4_async_sdk_backing_uses_explicit_original_account() {
    // #7955 N1: suspension drops TLS; explicit authority must still charge buffers.
    let limit = 16 * 1024 * 1024;
    let original = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits {
        live_bytes: Some(limit), ..Default::default()
    }));
    with_case(Some(&original), SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let headers = CommonRetainedRealization::header_bytes()
            + std::mem::size_of::<Arc<CommonRetainedRealization>>() as u64;
        let _held = original.prepare(resource::Cost {
            live_bytes: limit - original.usage().live_bytes - headers, ..Default::default()
        }).unwrap();
        let mut deferred = DeferredNative(worker);
        let mut future = Box::pin(issued.execute_async(&mut deferred, limits()));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(future.as_mut().poll(&mut cx).is_pending());
        assert!(resource::current_account().is_none());
        let Poll::Ready(result) = future.as_mut().poll(&mut cx) else { panic!("SDK must settle") };
        let rejected = result.err().expect("N1_ASYNC_AUTHORITY: original account must refuse host backing after await");
        assert!(matches!(rejected.reason, RetainedExecutionError::Stopped(ProgramStop::ResourceRefused(_))),
            "N1_ASYNC_AUTHORITY: original refusal is preserved");
        drop(future);
        assert!(deferred.0.retained_owner().incarnation().is_none());
        assert_eq!(execution.discharged_count(), 0);
    });
}
