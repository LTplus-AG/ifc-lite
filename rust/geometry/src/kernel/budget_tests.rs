// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `budget`, split out of the module to keep it under the module-size
//! ratchet (`_tests.rs` siblings are exempt).

use super::*;

/// The cap counts escalations and trips at exactly the configured count,
/// deterministically; `begin()` resets; unbounded never trips.
#[test]
fn cap_counts_and_trips_deterministically() {
    let _guard = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();

    profile.set_cap(Some(5));
    begin();
    assert_eq!(count(), 0);
    assert!(!tripped(), "fresh op must not be tripped");
    for _ in 0..4 {
        note_escalation();
    }
    assert_eq!(count(), 4);
    assert!(!tripped(), "4 < cap 5 must not trip");
    note_escalation(); // the 5th reaches the cap
    assert_eq!(count(), 5);
    assert!(tripped(), "count == cap must trip");
    note_escalation(); // stays tripped past the cap
    assert!(tripped());

    // begin() resets the per-op counter + trip latch.
    begin();
    assert_eq!(count(), 0);
    assert!(!tripped());

    // Unbounded never trips, no matter how many escalations.
    profile.set_cap(None);
    begin();
    for _ in 0..10_000 {
        note_escalation();
    }
    assert_eq!(count(), 10_000);
    assert!(!tripped(), "unbounded (cap None) must never trip");

}

/// The per-element budget (#1109 follow-up) accumulates across an element's
/// booleans even though `begin()` resets the per-boolean counter, trips the
/// element as a whole, and is reset by `begin_element()`. It stays unbounded
/// for callers that never open an element scope (the kernel/router tests and
/// the server profile), which is what keeps the pinned snapshots unchanged.
#[test]
fn per_element_budget_accumulates_across_booleans() {
    let _guard = GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let profile = TestProfile::new();
    // A bounded per-boolean profile so begin_element() activates the element
    // cap (it is unbounded only when the per-boolean profile is unbounded).
    profile.set_cap(Some(1_000_000));
    profile.set_element_cap(Some(10));

    begin_element();
    assert_eq!(element_count(), 0);
    assert!(!tripped(), "fresh element must not be tripped");

    // Three booleans, 4 escalations each = 12 total > the element cap of 10,
    // even though no single boolean's per-op count (4) reaches it.
    for _ in 0..3 {
        begin(); // per-boolean reset — does NOT reset the element accumulator
        assert_eq!(count(), 0, "begin() resets the per-boolean counter");
        for _ in 0..4 {
            note_escalation();
        }
    }
    assert_eq!(element_count(), 12);
    assert!(tripped(), "element total 12 >= element cap 10 must trip");
    // ...and it stays tripped through the NEXT boolean even after begin()
    // zeroes the per-boolean counter — so the element's remaining cuts bail.
    begin();
    assert_eq!(count(), 0);
    assert!(tripped(), "element budget stays blown across begin()");

    // begin_element() opens a fresh scope and clears the trip.
    begin_element();
    assert_eq!(element_count(), 0);
    assert!(!tripped());

    // An unbounded per-boolean profile makes the element cap unbounded too
    // (the single server/offline-export switch), so it never trips.
    profile.set_cap(None);
    begin_element();
    for _ in 0..100_000 {
        note_escalation();
    }
    assert_eq!(element_count(), 100_000);
    assert!(!tripped(), "unbounded per-boolean profile ⇒ unbounded element");

}

/// A tiny fixture profile must not change the caps sampled by unrelated unions.
#[test]
fn scoped_profile_isolates_concurrent_union_readers() {
    use crate::kernel::{arrangement::box_mesh, mesh_bridge::{tris_to_mesh, union}};
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    std::thread::scope(|threads| {
        let tiny = threads.spawn(move || {
            let profile = TestProfile::new();
            profile.set_cap(Some(1));
            profile.set_element_cap(Some(1));
            begin_element();
            begin();
            note_escalation();
            ready_tx.send(()).unwrap();
            // Sender drop also releases us if the ordinary reader panics.
            let _ = release_rx.recv();
            assert_eq!(cap(), Some(1));
            assert_eq!(element_cap(), Some(1));
            assert!(tripped());
        });
        let normal = threads.spawn(move || {
            ready_rx.recv().unwrap();
            let global_cap = CAP.load(Ordering::Relaxed);
            let global_element_cap = ELEMENT_CAP.load(Ordering::Relaxed);
            assert_eq!(cap(), (global_cap != 0).then_some(global_cap));
            assert_eq!(element_cap(), (global_element_cap != 0).then_some(global_element_cap));
            let a = tris_to_mesh(&box_mesh([0.; 3], [1.; 3]));
            let b = tris_to_mesh(&box_mesh([0.5, 0., 0.], [1.5, 1., 1.]));
            let result = union(&a, &b);
            release_tx.send(()).unwrap();
            assert!(!result.is_empty(), "ordinary union must complete beside a cap-one fixture");
            assert!(!tripped());
            assert!(count() > 1, "real union must exceed the peer's tiny cap");
        });
        tiny.join().unwrap();
        normal.join().unwrap();
    });
}

fn active_snapshot() -> (u64, u64, u64, u64, incidence_work::Snapshot) {
    (COUNT.with(Cell::get), OP_CAP.with(Cell::get), ELEM_COUNT.with(Cell::get),
        ELEM_CAP.with(Cell::get), incidence_work::snapshot())
}

#[test]
fn scoped_profile_restores_nested_configuration_and_active_budgets() {
    let original_caps = (cap(), element_cap());
    let original_active = active_snapshot();
    {
        let outer = TestProfile::new();
        assert_eq!(active_snapshot(), original_active, "opening a test profile activates no element");
        outer.set_cap(Some(9));
        outer.set_element_cap(Some(15));
        assert_eq!(active_snapshot(), original_active, "configuration applies only at begin boundaries");
        begin_element();
        begin();
        note_escalation();
        incidence_work::spend(3).unwrap();
        let outer_active = active_snapshot();
        {
            let inner = TestProfile::new();
            inner.set_cap(None);
            inner.set_element_cap(Some(1));
            assert_eq!(active_snapshot(), outer_active);
            begin_element();
            begin();
            note_escalation();
            assert_eq!(OP_CAP.with(Cell::get), u64::MAX);
            assert_eq!(ELEM_CAP.with(Cell::get), u64::MAX,
                "unbounded boolean profile also lifts the element cap");
            incidence_work::spend(7).unwrap();
        }
        assert_eq!((cap(), element_cap()), (Some(9), Some(15)));
        assert_eq!(active_snapshot(), outer_active);
        // A newly configured cap must not rewrite either active cap snapshot.
        outer.set_cap(Some(2));
        outer.set_element_cap(Some(3));
        assert_eq!(active_snapshot(), outer_active);
    }
    assert_eq!((cap(), element_cap()), original_caps);
    assert_eq!(active_snapshot(), original_active);
}

#[test]
fn scoped_profile_restores_configuration_and_active_budgets_on_unwind() {
    let outer = TestProfile::new();
    outer.set_cap(Some(11));
    outer.set_element_cap(Some(17));
    begin_element();
    begin();
    note_escalation();
    incidence_work::spend(4).unwrap();
    let before = active_snapshot();
    let failure = std::panic::catch_unwind(|| {
        let inner = TestProfile::new();
        inner.set_cap(Some(1));
        inner.set_element_cap(None);
        begin_element();
        begin();
        note_escalation();
        incidence_work::spend(9).unwrap();
        panic!("exercise scoped budget restoration");
    });
    assert!(failure.is_err());
    assert_eq!((cap(), element_cap()), (Some(11), Some(17)));
    assert_eq!(active_snapshot(), before);
    assert!(!tripped());
}

#[path = "budget/isolation_tests.rs"]
mod isolation_tests;
