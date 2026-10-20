// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic incidence-traversal allowance, separate from exact predicates.
//! One unit reserves a vertex-plane check, adjacency entry, or collection visit.
//! Band checks reserve all three vertices before the original short-circuit
//! predicate; unused reservations are deliberately not refunded.
//! The limits are conservative safety-policy choices, NOT measured healthy
//! corpus ceilings. Input traversal stays bounded even in the offline exact
//! profile: lifting expensive-predicate caps does not lift this separate guard.
use std::cell::Cell;

#[derive(Debug)]
pub(crate) struct Exhausted;

pub(crate) const OP_LIMIT: u64 = 1 << 20;
const ELEMENT_LIMIT: u64 = 8 * OP_LIMIT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot { op: u64, element: u64, active: bool, limit: u64 }
thread_local! {
    static OP: Cell<u64> = const { Cell::new(0) };
    static ELEMENT: Cell<u64> = const { Cell::new(0) };
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static LIMIT: Cell<u64> = const { Cell::new(OP_LIMIT) };
}
pub(super) fn begin() { OP.with(|v| v.set(0)); }
pub(super) fn begin_element() {
    ELEMENT.with(|v| v.set(0)); ACTIVE.with(|v| v.set(true));
}
pub(super) fn snapshot() -> Snapshot {
    Snapshot { op: OP.with(Cell::get), element: ELEMENT.with(Cell::get),
        active: ACTIVE.with(Cell::get), limit: LIMIT.with(Cell::get) }
}
pub(super) fn restore(s: Snapshot) {
    OP.with(|v| v.set(s.op)); ELEMENT.with(|v| v.set(s.element));
    ACTIVE.with(|v| v.set(s.active)); LIMIT.with(|v| v.set(s.limit));
}
pub(super) fn tripped() -> bool {
    OP.with(Cell::get) > LIMIT.with(Cell::get)
        || (ACTIVE.with(Cell::get) && ELEMENT.with(Cell::get) > ELEMENT_LIMIT)
}
/// Charge BEFORE work. On exhaustion the sticky budget trip makes callers
/// reject the whole boolean; an incomplete connectivity answer is never used.
pub(crate) fn spend(units: usize) -> Result<(), Exhausted> {
    if tripped() { return Err(Exhausted); }
    let n = u64::try_from(units).unwrap_or(u64::MAX);
    OP.with(|v| v.set(v.get().saturating_add(n)));
    if ACTIVE.with(Cell::get) { ELEMENT.with(|v| v.set(v.get().saturating_add(n))); }
    if tripped() { Err(Exhausted) } else { Ok(()) }
}
#[cfg(test)]
pub(crate) fn with_limit<T>(limit: u64, f: impl FnOnce() -> T) -> T {
    struct Restore(Snapshot);
    impl Drop for Restore { fn drop(&mut self) { restore(self.0); } }
    let _restore = Restore(snapshot());
    LIMIT.with(|v| v.set(limit)); OP.with(|v| v.set(0));
    ELEMENT.with(|v| v.set(0)); ACTIVE.with(|v| v.set(false));
    f()
}

#[cfg(test)]
#[path = "incidence_work_tests.rs"]
mod tests;
