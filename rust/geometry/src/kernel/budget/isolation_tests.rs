// SPDX-License-Identifier: MPL-2.0
//! Actual operation snapshots stay private to concurrently executing test threads.
use crate::kernel::budget::*;

use std::sync::{Arc, Barrier, atomic::Ordering};

#[test]
fn small_test_cap_cannot_trip_a_parallel_operation_or_change_process_profiles() {
    let process = (CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed));
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = barrier.clone();
    let worker = std::thread::spawn(move || {
        worker_barrier.wait();
        // No test override on this thread: use the actual normal profile.
        crate::kernel::budget::begin_element();
        crate::kernel::budget::begin();
        let operation = crate::kernel::budget::env_cap().unwrap_or(process.0);
        let element = if operation == 0 {0} else {
            crate::kernel::budget::env_element_cap().unwrap_or(process.1)
        };
        for _ in 0..3 { crate::kernel::budget::note_escalation(); }
        let bounded = |cap| if cap == 0 {u64::MAX} else {cap};
        assert_eq!(OP_CAP.with(Cell::get), bounded(operation));
        assert_eq!(ELEM_CAP.with(Cell::get), bounded(element));
        assert_eq!(crate::kernel::budget::tripped(), 3 >= bounded(operation) || 3 >= bounded(element));
        assert_eq!(CAP.load(Ordering::Relaxed), process.0);
        assert_eq!(ELEMENT_CAP.load(Ordering::Relaxed), process.1);
    });
    let scope = TestProfile::new();
    scope.set_cap(Some(2)); scope.set_element_cap(Some(3));
    crate::kernel::budget::begin_element(); crate::kernel::budget::begin();
    for _ in 0..2 { crate::kernel::budget::note_escalation(); }
    assert!(crate::kernel::budget::tripped());
    barrier.wait(); worker.join().unwrap();
    assert_eq!(OP_CAP.with(Cell::get),2);
    assert_eq!(crate::kernel::budget::count(),2);
    assert_eq!((CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed)), process);
}

#[test]
fn panic_restores_test_configuration_and_the_original_operation_snapshot() {
    let process = (CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed));
    let prior = ((cap(), element_cap()), COUNT.with(Cell::get), OP_CAP.with(Cell::get),
        ELEM_COUNT.with(Cell::get), ELEM_CAP.with(Cell::get));
    let result = std::panic::catch_unwind(|| {
        let scope = TestProfile::new();
        scope.set_cap(Some(2)); scope.set_element_cap(Some(3));
        crate::kernel::budget::begin_element(); crate::kernel::budget::begin();
        for _ in 0..2 { crate::kernel::budget::note_escalation(); }
        assert!(crate::kernel::budget::tripped());
        panic!("test fixture failed after real exact-work accounting");
    });
    assert!(result.is_err());
    assert_eq!(((cap(), element_cap()), COUNT.with(Cell::get), OP_CAP.with(Cell::get),
        ELEM_COUNT.with(Cell::get), ELEM_CAP.with(Cell::get)), prior);
    assert_eq!((CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed)), process);
}
