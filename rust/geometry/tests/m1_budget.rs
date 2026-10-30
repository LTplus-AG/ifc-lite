// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_geometry::{
    resource::{budget_checkpoint, budget_deadline_fired, BudgetStart, ProductBudget, ProgramStop},
    Error,
};

// Refs #7955: zero duration expires at the entry checkpoint without a sleep.
#[test]
fn zero_duration_records_deadline_without_leaking_the_budget_scope() {
    let budget = ProductBudget::new(BudgetStart::now(), 100, 4096, 0);
    budget.scope(|| {
        assert!(matches!(
            budget_checkpoint(),
            Err(Error::ProgramStopped(ProgramStop::Cancelled))
        ));
        assert!(
            budget_deadline_fired(),
            "deadline must remain distinguishable from cancellation"
        );
    });
    assert!(
        !budget_deadline_fired(),
        "the budget scope must restore the caller"
    );
    assert!(budget_checkpoint().is_ok());
    assert!(budget.deadline_fired(), "product cause survives its scope");
}
