// SPDX-License-Identifier: MPL-2.0
//! Real-account witnesses callable from core's opted-in unit-test target.
use crate::resource::{self as resource, ExecutionAccount, ExecutionPolicy, ResourceLimits,
    ModelResourcePool, RequestAdmission, OwnedResourceContext, ProgramStop, Cost,
    Dimension, RefusalReason, ResourceFailure};
use ifc_lite_core::{SourceBundle, execution_owner::AccountedArc};

fn bounded() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { live_bytes: Some(65536),
        ..Default::default() }))
}
fn published(account: &ExecutionAccount) -> ifc_lite_core::execution_owner::SourceResourceContext {
    account.scope(resource::current_source_context).unwrap()
}

/// Actual standard Weak retains the original pool permit and metadata debit.
pub fn actual_metadata_weak_and_pool_witness() {
    let pool = ModelResourcePool::new(65536);
    let account = match pool.admit(ResourceLimits { live_bytes: Some(65536), ..Default::default() }).unwrap() {
        RequestAdmission::Ready(account) => account,
        RequestAdmission::WaitingForCapacity => panic!("empty pool refused its full allowance"),
    };
    let context = published(&account);
    let value = AccountedArc::try_new(17u64, &context, None).unwrap();
    let weak = value.downgrade();
    let before = account.usage();
    assert!(before.live_bytes > std::mem::size_of::<u64>() as u64);
    assert_eq!(account.allocation_usage(), (0, before.live_bytes));
    let alias = value.clone();
    let weak_alias = weak.clone();
    let upgraded = weak_alias.upgrade().unwrap();
    assert_eq!(account.usage(), before, "sharing must neither allocate nor charge");
    drop((alias, weak_alias, upgraded, value));
    assert!(weak.upgrade().is_none());
    assert_eq!(account.usage(), before, "Weak still owns the entire control allocation");
    drop(context);
    drop(account);
    assert_eq!(pool.resident_bytes(), 65536);
    // No source scope, account TLS, decoder or work survives final cleanup.
    std::thread::spawn(move || drop(weak)).join().unwrap();
    assert_eq!(pool.resident_bytes(), 0);
}

/// Direct observer forwards cancellation and source precedence without ambient TLS.
pub fn actual_owned_fault_witness() {
    for source_first in [false, true] {
        let account = bounded();
        let context = published(&account);
        let source = SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));".to_vec());
        let decoder = source.decoder();
        let mut lease = decoder.try_execution_lease().unwrap();
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let scope = work.source_borrow_scope_with_resources(Some(context.clone()));
        let stop = scope.resource_stop_handle();
        let owned = OwnedResourceContext::try_capture_accounted(&context, stop.clone()).unwrap();
        let observer = owned.allocation_observer().unwrap();
        let before = account.usage();
        assert!(before.live_bytes > 0);
        assert_eq!(account.allocation_usage(), (0, before.live_bytes));
        account.cancel();
        assert_eq!(account.check(), Err(ProgramStop::Cancelled));
        let fault = ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work,
            requested: 2, remaining: 1, reason: RefusalReason::Limit });
        let expected = if source_first { stop.stop(fault) } else { ProgramStop::Cancelled };
        let foreign = bounded();
        foreign.scope(|| {
            assert_eq!(observer.check(), Err(expected));
            assert_eq!(observer.record(fault), expected);
            assert_eq!(stop.check(), Err(expected));
            assert_eq!(owned.check(), Err(expected));
            assert_eq!(foreign.usage(), Default::default());
            assert_eq!(resource::check_current(), Ok(()));
        });
        assert_eq!(account.check(), Err(ProgramStop::Cancelled), "account keeps its independent first fault");
        drop(scope);
        drop(work);
        drop(lease);
        drop(decoder);
        drop(source);
        assert_eq!(observer.check(), Err(expected), "captured terminal outlives work without granting it");
        drop((owned, observer));
        assert_eq!(account.allocation_usage(), (0, 0));
        assert_eq!(account.usage().live_bytes, 0);
    }
}

/// Original private Inner downcast and joined source transport remain operational.
pub fn actual_joined_payload_witness() {
    let account = bounded();
    let context = published(&account);
    let source = SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));".to_vec());
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let scope = work.source_borrow_scope_with_resources(Some(context));
    std::thread::scope(|threads| {
        threads.spawn(|| {
            let child = decoder.try_source_execution_lease().unwrap().unwrap();
            let context = child.source_resource_context().unwrap().unwrap();
            let recovered = resource::account_from_source_context(&context).unwrap();
            // The public legacy operation still reaches exactly the original allowance.
            recovered.prepare(Cost { work: 7, ..Default::default() }).unwrap();
            let value = AccountedArc::try_new(29u64, &context, child.source_stop_handle().unwrap()).unwrap();
            assert_eq!(*value, 29);
            assert_eq!(recovered.usage(), account.usage());
            drop(value);
        }).join().unwrap();
    });
    assert!(account.usage().work >= 8);
    assert_eq!(account.usage().live_bytes, 0);
    drop(scope);
}

/// Metadata cannot allocate by silently selecting a generous ambient account.
pub fn actual_zero_metadata_witness() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { live_bytes: Some(0),
        ..Default::default() }));
    let context = published(&account);
    let foreign = bounded();
    foreign.scope(|| {
        let result = AccountedArc::try_new(11u64, &context, None);
        assert!(matches!(result, Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::LiveBytes && failure.reason == RefusalReason::Limit));
        assert_eq!(foreign.usage(), Default::default());
        assert_eq!(resource::check_current(), Ok(()));
    });
    assert_eq!(account.allocation_usage(), (0, 0));
    assert_eq!(account.usage().live_bytes, 0);
    assert!(account.usage().work > 0);
}

#[cfg(test)]
mod tests {
    #[test]
    fn actual_metadata_weak_and_pool() { super::actual_metadata_weak_and_pool_witness(); }
    #[test]
    fn actual_owned_fault() { super::actual_owned_fault_witness(); }
    #[test]
    fn actual_joined_payload() { super::actual_joined_payload_witness(); }
    #[test]
    fn actual_zero_metadata() { super::actual_zero_metadata_witness(); }
}
