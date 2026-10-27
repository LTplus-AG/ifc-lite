// SPDX-License-Identifier: MPL-2.0
//! #7955 S3 R1: detached jobs cannot reach a waiting owned resource observer.
use super::*;

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}

fn distinct_failure() -> ProgramStop {
    ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::Work,
        requested: 2,
        remaining: 1,
        reason: RefusalReason::Limit,
    })
}

fn assert_healthy(context: &OwnedResourceContext, account: &ExecutionAccount) {
    assert_eq!(account.check(), Ok(()));
    assert_eq!(context.source.as_ref().unwrap().check(), Ok(()));
    assert_eq!(context.check(), Ok(()));
}

// Shadow the ordinary TLS channels with a real fresh source epoch and account.
// Only the restored owned observer can report this stop to the captured source
// and account. Check them before a context check or scope drop can report it.
fn assert_later_nested_work_observed(context: &OwnedResourceContext, original: &ExecutionAccount) {
    assert_healthy(context, original);
    let nested_account = account();
    let owner = ExecutionOwner::default();
    let mut lease = owner.try_lease().unwrap();
    let work = lease.begin_synchronous_work(owner.identity()).unwrap();
    let source = work.source_borrow_scope();
    let stop = distinct_failure();
    resource::with_source_stop(source.resource_stop_handle(), || {
        nested_account.source_scope(|| {
            assert_eq!(resource::check_current(), Ok(()));
            assert_eq!(resource::stop(stop), stop);
        });
    });
    assert_eq!(source.resource_stop_handle().check(), Err(stop));
    assert_eq!(nested_account.check(), Err(stop));
    assert_eq!(
        context.source.as_ref().unwrap().check(),
        Err(stop),
        "S3_DETACH_RESTORE: subsequent nested work reaches captured source"
    );
    assert_eq!(original.check(), Err(stop));
    assert_eq!(context.check(), Err(stop));
}

#[test]
fn unrelated_detached_cancel_preserves_waiting_account_source_and_context() {
    for accounted in [true, false] {
        let original = account();
        let waiting = captured(accounted.then_some(&original));
        assert_healthy(&waiting, &original);
        waiting.with_scope(|| {
            assert_eq!(
                resource::detached(|| {
                    assert_eq!(resource::check_current(), Ok(()));
                    assert!(!resource::is_active());
                    resource::stop(ProgramStop::Cancelled)
                }),
                ProgramStop::Cancelled
            );
            assert_eq!(
                waiting.source.as_ref().unwrap().check(),
                Ok(()),
                "S3_DETACH_CLEAR: unrelated cancel must not poison captured source"
            );
            assert_healthy(&waiting, &original);
            assert_eq!(resource::check_current(), Ok(()));
        });
        assert_healthy(&waiting, &original);
        assert_eq!(resource::check_current(), Ok(()));
    }
}

#[test]
fn stopped_waiter_does_not_rewrite_detached_tasks_distinct_failure() {
    let original = account();
    let waiting = captured(Some(&original));
    assert_healthy(&waiting, &original);
    waiting.with_scope(|| {
        assert_eq!(
            resource::stop(ProgramStop::Cancelled),
            ProgramStop::Cancelled
        );
        let failure = distinct_failure();
        let observed = resource::detached(|| {
            assert_eq!(resource::check_current(), Ok(()));
            resource::stop(failure)
        });
        assert_eq!(
            observed, failure,
            "S3_DETACH_DISTINCT: waiter must not rewrite unrelated stop"
        );
        assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled));
    });
    assert_eq!(original.check(), Err(ProgramStop::Cancelled));
    assert_eq!(
        waiting.source.as_ref().unwrap().check(),
        Err(ProgramStop::Cancelled)
    );
    assert_eq!(waiting.check(), Err(ProgramStop::Cancelled));
    assert_eq!(resource::check_current(), Ok(()));
}

#[test]
fn normal_detach_return_restores_observation_for_later_nested_work() {
    let original = account();
    let waiting = captured(Some(&original));
    waiting.with_scope(|| {
        assert_healthy(&waiting, &original);
        assert_eq!(resource::detached(|| 7), 7);
        assert_later_nested_work_observed(&waiting, &original);
    });
    assert_eq!(resource::check_current(), Ok(()));
}

#[test]
fn error_detach_return_restores_observation_for_later_nested_work() {
    let original = account();
    let waiting = captured(Some(&original));
    waiting.with_scope(|| {
        assert_healthy(&waiting, &original);
        assert_eq!(
            resource::detached(|| Err::<(), _>(distinct_failure())),
            Err(distinct_failure())
        );
        assert_later_nested_work_observed(&waiting, &original);
    });
    assert_eq!(resource::check_current(), Ok(()));
}

#[test]
fn detach_unwind_restores_observation_for_later_nested_work() {
    let original = account();
    let waiting = captured(Some(&original));
    waiting.with_scope(|| {
        assert_healthy(&waiting, &original);
        let unwind = std::panic::catch_unwind(|| {
            resource::detached(|| {
                panic!("deliberate detached unwind");
            })
        });
        assert_eq!(
            unwind.unwrap_err().downcast_ref::<&str>(),
            Some(&"deliberate detached unwind")
        );
        assert_later_nested_work_observed(&waiting, &original);
    });
    assert_eq!(resource::check_current(), Ok(()));
}

#[test]
fn nested_detach_restores_each_jobs_observer_without_reinstating_waiter_early() {
    let original = account();
    let waiting = captured(Some(&original));
    let unrelated_account = account();
    let unrelated = captured(Some(&unrelated_account));
    waiting.with_scope(|| {
        resource::detached(|| {
            unrelated.with_scope(|| {
                resource::detached(|| {
                    resource::detached(|| {
                        assert_eq!(
                            resource::stop(ProgramStop::Cancelled),
                            ProgramStop::Cancelled
                        );
                    })
                });
                assert_healthy(&waiting, &original);
                assert_healthy(&unrelated, &unrelated_account);
                assert_later_nested_work_observed(&unrelated, &unrelated_account);
                assert_healthy(&waiting, &original);
            });
            // Exiting the unrelated owned scope restores the outer detached
            // domain, which still must not observe or poison the waiter.
            assert_eq!(resource::check_current(), Ok(()));
            assert_eq!(
                resource::stop(ProgramStop::Cancelled),
                ProgramStop::Cancelled
            );
            assert_healthy(&waiting, &original);
        });
        assert_later_nested_work_observed(&waiting, &original);
    });
    assert_eq!(resource::check_current(), Ok(()));
}

#[test]
fn nested_detach_unwind_restores_inner_observer_before_outer_waiter() {
    let original = account();
    let waiting = captured(Some(&original));
    let unrelated_account = account();
    let unrelated = captured(Some(&unrelated_account));
    waiting.with_scope(|| {
        resource::detached(|| {
            unrelated.with_scope(|| {
                let unwind = std::panic::catch_unwind(|| {
                    resource::detached(|| {
                        resource::detached(|| panic!("deliberate nested detached unwind"));
                    })
                });
                assert_eq!(
                    unwind.unwrap_err().downcast_ref::<&str>(),
                    Some(&"deliberate nested detached unwind")
                );
                assert_healthy(&waiting, &original);
                assert_later_nested_work_observed(&unrelated, &unrelated_account);
                assert_healthy(&waiting, &original);
            });
            assert_eq!(resource::check_current(), Ok(()));
            assert_eq!(
                resource::stop(ProgramStop::Cancelled),
                ProgramStop::Cancelled
            );
            assert_healthy(&waiting, &original);
        });
        assert_later_nested_work_observed(&waiting, &original);
    });
    assert_eq!(resource::check_current(), Ok(()));
}
