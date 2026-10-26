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

#[test]
fn issue_7955_c2_budget_resumption_excludes_foreign_terminal_and_restores_it() {
    let original = generous();
    let budget = original.scope(|| InspectionBudget::new(InspectionStart::now(), 2, 8, 10000));
    let foreign = generous();
    foreign.scope(|| {
        stop(ProgramStop::Cancelled);
        budget.scope(|| {
            let mut values = Vec::<u64>::new();
            let permit = reserve_headers(&mut values, 1).unwrap();
            values.push(29);
            assert_eq!(values[0], 29);
            drop((values, permit));
            assert!(reserve_headers(&mut Vec::<u64>::new(), 2).is_err());
        });
        assert_eq!(check_current(), Err(ProgramStop::Cancelled));
    });
    assert_eq!(foreign.usage(), Usage::default());
    assert_eq!(original.usage().work, 1);
    assert!(matches!(original.check(), Err(ProgramStop::ResourceRefused(_))));
}

#[test]
fn issue_7955_c2_later_actual_source_stop_still_precedes_account_under_entry_allowance() {
    use ifc_lite_core::execution_owner::ExecutionOwner;
    let original = generous();
    let budget = original.scope(|| InspectionBudget::new(InspectionStart::now(), 10, 64, 10000));
    let expected = ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::CopyBytes, requested: 31, remaining: 7, reason: RefusalReason::Limit,
    });
    let (observed, context) = budget.scope(|| {
        let owner = ExecutionOwner::default();
        let mut lease = owner.try_lease().unwrap();
        let work = lease.begin_synchronous_work(owner.identity()).unwrap();
        let source = work.source_borrow_scope();
        with_source_stop(source.resource_stop_handle(), || {
            let context = OwnedResourceContext::capture_current();
            source.resource_stop_handle().stop(expected);
            original.cancel();
            assert_eq!(original.check(), Err(ProgramStop::Cancelled));
            (charge(Cost { work: 1, ..Default::default() }).unwrap_err(), context)
        })
    });
    assert_eq!(observed, expected);
    let foreign = generous();
    foreign.scope(|| assert_eq!(context.check(), Err(expected)));
    assert!(foreign.check().is_ok());
    assert_eq!(foreign.usage(), Usage::default());
}

#[test]
fn issue_7955_deadline_reports_cancelled_publicly_and_records_cause_internally() {
    let original = generous();
    super::test_clock::scope(|clock| original.scope(|| {
        let budget = InspectionBudget::new(InspectionStart::now(), 100, 100, 10);
        budget.scope(|| {
            assert!(inspection_checkpoint().is_ok());
            assert!(!inspection_deadline_fired());
            clock.advance(10);
            // Public shape is the existing stop; the cause is internal.
            assert!(matches!(inspection_checkpoint(),
                Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
            assert!(inspection_deadline_fired());
            // An independently existing stop takes priority over the deadline.
            original.cancel();
            assert!(!inspection_deadline_fired());
        });
    }));
}

#[test]
fn issue_7955_user_cancel_is_not_a_deadline() {
    let original = generous();
    super::test_clock::scope(|_clock| original.scope(|| {
        let budget = InspectionBudget::new(InspectionStart::now(), 100, 100, 10000);
        budget.scope(|| {
            original.cancel();
            assert!(matches!(inspection_checkpoint(),
                Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
            assert!(!inspection_deadline_fired());
        });
    }));
}

#[test]
fn issue_7955_geometry_error_enum_has_no_deadline_variant() {
    // Exhaustive match: adding a variant (public API break) fails to compile.
    fn _exhaustive(error: crate::Error) {
        match error {
            crate::Error::ProgramStopped(_) | crate::Error::TriangulationError(_)
            | crate::Error::InvalidProfile(_) | crate::Error::InvalidExtrusion(_)
            | crate::Error::EmptyMesh(_) | crate::Error::GeometryError(_)
            | crate::Error::CoreError(_) => {}
        }
    }
}
