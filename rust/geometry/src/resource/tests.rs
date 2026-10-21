// SPDX-License-Identifier: MPL-2.0
use super::*;
fn bounded(limits: ResourceLimits) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(limits))
}
#[test]
fn zero_is_zero_and_refusal_is_sticky_without_refunding_prior_work() {
    let account = bounded(ResourceLimits {
        work: Some(2),
        copy_bytes: Some(0),
        ..ResourceLimits::default()
    });
    account.scope(|| {
        charge(Cost {
            work: 1,
            live_bytes: 8,
            ..Cost::default()
        })
        .unwrap()
        .retain();
        let error = charge(Cost {
            copy_bytes: 1,
            ..Cost::default()
        })
        .unwrap_err();
        assert_eq!(charge(Cost::default()).unwrap_err(), error);
    });
    assert_eq!(account.usage().work, 1);
    assert_eq!(account.usage().live_bytes, 8);
}
#[test]
fn live_drop_releases_only_live_and_nested_scope_cannot_reset_quota() {
    let outer = bounded(ResourceLimits {
        work: Some(1),
        ..ResourceLimits::default()
    });
    let inner = bounded(ResourceLimits::default());
    outer.scope(|| {
        let permit = charge(Cost {
            work: 1,
            live_bytes: 20,
            ..Cost::default()
        })
        .unwrap();
        assert_eq!(outer.usage().live_bytes, 20);
        drop(permit);
        inner.scope(|| {
            assert!(charge(Cost {
                work: 1,
                ..Cost::default()
            })
            .is_err())
        });
    });
    assert_eq!(outer.usage().work, 1);
    assert_eq!(outer.usage().live_bytes, 0);
    assert_eq!(inner.usage(), Usage::default());
}
#[test]
fn panic_restores_scope_and_drops_permit() {
    let account = bounded(ResourceLimits::default());
    assert!(std::panic::catch_unwind(|| account.scope(|| {
        let _permit = charge(Cost {
            live_bytes: 11,
            ..Cost::default()
        })
        .unwrap();
        panic!("test unwind invariant");
    }))
    .is_err());
    assert!(!is_active());
    assert_eq!(account.usage().live_bytes, 0);
}
#[test]
fn resident_wait_is_nonblocking_and_request_work_is_deterministic() {
    let pool = ModelResourcePool::new(10);
    let limits = ResourceLimits {
        live_bytes: Some(10),
        work: Some(2),
        ..ResourceLimits::default()
    };
    let RequestAdmission::Ready(account) = pool.admit(limits).unwrap() else {
        panic!("initial pool")
    };
    assert!(matches!(
        pool.admit(limits).unwrap(),
        RequestAdmission::WaitingForCapacity
    ));
    let permit = account
        .prepare(Cost {
            live_bytes: 10,
            work: 2,
            ..Cost::default()
        })
        .unwrap();
    drop(account);
    assert_eq!(pool.resident_bytes(), 10, "storage retains resident owner");
    drop(permit);
    assert_eq!(pool.resident_bytes(), 0);
    let RequestAdmission::Ready(next) = pool.admit(limits).unwrap() else {
        panic!("released capacity")
    };
    assert!(next
        .prepare(Cost {
            work: 2,
            ..Cost::default()
        })
        .is_ok());
    assert!(next
        .prepare(Cost {
            work: 1,
            ..Cost::default()
        })
        .is_err());
}
#[test]
fn cumulative_overflow_is_typed_and_cancellation_survives_catching_it() {
    let account = bounded(ResourceLimits::default());
    account
        .prepare(Cost {
            work: u64::MAX,
            ..Cost::default()
        })
        .unwrap();
    assert!(matches!(
        account.prepare(Cost {
            work: 1,
            ..Cost::default()
        }),
        Err(ProgramStop::ResourceRefused(ResourceFailure {
            reason: RefusalReason::Overflow,
            ..
        }))
    ));
    let cancelled = bounded(ResourceLimits::default());
    cancelled.scope(|| {
        cancelled.cancel();
        let _caught = charge(Cost::default());
    });
    assert_eq!(cancelled.check(), Err(ProgramStop::Cancelled));
}

#[test]
fn strict_coverage_refuses_before_any_opaque_callback() {
    let account = ExecutionAccount::new(ExecutionPolicy::Strict(ResourceLimits::default()));
    let invoked = std::cell::Cell::new(false);
    account.scope(|| {
        let result = check_current().map(|()| invoked.set(true));
        assert!(matches!(
            result,
            Err(ProgramStop::ResourceRefused(ResourceFailure {
                dimension: Dimension::Coverage,
                ..
            }))
        ));
    });
    assert!(!invoked.get());
}

#[test]
fn cross_thread_storage_owner_releases_global_quota_without_refunding_request_work() {
    let pool = ModelResourcePool::new(10);
    let RequestAdmission::Ready(account) = pool
        .admit(ResourceLimits {
            live_bytes: Some(10),
            work: Some(2),
            ..ResourceLimits::default()
        })
        .unwrap()
    else {
        panic!("initial request fits")
    };
    let child = account.clone();
    let permit = std::thread::spawn(move || {
        child.scope(|| {
            charge(Cost {
                live_bytes: 10,
                work: 2,
                ..Cost::default()
            })
            .unwrap()
        })
    })
    .join()
    .unwrap();
    assert_eq!(account.usage().work, 2);
    drop(account);
    assert_eq!(
        pool.resident_bytes(),
        10,
        "cross-thread payload owns the model allowance"
    );
    drop(permit);
    assert_eq!(
        pool.resident_bytes(),
        0,
        "last payload drop unblocks the next request"
    );
}

#[test]
fn issue_7914_terminal_consumer_scope_reports_stops_and_restores_after_unwind() {
    let result = with_terminal_scope(|| {
        assert!(!is_active(), "a terminal domain must not install a quota");
        let nested: Result<(), ProgramStop> = with_terminal_scope(|| {
            stop(ProgramStop::Cancelled);
            Ok(())
        });
        assert_eq!(nested, Err(ProgramStop::Cancelled));
        assert_eq!(check_current(), Err(ProgramStop::Cancelled));
        Ok(42)
    });
    assert_eq!(result, Err(ProgramStop::Cancelled));
    assert_eq!(check_current(), Ok(()));
    assert!(std::panic::catch_unwind(|| {
        let _: Result<(), ProgramStop> = with_terminal_scope(|| {
            stop(ProgramStop::Cancelled);
            panic!("test terminal scope unwind");
        });
    }).is_err());
    assert_eq!(with_terminal_scope(|| Ok(42)), Ok(42));
}
