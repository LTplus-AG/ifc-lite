// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::resource::{
    BudgetStart, ExecutionAccount, ExecutionPolicy, ProductBudget, ResourceLimits,
};

#[test]
fn issue_7955_r2_common_deadline_allocates_no_origin_with_zero_remaining_bytes() {
    // Reach the real clock error with a live failure slot, then deliver it
    // through the completion adapter with no room for an origin Arc.
    let selection = crate::program::retained::RetainedSelection::new(
        crate::program::retained::RetainedContract {
            source_epoch: 1,
            source_revision: 1,
        },
        1,
    )
    .unwrap();
    let handle = selection.failure_handle();
    let original = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0),
        ..Default::default()
    }));
    resource::budget_test_clock::scope(|clock| {
        original.scope(|| {
            let budget = ProductBudget::new(BudgetStart::now(), 100, 100, 10);
            clock.advance(10);
            budget.scope(|| {
                let error = resource::budget_checkpoint().unwrap_err();
                assert!(matches!(
                    handle.common(FailureSite::ProductCompletion, error),
                    RetainedFailure::DeadlineExceeded
                ));
                assert!(handle.origin().is_none());
                assert!(handle.reported().is_none());
                assert!(original.check().is_ok());
                assert_eq!(original.usage(), resource::Usage::default());
                original.stop(ProgramStop::Cancelled);
                assert!(matches!(
                    handle.common(
                        FailureSite::ProductCompletion,
                        crate::Error::ProgramStopped(ProgramStop::Cancelled)
                    ),
                    RetainedFailure::Stopped(ProgramStop::Cancelled)
                ));
                assert!(handle.origin().is_none());
            });
        })
    });
}
