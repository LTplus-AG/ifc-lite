// SPDX-License-Identifier: MPL-2.0
//! Resumable exact-work accounting uses real budget guards and trip decisions.
use super::super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn charge(count: usize) {
    for _ in 0..count {
        note_escalation();
    }
}

#[test]
fn interleaved_elements_keep_their_cumulative_caps_and_restore_the_caller() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    profile.set_cap(Some(100));
    profile.set_element_cap(Some(3));
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
    profile.set_element_cap(Some(1000));
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
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    profile.set_cap(Some(2));
    profile.set_element_cap(Some(100));
    let _caller = enter_element();
    begin();
    let mut state = ElementState::new();
    state.with_scope(|| {
        begin();
        charge(1);
        assert!(!tripped());
    });
    profile.set_cap(Some(100));
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
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    profile.set_cap(Some(4));
    profile.set_element_cap(Some(6));
    let _caller = enter_element();
    begin();
    let mut state = ElementState::new();
    state.with_scope(|| {
        begin();
        charge(2);
    });
    let mut state = std::thread::spawn(move || {
        let profile = TestProfile::new();
        // Destination configuration is independent from the migrated snapshot.
        profile.set_cap(Some(20));
        profile.set_element_cap(Some(30));
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
}

#[test]
fn nested_scopes_and_error_return_restore_enclosing_counters_and_caps() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    profile.set_cap(Some(8));
    profile.set_element_cap(Some(10));
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
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    profile.set_cap(Some(4));
    profile.set_element_cap(Some(6));
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

#[test]
fn leaving_a_scope_folds_its_last_operation_and_element_totals_into_the_peaks() {
    let _lock = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    profile.set_cap(Some(100));
    profile.set_element_cap(Some(100));
    let _caller = enter_element();
    begin();
    let mut state = ElementState::new();
    reset_peak();
    state.with_scope(|| {
        begin();
        charge(3);
        charge(2);
    });
    assert_eq!(peak(), 5, "the scope's last operation is folded on exit");
    assert_eq!(element_peak(), 5, "the scope's element total is folded on exit");
    assert_eq!((count(), element_count()), (0, 0));
}
