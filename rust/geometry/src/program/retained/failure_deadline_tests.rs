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

#[test]
fn issue_7955_inner_curves_stop_becomes_deadline_refusal_not_unsupported() {
    use ifc_lite_core::{build_entity_index, EntityDecoder};
    let data = b"#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCCIRCLE(#2,10.);
#4=IFCCIRCLE(#2,1.);
#5=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#3,(#4));
#6=IFCDIRECTION((0.,0.,1.));
#7=IFCEXTRUDEDAREASOLID(#5,$,#6,2.);";
    let selection = crate::program::retained::RetainedSelection::new(
        crate::program::retained::RetainedContract {
            source_epoch: 1,
            source_revision: 1,
        },
        1,
    )
    .unwrap();
    let handle = selection.failure_handle();
    resource::budget_test_clock::scope(|clock| {
        let budget = ProductBudget::new(BudgetStart::now(), 1000, 10000, 10);
        clock.expire_at("source_step", 4, 10);
        let error = budget.scope(|| {
            let mut decoder = EntityDecoder::with_index(data, build_entity_index(data));
            let solid = decoder.decode_by_id(7).unwrap();
            crate::analytic::try_extract_analytic_extrusion(&solid, &mut decoder).unwrap_err()
        });
        // Consume the real walk error after suspension/resumption of this product.
        budget.scope(|| {
            let error = resource::observe::<()>(Err(error)).unwrap_err();
            assert!(matches!(
                handle.common(FailureSite::Constructor, error),
                RetainedFailure::DeadlineExceeded
            ));
            assert!(handle.origin().is_none());
        });
        assert!(budget.deadline_fired());
    });
}
