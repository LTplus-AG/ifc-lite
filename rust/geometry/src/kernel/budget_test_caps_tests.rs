// SPDX-License-Identifier: MPL-2.0
//! Actual operation snapshots stay private to concurrently executing test threads.
use super::*;
use super::super::{CAP, ELEMENT_CAP};
use std::sync::{Arc, Barrier, atomic::Ordering};

#[test]
fn small_test_cap_cannot_trip_a_parallel_operation_or_change_process_profiles() {
    let process = (CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed));
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = barrier.clone();
    let worker = std::thread::spawn(move || {
        worker_barrier.wait();
        // No test override on this thread: use the actual normal profile.
        super::super::begin_element();
        super::super::begin();
        let operation = super::super::env_cap().unwrap_or(process.0);
        let element = if operation == 0 {0} else {
            super::super::env_element_cap().unwrap_or(process.1)
        };
        for _ in 0..3 { super::super::note_escalation(); }
        let bounded = |cap| if cap == 0 {u64::MAX} else {cap};
        assert_eq!(OP_CAP.with(Cell::get), bounded(operation));
        assert_eq!(ELEM_CAP.with(Cell::get), bounded(element));
        assert_eq!(super::super::tripped(), 3 >= bounded(operation) || 3 >= bounded(element));
        assert_eq!(CAP.load(Ordering::Relaxed), process.0);
        assert_eq!(ELEMENT_CAP.load(Ordering::Relaxed), process.1);
    });
    let _scope = scope();
    set_cap(Some(2)); set_element_cap(Some(3));
    super::super::begin_element(); super::super::begin();
    for _ in 0..2 { super::super::note_escalation(); }
    assert!(super::super::tripped());
    barrier.wait(); worker.join().unwrap();
    assert_eq!(OP_CAP.with(Cell::get),2);
    assert_eq!(super::super::count(),2);
    assert_eq!((CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed)), process);
}

#[test]
fn panic_restores_test_configuration_and_the_original_operation_snapshot() {
    let process = (CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed));
    let prior = (CONFIG.with(Cell::get), COUNT.with(Cell::get), OP_CAP.with(Cell::get),
        ELEM_COUNT.with(Cell::get), ELEM_CAP.with(Cell::get));
    let result = std::panic::catch_unwind(|| {
        let _scope = scope();
        set_cap(Some(2)); set_element_cap(Some(3));
        super::super::begin_element(); super::super::begin();
        for _ in 0..2 { super::super::note_escalation(); }
        assert!(super::super::tripped());
        panic!("test fixture failed after real exact-work accounting");
    });
    assert!(result.is_err());
    assert_eq!((CONFIG.with(Cell::get), COUNT.with(Cell::get), OP_CAP.with(Cell::get),
        ELEM_COUNT.with(Cell::get), ELEM_CAP.with(Cell::get)), prior);
    assert_eq!((CAP.load(Ordering::Relaxed), ELEMENT_CAP.load(Ordering::Relaxed)), process);
}
