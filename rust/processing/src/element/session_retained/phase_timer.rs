// SPDX-License-Identifier: MPL-2.0
//! Phase durations on the product's monotonic clock, without restarting its deadline.
use ifc_lite_geometry::resource::BudgetStart;
use std::time::Duration;

pub(super) struct PhaseTimer {
    clock: BudgetStart,
    offset: Duration,
}
impl PhaseTimer {
    pub(super) fn now() -> Self {
        let clock = BudgetStart::now();
        let offset = clock.elapsed();
        Self { clock, offset }
    }
    pub(super) fn elapsed(&self) -> Duration {
        self.clock.elapsed().saturating_sub(self.offset)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use ifc_lite_geometry::resource::{budget_checkpoint, ProductBudget};

    #[test]
    fn issue_7955_phase_excludes_prior_work_without_restarting_deadline() {
        let start = BudgetStart::now();
        let budget = ProductBudget::new(start.clone(), 100, 4096, 0);
        budget.scope(|| {
            std::thread::sleep(Duration::from_millis(2));
            let phase = PhaseTimer::now();
            assert!(phase.offset >= Duration::from_millis(2));
            assert!(phase.elapsed() < start.elapsed());
            assert!(budget_checkpoint().is_err(), "phase measurement must not renew the expired budget");
        });
        assert!(budget.deadline_fired());
    }
}
