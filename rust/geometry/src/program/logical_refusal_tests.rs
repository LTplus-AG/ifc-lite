// SPDX-License-Identifier: MPL-2.0
use crate::program::mapping_budget::LogicalBudget;
use std::sync::{Arc, Barrier};

#[test]
fn issue_9268_logical_budget_details_survive_cross_thread_token_and_slot_reuse() {
    let mut budget = LogicalBudget::with_limit(3);
    for _ in 0..3 { assert!(budget.mapped_attempt().is_ok()); }
    let refusal = budget.mapped_attempt().unwrap_err();
    let gate = Arc::new(Barrier::new(2));
    let worker_gate = gate.clone();
    let worker = std::thread::spawn(move || {
        worker_gate.wait();
        refusal.details()
    });
    // Exercise real failing debits and reclamation while an earlier token is
    // owned by another thread. Reused slots must never overwrite that evidence.
    for _ in 0..64 {
        let mut other = LogicalBudget::with_limit(0);
        drop(other.mapped_attempt().unwrap_err());
    }
    gate.wait();
    assert_eq!(worker.join().unwrap(), ("logical mapped attempts", 3, 4));
}
