// SPDX-License-Identifier: MPL-2.0
//! #7955: local admission survives capture/transport, without foreign billing.
use super::*;
use crate::resource::OwnedResourceContext;
fn generous() -> ExecutionAccount { ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default())) }

#[test]
fn issue_7955_c2_captured_allowance_refuses_before_actual_backing_growth() {
    let original = generous();
    let context = original.scope(|| {
        let budget = InspectionBudget::new(InspectionStart::now(), 100, 8, 10000);
        budget.scope(OwnedResourceContext::capture_current)
    });
    let foreign = generous();
    let mut values = Vec::<u64>::new();
    foreign.scope(|| {
        let error = context.reserve_headers(&mut values, 2).unwrap_err();
        assert_eq!(error, ProgramStop::ResourceRefused(ResourceFailure {
            dimension: Dimension::LiveBytes, requested: 16, remaining: 8, reason: RefusalReason::Limit,
        }));
        assert_eq!(values.capacity(), 0);
        assert_eq!(context.check(), Err(error));
        assert!(check_current().is_ok());
    });
    assert_eq!(foreign.usage(), Usage::default());
    assert_eq!(original.usage().peak_live_bytes, 0);
}

#[test]
fn issue_7955_c2_source_transport_keeps_local_limit_and_original_work() {
    let original = generous();
    let captured = original.scope(|| {
        charge(Cost { work: 11, ..Default::default() }).unwrap();
        let budget = InspectionBudget::new(InspectionStart::now(), 2, 64, 10000);
        budget.scope(|| current_source_context().unwrap())
    });
    let original = original.clone();
    std::thread::scope(|scope| scope.spawn(|| {
        let foreign = generous();
        foreign.scope(|| detached(|| {
            let recovered = account_from_source_context(&captured).unwrap();
            recovered.source_scope(|| {
                let mut values = Vec::<u64>::new();
                let permit = reserve_headers(&mut values, 2).unwrap();
                values.extend([13, 17]);
                assert_eq!(values.iter().sum::<u64>(), 30);
                assert!(matches!(charge(Cost { work: 1, ..Default::default() }),
                    Err(ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work, remaining: 0, .. }))));
                drop((values, permit));
            });
        }));
        assert!(foreign.check().is_ok());
        assert_eq!(foreign.usage(), Usage::default());
    }).join().unwrap());
    assert_eq!(original.usage().work, 13);
    assert_eq!(original.usage().live_bytes, 0);
}

#[test]
fn issue_7955_c2_detached_work_cannot_consume_or_stop_waiting_allowance() {
    let original = generous();
    original.scope(|| {
        let budget = InspectionBudget::new(InspectionStart::now(), 1, 8, 10000);
        budget.scope(|| {
            detached(|| {
                charge(Cost { work: 100, ..Default::default() }).unwrap();
                stop(ProgramStop::Cancelled);
            });
            let mut values = Vec::<u64>::new();
            let permit = reserve_headers(&mut values, 1).unwrap();
            values.push(19);
            assert_eq!(values[0], 19);
            drop((values, permit));
        });
    });
    assert!(original.check().is_ok());
    assert_eq!(original.usage().work, 1);
    assert_eq!(original.usage().live_bytes, 0);
}
