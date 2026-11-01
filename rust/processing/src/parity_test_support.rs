// SPDX-License-Identifier: MPL-2.0
//! Opt-in test observation of the actual native scan, never a second planner.

pub type PlannedJob = (u32, Option<u32>, u8);
thread_local! {
    static JOBS: std::cell::RefCell<Vec<PlannedJob>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub(crate) fn record(jobs: impl Iterator<Item = PlannedJob>) {
    JOBS.with_borrow_mut(|slot| *slot = jobs.collect());
}

pub fn take_jobs() -> Vec<PlannedJob> {
    JOBS.with_borrow_mut(std::mem::take)
}

// #8415: observe the whole-file finish constructor, not an asserted source spelling.
thread_local! {
    static FINISH_RESCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
pub(crate) fn record_finish_rescan() {
    FINISH_RESCANS.with(|count| count.set(count.get() + 1));
}
pub fn take_finish_rescans() -> usize {
    FINISH_RESCANS.with(|count| count.replace(0))
}
