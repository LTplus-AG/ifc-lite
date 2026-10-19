// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::resource::{self, Cost, Dimension, ExecutionPolicy, RefusalReason, ResourceFailure, ResourceLimits};
use ifc_lite_core::execution_owner::ExecutionOwner;

fn captured(account: Option<&ExecutionAccount>) -> OwnedResourceContext {
    let owner = ExecutionOwner::default();
    let mut lease = owner.try_lease().unwrap();
    let work = lease.begin_synchronous_work(owner.identity()).unwrap();
    let source = work.source_borrow_scope();
    resource::with_source_stop(source.resource_stop_handle(), || match account {
        Some(account) => account.scope(OwnedResourceContext::capture_current),
        None => OwnedResourceContext::capture_current(),
    })
}

#[test]
fn captured_cancelled_account_cannot_be_replaced_by_a_generous_later_scope() {
    let original = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let context = captured(Some(&original));
    original.cancel();
    let foreign = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    foreign.scope(|| {
        assert_eq!(context.with_scope(|| resource::charge(Cost { work: 1, ..Cost::default() })).unwrap_err(), ProgramStop::Cancelled);
        assert_eq!(foreign.usage().work, 0, "refusal must not charge the caller's unrelated account");
        resource::charge(Cost { work: 2, ..Cost::default() }).unwrap();
    });
    assert_eq!(foreign.usage().work, 2, "the ambient account is restored for actual later work");
    assert!(resource::current_account().is_none());
}

#[test]
fn originally_unaccounted_work_excludes_a_later_stopped_account_and_restores_it_on_panic() {
    let context = captured(None);
    let foreign = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { work: Some(0), ..ResourceLimits::default() }));
    foreign.scope(|| {
        let old = resource::charge(Cost { work: 1, ..Cost::default() }).unwrap_err();
        context.with_scope(|| resource::charge(Cost { work: 50, ..Cost::default() }).unwrap());
        assert_eq!(context.check(), Ok(()), "unrelated failure cannot poison captured unaccounted work");
        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| context.with_scope(|| {
            resource::stop(ProgramStop::Cancelled);
            panic!("deliberate resource-scope unwind");
        })));
        assert!(unwind.is_err());
        assert_eq!(resource::check_current(), Err(old), "ambient first fault survives captured-scope unwind");
        assert_eq!(context.check(), Err(ProgramStop::Cancelled));
    });
    assert!(resource::current_account().is_none());
}

#[test]
fn nested_actual_work_epoch_stop_is_retained_after_lexical_tls_restoration() {
    let context = captured(None);
    context.with_scope(|| {
        let owner = ExecutionOwner::default();
        let mut lease = owner.try_lease().unwrap();
        let work = lease.begin_synchronous_work(owner.identity()).unwrap();
        let source = work.source_borrow_scope();
        resource::with_source_stop(source.resource_stop_handle(), || {
            resource::stop(ProgramStop::Cancelled);
        });
    });
    assert_eq!(context.check(), Err(ProgramStop::Cancelled));
    assert_eq!(resource::check_current(), Ok(()), "owned first fault does not escape to ambient TLS");
}

#[test]
fn captured_source_chain_keeps_oldest_fault_after_work_expires_without_extending_a_lease() {
    let owner = ExecutionOwner::default();
    let mut root = owner.try_lease().unwrap();
    let work = root.begin_synchronous_work(owner.identity()).unwrap();
    let source = work.source_borrow_scope();
    let ancestor = source.resource_stop_handle();
    let mut child = work.child_capability().try_lease(owner.identity()).unwrap();
    let child_work = child.begin_synchronous_work(owner.identity()).unwrap();
    let child_source = child_work.source_borrow_scope();
    let context = resource::with_source_stop(child_source.resource_stop_handle(), OwnedResourceContext::capture_current);
    let failure = ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work,
        requested: 2, remaining: 1, reason: RefusalReason::Limit });
    ancestor.stop(failure);
    drop(child_source); drop(child_work); drop(source); drop(work);
    assert!(child.validate(owner.identity()).is_err(), "resource data never extends execution authority");
    assert_eq!(std::thread::scope(|scope| scope.spawn(|| context.check()).join().unwrap()), Err(failure));
    assert_eq!(context.with_scope(|| resource::stop(ProgramStop::Cancelled)), failure);
}

#[test]
fn retained_header_growth_is_admitted_before_allocation_in_original_account() {
    let original = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { live_bytes: Some(0), ..ResourceLimits::default() }));
    let context = captured(Some(&original));
    let foreign = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut values = Vec::<u64>::new();
    let failure = foreign.scope(|| context.reserve_headers(&mut values, 3).unwrap_err());
    assert!(matches!(failure, ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::LiveBytes, requested: 24, .. })));
    assert_eq!(values.capacity(), 0, "refused ledger growth allocates no backing");
    assert_eq!(foreign.usage().live_bytes, 0);
    assert_eq!(context.check(), Err(failure));
    let unaccounted = captured(None);
    unaccounted.reserve_headers(&mut values, 3).unwrap();
    assert!(values.capacity() >= 3, "unaccounted mode still preflights actual fallible growth");
}

#[test]
fn propagated_child_fault_is_first_in_every_ancestor_after_execution_expires() {
    for accounted in [false, true] {
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let owner = ExecutionOwner::default();
        let mut root = owner.try_lease().unwrap();
        let work = root.begin_synchronous_work(owner.identity()).unwrap();
        let source = work.source_borrow_scope();
        let ancestor = source.resource_stop_handle();
        let mut child = work.child_capability().try_lease(owner.identity()).unwrap();
        let child_work = child.begin_synchronous_work(owner.identity()).unwrap();
        let child_source = child_work.source_borrow_scope();
        let context = resource::with_source_stop(child_source.resource_stop_handle(), || {
            if accounted { account.scope(OwnedResourceContext::capture_current) }
            else { OwnedResourceContext::capture_current() }
        });
        assert_eq!(context.with_scope(|| resource::stop(ProgramStop::Cancelled)), ProgramStop::Cancelled);
        assert_eq!(context.check(), Err(ProgramStop::Cancelled));
        let failure = ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work,
            requested: 2, remaining: 1, reason: RefusalReason::Limit });
        // SourceStopHandle::stop propagates the child's first fault to every
        // ancestor. A later stop cannot manufacture a different ancestor fault.
        assert_eq!(ancestor.check(), Err(ProgramStop::Cancelled));
        assert_eq!(ancestor.stop(failure), ProgramStop::Cancelled);
        assert_eq!(context.check(), Err(ProgramStop::Cancelled));
        assert_eq!(context.with_scope(resource::check_current), Err(ProgramStop::Cancelled));
        if accounted {
            assert_eq!(account.check(), Err(ProgramStop::Cancelled), "account retains its own first fault");
        }
        drop(child_source); drop(child_work); drop(source); drop(work);
        assert!(child.validate(owner.identity()).is_err());
        assert_eq!(context.check(), Err(ProgramStop::Cancelled), "propagated first fault survives expired execution authority");
        assert_eq!(resource::check_current(), Ok(()), "captured stops do not escape into ambient TLS");
    }
}

#[test]
fn independent_account_cancellation_cannot_mask_actual_ancestor_source_fault() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let owner = ExecutionOwner::default();
    let mut root = owner.try_lease().unwrap();
    let work = root.begin_synchronous_work(owner.identity()).unwrap();
    let source = work.source_borrow_scope();
    let ancestor = source.resource_stop_handle();
    let mut child = work.child_capability().try_lease(owner.identity()).unwrap();
    let child_work = child.begin_synchronous_work(owner.identity()).unwrap();
    let child_source = child_work.source_borrow_scope();
    let context = resource::with_source_stop(child_source.resource_stop_handle(), ||
        account.scope(OwnedResourceContext::capture_current));
    // Cancel the account independently, before a captured check can propagate
    // that fault into the actual source chain. Both domains now have real,
    // distinct first faults; source ancestry must retain precedence.
    account.cancel();
    assert_eq!(account.check(), Err(ProgramStop::Cancelled));
    assert_eq!(ancestor.check(), Ok(()));
    let failure = ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work,
        requested: 2, remaining: 1, reason: RefusalReason::Limit });
    assert_eq!(ancestor.stop(failure), failure);
    assert_eq!(context.check(), Err(failure));
    assert_eq!(context.with_scope(resource::check_current), Err(failure));
    assert_eq!(account.check(), Err(ProgramStop::Cancelled), "account keeps its independent first fault");
    drop(child_source); drop(child_work); drop(source); drop(work);
    assert!(child.validate(owner.identity()).is_err());
    assert_eq!(context.check(), Err(failure));
    assert_eq!(resource::check_current(), Ok(()), "captured authority never escapes to ambient TLS");
}
