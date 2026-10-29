// SPDX-License-Identifier: MPL-2.0
//! Bound fault recovery and allow at most sixteen uncharged cancellations.
//! M4 band-phase retirements have their own allowance (#7955).
use super::runtime::RuntimeFault;

/// Band-phase retirements replaced without charging `max`. Once spent, the
/// model refuses its remaining layered products before any kernel call.
const LAYER_RETIREMENTS: u8 = 3;

pub(super) struct RestartBudget {
    max: u8,
    restarts: u8,
    replacement: bool,
    deliberate: u8,
    layer: u8,
}
impl RestartBudget {
    pub(super) fn new(max: u8, has_worker: bool) -> Self {
        Self { max: max.min(3), restarts: 0, replacement: has_worker, deliberate: 0, layer: 0 }
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
    pub(super) fn layer_retirement(&mut self) {
        if self.layer < LAYER_RETIREMENTS {
            self.layer += 1;
            self.replacement = false;
        }
    }
    pub(super) fn layer_allowance_spent(&self) -> bool { self.layer >= LAYER_RETIREMENTS }
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

    // #7955 review: band-phase retirements never spend fault restarts; the
    // allowance is reported spent so later layered products refuse early.
    #[test]
    fn layer_retirements_spend_their_own_allowance() {
        let mut budget = RestartBudget::new(0, false);
        budget.acquire(|| Ok(())).unwrap();
        for _ in 0..LAYER_RETIREMENTS {
            assert!(!budget.layer_allowance_spent());
            budget.layer_retirement();
            budget.acquire(|| Ok(())).unwrap();
        }
        assert!(budget.layer_allowance_spent());
        assert_eq!(budget.restarts(), 0);
        budget.layer_retirement();
        assert!(budget.acquire::<()>(|| panic!("a spent allowance charges max")).is_err());
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
