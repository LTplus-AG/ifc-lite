// SPDX-License-Identifier: MPL-2.0
use super::*;
use ifc_lite_core::execution_owner::{AllocationAccount, AllocationClass, AllocationCost,
    AccountedArc, SourceResourceContext};

fn original(limit: u64) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(limit), ..Default::default()
    }))
}

#[test]
fn paired_projection_keeps_private_payload_and_raw_context_has_no_projection() {
    let account = original(4096);
    let inner = account.0.as_ref().unwrap();
    let context = account.source_context().unwrap();
    let recovered = context.downcast::<Inner>().unwrap();
    assert!(Arc::ptr_eq(inner, &recovered));
    let raw = SourceResourceContext::new(inner.clone());
    assert!(ExecutionAccount::from_source_context(&raw).is_some());
    assert!(AccountedArc::try_new(1u64, &raw, None).is_err());
    assert_eq!(account.usage(), Usage::default());
    let value = AccountedArc::try_new(1u64, &context, None).unwrap();
    assert!(account.usage().live_bytes > 0);
    drop(value);
    assert_eq!(account.usage().live_bytes, 0);
}

#[test]
fn direct_category_is_inside_legacy_allowance_and_refund_cannot_steal_reservation() {
    let account = original(32);
    let inner = account.0.as_ref().unwrap();
    let permit = account.prepare_inner(Cost { live_bytes: 20, ..Default::default() }).unwrap();
    inner.admit(AllocationCost { live: 12, ..Default::default() }).unwrap();
    assert_eq!(account.usage().live_bytes, 32);
    assert_eq!(account.allocation_usage(), (12, 0));
    // Invalid metadata refund must not release container or Reservation bytes.
    inner.refund(1, AllocationClass::Metadata);
    assert_eq!(account.usage().live_bytes, 32);
    assert_eq!(account.allocation_usage(), (12, 0));
    assert!(account.check().is_err());
    inner.refund(12, AllocationClass::Container); // cleanup survives terminal
    drop(permit);
    assert_eq!(account.usage().live_bytes, 0);
}

#[test]
fn direct_failed_live_admission_keeps_attempt_cost_but_legacy_prepare_does_not() {
    let account = original(16);
    let inner = account.0.as_ref().unwrap();
    inner.admit(AllocationCost { live: 16, ..Default::default() }).unwrap();
    let error = inner.admit(AllocationCost { live: 40, work: 3, copies: 16,
        ..Default::default() }).unwrap_err();
    assert!(matches!(error, ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::LiveBytes, requested: 40, remaining: 0, .. })));
    assert_eq!(account.usage().work, 3);
    assert_eq!(account.usage().copy_bytes, 16);
    assert_eq!(account.usage().peak_live_bytes, 16);
    assert_eq!(account.allocation_usage(), (16, 0));
    inner.refund(16, AllocationClass::Container);
    assert_eq!(account.usage().live_bytes, 0);

    let legacy = original(0);
    assert!(legacy.prepare_inner(Cost { work: 3, copy_bytes: 16, live_bytes: 40,
        ..Default::default() }).is_err());
    assert_eq!(legacy.usage(), Usage::default(), "legacy atomic admission policy is preserved");
}

#[test]
fn direct_cancellation_never_enters_or_poisons_foreign_tls_account() {
    let account = original(4096);
    let foreign = original(4096);
    account.cancel();
    foreign.scope(|| {
        assert_eq!(account.0.as_ref().unwrap().admit(AllocationCost { live: 8, work: 1,
            ..Default::default() }), Err(ProgramStop::Cancelled));
        assert_eq!(super::super::check_current(), Ok(()));
        assert_eq!(foreign.usage(), Usage::default());
    });
    assert_eq!(account.usage(), Usage::default());
}

#[test]
fn concurrent_metadata_drops_refund_same_atomic_category_and_total() {
    let account = original(65536);
    let context = account.source_context().unwrap();
    let values: Vec<_> = (0..32).map(|id| AccountedArc::try_new(id, &context, None).unwrap()).collect();
    let work = account.usage().work;
    assert_eq!(account.allocation_usage(), (0, account.usage().live_bytes));
    std::thread::scope(|threads| {
        for value in values { threads.spawn(move || drop(value)); }
    });
    assert_eq!(account.allocation_usage(), (0, 0));
    assert_eq!(account.usage().live_bytes, 0);
    assert_eq!(account.usage().work, work);
    assert_eq!(account.check(), Ok(()));
}

#[test]
fn metadata_payload_unwind_still_frees_standard_control_backing_in_actual_account() {
    struct PanicPayload;
    impl Drop for PanicPayload {
        fn drop(&mut self) { panic!("intentional metadata payload unwind"); }
    }
    let account = original(4096);
    let context = account.source_context().unwrap();
    let value = AccountedArc::try_new(PanicPayload, &context, None).unwrap();
    assert!(account.usage().live_bytes > 0);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(value)));
    assert!(result.is_err());
    assert_eq!(account.usage().live_bytes, 0);
    assert_eq!(account.allocation_usage(), (0, 0));
    assert_eq!(account.check(), Ok(()));
}
