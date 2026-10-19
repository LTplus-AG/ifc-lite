// SPDX-License-Identifier: MPL-2.0
//! Resumable exact-work accounting uses real budget guards and trip decisions.
use super::super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

struct Caps {
    op: Option<u64>,
    element: Option<u64>,
}
impl Caps {
    fn set(op: u64, element: u64) -> Self {
        let saved = Self {
            op: cap(),
            element: element_cap(),
        };
        test_caps::set_cap(Some(op));
        test_caps::set_element_cap(Some(element));
        saved
    }
}
impl Drop for Caps {
    fn drop(&mut self) {
        test_caps::set_cap(self.op);
        test_caps::set_element_cap(self.element);
    }
}
fn charge(count: usize) {
    for _ in 0..count {
        note_escalation();
    }
}

#[test]
fn interleaved_elements_keep_their_cumulative_caps_and_restore_the_caller() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = test_caps::scope();
    let _caps = Caps::set(100, 3);
    let _caller = enter_element();
    begin();
    let mut first = ElementState::new();
    let mut second = ElementState::new();
    first.with_scope(|| {
        begin();
        charge(2);
        assert!(!tripped());
    });
    second.with_scope(|| {
        begin();
        charge(1);
        assert!(!tripped());
    });
    test_caps::set_element_cap(Some(1000));
    first.with_scope(|| {
        assert_eq!(element_count(), 2);
        charge(1);
        assert!(
            tripped(),
            "resume retains its original element cap of three"
        );
    });
    second.with_scope(|| {
        begin();
        assert_eq!(element_count(), 1);
        charge(1);
        assert!(!tripped());
    });
    assert_eq!((count(), element_count()), (0, 0));
    assert!(!tripped());
}

#[test]
fn resuming_keeps_current_operation_cap_until_an_actual_new_operation_begins() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = test_caps::scope();
    let _caps = Caps::set(2, 100);
    let _caller = enter_element();
    begin();
    let mut state = ElementState::new();
    state.with_scope(|| {
        begin();
        charge(1);
        assert!(!tripped());
    });
    test_caps::set_cap(Some(100));
    state.with_scope(|| {
        charge(1);
        assert_eq!(count(), 2);
        assert!(tripped());
        begin();
        charge(3);
        assert!(!tripped());
        assert_eq!(element_count(), 5);
    });
    assert_eq!((count(), element_count()), (0, 0));
}

#[test]
fn element_budget_survives_thread_migration_and_restores_destination_counters() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = test_caps::scope();
    let _caps = Caps::set(4, 6);
    let _caller = enter_element();
    begin();
    let mut state = ElementState::new();
    state.with_scope(|| {
        begin();
        charge(2);
    });
    let mut state = std::thread::spawn(move || {
        let _test_caps = test_caps::scope();
        // Destination configuration is independent from the migrated snapshot.
        test_caps::set_cap(Some(20));
        test_caps::set_element_cap(Some(30));
        let _destination = enter_element();
        begin();
        charge(1);
        state.with_scope(|| {
            assert_eq!((count(), element_count()), (2, 2));
            charge(2);
            assert!(tripped(), "the operation cap travels with the state");
        });
        assert_eq!((count(), element_count()), (1, 1));
        assert_eq!(OP_CAP.with(|cap| cap.get()), 20);
        assert_eq!((cap(), element_cap()), (Some(20), Some(30)));
        assert!(!tripped());
        state
    })
    .join()
    .unwrap();
    state.with_scope(|| {
        assert_eq!((count(), element_count()), (4, 4));
        assert!(tripped());
        begin();
        charge(2);
        assert!(tripped(), "new operation retains cumulative element cap");
    });
    assert_eq!((count(), element_count()), (0, 0));
    assert!(!tripped());
    assert!(peak() >= 4);
    assert!(element_peak() >= 6);
}

#[test]
fn nested_scopes_and_error_return_restore_enclosing_counters_and_caps() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = test_caps::scope();
    let _caps = Caps::set(8, 10);
    let _caller = enter_element();
    begin();
    charge(2);
    let mut state = ElementState::new();
    let result = state.with_scope(|| {
        assert_eq!(
            (count(), element_count()),
            (2, 0),
            "initialization matches enter_element"
        );
        charge(1);
        {
            let _nested = enter_element();
            begin();
            charge(8);
            assert!(tripped());
        }
        assert_eq!((count(), element_count()), (3, 1));
        assert!(!tripped());
        Err::<(), _>("poll error")
    });
    assert_eq!(result, Err("poll error"));
    assert_eq!((count(), element_count()), (2, 2));
    assert!(!tripped());
    state.with_scope(|| {
        assert_eq!((count(), element_count()), (3, 1));
        charge(1);
    });
    assert_eq!((count(), element_count()), (2, 2));
}

#[test]
fn panic_saves_element_progress_and_restores_the_callers_budget() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = test_caps::scope();
    let _caps = Caps::set(4, 6);
    let _caller = enter_element();
    begin();
    charge(1);
    let mut state = ElementState::new();
    let panic = catch_unwind(AssertUnwindSafe(|| {
        state.with_scope(|| {
            begin();
            charge(4);
            assert!(tripped());
            panic!("poll panic");
        })
    }));
    assert!(panic.is_err());
    assert_eq!((count(), element_count()), (1, 1));
    assert!(!tripped());
    state.with_scope(|| {
        assert_eq!((count(), element_count()), (4, 4));
        assert!(tripped());
        begin();
        charge(2);
        assert!(tripped());
    });
    assert_eq!((count(), element_count()), (1, 1));
    assert!(!tripped());
}
