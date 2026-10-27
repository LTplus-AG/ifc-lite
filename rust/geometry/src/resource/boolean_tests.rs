// SPDX-License-Identifier: MPL-2.0
//! #7914: boolean polling preserves typed, durable authority semantics.
use super::*;
use ifc_lite_core::{execution_owner::SourceStopHandle, EntityDecoder};

fn with_handle(run: impl FnOnce(SourceStopHandle)) {
    let decoder = EntityDecoder::new("#1=IFCWALL();\n");
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let scope = work.source_borrow_scope();
    run(scope.resource_stop_handle());
}

fn bounded(work: Option<u64>) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work,
        ..ResourceLimits::default()
    }))
}

fn refusal() -> ProgramStop {
    ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::Representation,
        requested: u64::MAX,
        remaining: 0,
        reason: RefusalReason::Overflow,
    })
}

#[test]
fn issue_7914_boolean_poll_observes_late_terminal_without_authorities() {
    let result = with_terminal_scope(|| {
        assert!(!is_active());
        assert!(!is_stopped());
        assert_eq!(stop(refusal()), refusal());
        assert!(is_stopped());
        assert_eq!(check_current(), Err(refusal()));
        Ok(())
    });
    assert_eq!(result, Err(refusal()));
    assert!(!is_stopped());
}

#[test]
fn issue_7914_boolean_poll_source_refusal_precedes_pending_account_cancel() {
    let account = bounded(None);
    with_handle(|handle| {
        with_source_stop(handle.clone(), || {
            account.source_scope(|| {
                assert!(!is_stopped());
                handle.stop(refusal());
                account.cancel();
                assert!(is_stopped());
                // Account-first polling would latch cancellation even if the
                // returned value and later source reconciliation look correct.
                assert_eq!(account.check(), Err(refusal()));
                assert_eq!(handle.check(), Err(refusal()));
                assert_eq!(check_current(), Err(refusal()));
            });
        });
    });
    assert_eq!(account.check(), Err(refusal()));
    assert!(!is_stopped());
}

#[test]
fn issue_7914_boolean_account_poll_reconciles_into_surviving_terminal_domain() {
    let account = bounded(None);
    let result = with_terminal_scope(|| {
        account.scope(|| {
            assert!(!is_stopped());
            account.cancel();
            assert!(is_stopped());
            // No typed observation or source_scope exit may repair the state
            // before the independent terminal-only observation below.
        });
        assert!(!is_active());
        assert!(
            is_stopped(),
            "boolean polling must durably reconcile the stop"
        );
        assert_eq!(check_current(), Err(ProgramStop::Cancelled));
        Ok(())
    });
    assert_eq!(result, Err(ProgramStop::Cancelled));
    assert!(!is_stopped());
}

#[test]
fn issue_7914_boolean_poll_reconciles_account_refusal_into_healthy_source() {
    let account = bounded(None);
    with_handle(|handle| {
        with_source_stop(handle.clone(), || {
            account.source_scope(|| {
                assert!(!is_stopped());
                assert_eq!(handle.check(), Ok(()));
                account.stop(refusal());
                assert!(is_stopped());
                // Inspect before typed polling or source_scope exit can repair
                // an omitted final source reconciliation.
                assert_eq!(handle.check(), Err(refusal()));
                assert_eq!(check_current(), Err(refusal()));
            });
        });
    });
    assert!(!is_stopped());
}

#[test]
fn issue_7914_boolean_nested_authorities_restore_on_return_and_unwind() {
    for unwind in [false, true] {
        let outer = bounded(Some(1));
        let inner = bounded(None);
        with_handle(|outer_handle| {
            with_source_stop(outer_handle.clone(), || {
                outer.source_scope(|| {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        with_handle(|inner_handle| {
                            with_source_stop(inner_handle.clone(), || {
                                inner.source_scope(|| {
                                    assert!(!is_stopped());
                                    inner.cancel();
                                    assert!(is_stopped());
                                    assert_eq!(inner_handle.check(), Err(ProgramStop::Cancelled));
                                    if unwind {
                                        panic!("test boolean authority restoration");
                                    }
                                });
                            });
                        });
                    }));
                    assert_eq!(result.is_err(), unwind);
                    assert!(!is_stopped());
                    assert_eq!(outer_handle.check(), Ok(()));
                    charge(Cost {
                        work: 1,
                        ..Cost::default()
                    })
                    .unwrap()
                    .retain();
                    assert_eq!(outer.usage().work, 1);
                    assert_eq!(inner.check(), Err(ProgramStop::Cancelled));
                    outer_handle.stop(refusal());
                    assert!(is_stopped());
                    assert_eq!(outer.check(), Err(refusal()));
                });
            });
        });
        assert!(!is_stopped());
    }
}

#[test]
fn issue_7914_boolean_source_override_restores_refused_ambient_terminal() {
    for unwind in [false, true] {
        let result = with_terminal_scope(|| {
            stop(refusal());
            let actual = bounded(None);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                with_handle(|handle| {
                    with_source_stop(handle.clone(), || {
                        actual.source_scope(|| {
                            assert!(!is_stopped());
                            actual.cancel();
                            assert!(is_stopped());
                            assert_eq!(handle.check(), Err(ProgramStop::Cancelled));
                            if unwind {
                                panic!("test boolean terminal restoration");
                            }
                        });
                    });
                });
            }));
            assert_eq!(result.is_err(), unwind);
            assert!(!is_active());
            assert!(is_stopped());
            assert_eq!(check_current(), Err(refusal()));
            Ok(())
        });
        assert_eq!(result, Err(refusal()));
        assert!(!is_stopped());
    }
}

#[test]
fn issue_7914_fresh_empty_poll_observes_later_source_installation() {
    with_handle(|handle| {
        let result = with_terminal_scope(|| {
            assert!(!is_active());
            assert!(
                !is_stopped(),
                "healthy empty domain before source installation"
            );
            with_source_stop(handle.clone(), || {
                assert!(!is_stopped(), "new source starts healthy");
                handle.stop(refusal());
                assert!(
                    is_stopped(),
                    "fresh source presence must defeat cached absence"
                );
                assert_eq!(handle.check(), Err(refusal()));
            });
            Ok(())
        });
        assert_eq!(result, Ok(()));
    });
    assert!(!is_stopped());
}

#[test]
fn issue_7914_fresh_empty_poll_observes_later_account_installation() {
    let account = bounded(None);
    let result = with_terminal_scope(|| {
        assert!(!is_active());
        assert!(
            !is_stopped(),
            "healthy empty domain before account installation"
        );
        account.scope(|| {
            assert!(!is_stopped(), "new account starts healthy");
            account.cancel();
            assert!(
                is_stopped(),
                "fresh account presence must defeat cached absence"
            );
        });
        assert!(!is_active());
        assert!(
            is_stopped(),
            "account stop must survive in the terminal domain"
        );
        assert_eq!(check_current(), Err(ProgramStop::Cancelled));
        Ok(())
    });
    assert_eq!(result, Err(ProgramStop::Cancelled));
    assert!(!is_stopped());
}
