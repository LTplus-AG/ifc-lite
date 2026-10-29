// SPDX-License-Identifier: MPL-2.0
//! Bound fault recovery and allow at most sixteen uncharged cancellations.
use super::runtime::RuntimeFault;

pub(super) struct RestartBudget {
    max: u8,
    restarts: u8,
    replacement: bool,
    deliberate: u8,
}
impl RestartBudget {
    pub(super) fn new(max: u8, has_worker: bool) -> Self {
        Self { max: max.min(3), restarts: 0, replacement: has_worker, deliberate: 0 }
    }
    pub(super) fn acquire<W>(&mut self, acquire: impl FnOnce() -> Result<W, RuntimeFault>)
        -> Result<W, RuntimeFault> {
        if self.replacement {
            if self.restarts >= self.max {
                return Err(RuntimeFault::transport("worker restart budget exhausted"));
            }
            self.restarts += 1;
        }
        // A failed acquisition/qualification also requires fault recovery.
        self.replacement = true;
        acquire()
    }
    pub(super) fn deliberate_retirement(&mut self) {
        if self.deliberate < 16 {
            self.deliberate += 1;
            self.replacement = false;
        }
    }
    pub(super) fn restarts(&self) -> u8 { self.restarts }
}

#[cfg(test)]
mod tests {
    use super::*;

    // #7955: retirements within the free allowance never refund earlier faults
    // or consume a fault slot, even when the last product is cancelled.
    #[test]
    fn cancellations_do_not_spend_or_refund_fault_restarts() {
        let mut budget = RestartBudget::new(3, false);
        budget.acquire(|| Ok(())).unwrap();
        budget.acquire(|| Ok(())).unwrap();
        for _ in 0..8 {
            budget.deliberate_retirement();
            budget.acquire(|| Ok(())).unwrap();
            assert_eq!(budget.restarts(), 1);
        }
        budget.deliberate_retirement();
        assert_eq!(budget.restarts(), 1);
        assert!(budget.acquire::<()>(|| Err(RuntimeFault::transport("qualification"))).is_err());
        budget.acquire(|| Ok(())).unwrap();
        budget.acquire(|| Ok(())).unwrap();
        assert_eq!(budget.restarts(), 3);
        assert!(budget.acquire::<()>(|| panic!("exhausted acquisition must not run")).is_err());
    }

    // #7955: even genuine in-flight cancellation cannot respawn indefinitely.
    #[test]
    fn deliberate_replacements_beyond_sixteen_spend_the_fault_cap() {
        let mut budget = RestartBudget::new(3, false);
        budget.acquire(|| Ok(())).unwrap();
        for _ in 0..16 {
            budget.deliberate_retirement();
            budget.acquire(|| Ok(())).unwrap();
            assert_eq!(budget.restarts(), 0);
        }
        for charged in 1..=3 {
            budget.deliberate_retirement();
            budget.acquire(|| Ok(())).unwrap();
            assert_eq!(budget.restarts(), charged);
        }
        budget.deliberate_retirement();
        assert!(budget.acquire::<()>(|| panic!("replacement ceiling must stop acquisition")).is_err());
    }
}
