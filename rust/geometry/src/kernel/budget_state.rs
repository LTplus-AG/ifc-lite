// SPDX-License-Identifier: MPL-2.0
//! Owned exact-work budget state across synchronous execution polls.
use super::{incidence_work, COUNT, ELEM_CAP, ELEM_COUNT, ELEM_PEAK, OP_CAP, PEAK};
use std::{cell::Cell, marker::PhantomData, sync::atomic::Ordering};

#[derive(Debug)]
struct Image {
    incidence: incidence_work::Snapshot,
    count: u64,
    op_cap: u64,
    elem_count: u64,
    elem_cap: u64,
}
impl Image {
    fn current() -> Self {
        Self {
            incidence: incidence_work::snapshot(),
            count: COUNT.with(Cell::get),
            op_cap: OP_CAP.with(Cell::get),
            elem_count: ELEM_COUNT.with(Cell::get),
            elem_cap: ELEM_CAP.with(Cell::get),
        }
    }
    fn install(&self) {
        incidence_work::restore(self.incidence);
        COUNT.with(|value| value.set(self.count));
        OP_CAP.with(|value| value.set(self.op_cap));
        ELEM_COUNT.with(|value| value.set(self.elem_count));
        ELEM_CAP.with(|value| value.set(self.elem_cap));
    }
    fn record_peaks(&self) {
        if self.count != 0 {
            PEAK.fetch_max(self.count, Ordering::Relaxed);
        }
        if self.elem_count != 0 {
            ELEM_PEAK.fetch_max(self.elem_count, Ordering::Relaxed);
        }
    }
}

/// One element's exact-predicate counters and cap snapshots between execution
/// polls. The state can move between threads; each active scope stays on the
/// thread whose caller counters it must restore. State is not cloned because
/// independent copies would fork the cumulative element budget.
#[derive(Debug)]
pub struct ElementState {
    image: Image,
}
impl ElementState {
    /// Initialize at the same boundary as [`super::enter_element`]. This keeps
    /// its inherited operation counters and freshly initialized element scope,
    /// then immediately restores the caller's counters until the first poll.
    pub fn new() -> Self {
        let _scope = super::enter_element();
        Self {
            image: Image::current(),
        }
    }

    /// Run one synchronous poll with this element's budget, save its progress
    /// and restore the caller on return or unwind. Resume does not re-read cap
    /// configuration; normal [`super::begin`] calls still start new operations
    /// and snapshot their per-operation cap as before. All nested budget scopes
    /// opened by the poll must finish before the poll returns.
    pub fn with_scope<T>(&mut self, operation: impl FnOnce() -> T) -> T {
        let _scope = PollScope::enter(&mut self.image);
        operation()
    }
}
impl Default for ElementState {
    fn default() -> Self {
        Self::new()
    }
}

struct PollScope<'a> {
    state: &'a mut Image,
    caller: Image,
    _thread_bound: PhantomData<*const ()>,
}
impl<'a> PollScope<'a> {
    fn enter(state: &'a mut Image) -> Self {
        let caller = Image::current();
        state.install();
        Self {
            state,
            caller,
            _thread_bound: PhantomData,
        }
    }
}
impl Drop for PollScope<'_> {
    fn drop(&mut self) {
        *self.state = Image::current();
        self.state.record_peaks();
        self.caller.install();
    }
}

#[cfg(test)]
#[path = "budget_state_tests.rs"]
mod tests;
