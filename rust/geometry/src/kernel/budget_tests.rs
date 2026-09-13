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
    let _guard = GLOBAL_CAP_LOCK.lock().unwrap();
    let restore = cap();

    set_cap(Some(5));
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
    set_cap(None);
    begin();
    for _ in 0..10_000 {
        note_escalation();
    }
    assert_eq!(count(), 10_000);
    assert!(!tripped(), "unbounded (cap None) must never trip");

    set_cap(restore);
}

/// The per-element budget (#1109 follow-up) accumulates across an element's
/// booleans even though `begin()` resets the per-boolean counter, trips the
/// element as a whole, and is reset by `begin_element()`. It stays unbounded
/// for callers that never open an element scope (the kernel/router tests and
/// the server profile), which is what keeps the pinned snapshots unchanged.
#[test]
fn per_element_budget_accumulates_across_booleans() {
    let _guard = GLOBAL_CAP_LOCK.lock().unwrap();
    let restore_cap = cap();
    let restore_ecap = element_cap();
    // A bounded per-boolean profile so begin_element() activates the element
    // cap (it is unbounded only when the per-boolean profile is unbounded).
    set_cap(Some(1_000_000));
    set_element_cap(Some(10));

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
    set_cap(None);
    begin_element();
    for _ in 0..100_000 {
        note_escalation();
    }
    assert_eq!(element_count(), 100_000);
    assert!(!tripped(), "unbounded per-boolean profile ⇒ unbounded element");

    set_cap(restore_cap);
    set_element_cap(restore_ecap);
}
