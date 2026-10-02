// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cooperative progress heartbeat from inside long geometry work.
//!
//! A browser geometry worker runs one synchronous WASM call per batch, and the
//! host can only see that the call is still alive through messages the worker
//! posts. Before this hook a single slow element (a wall with hundreds of
//! curved openings: tens of seconds) was indistinguishable from a genuinely
//! wedged call, so the host's wall-clock recovery replaced the worker after
//! 45 s and skipped the element after another 90 s. Whether an element
//! survived therefore depended on the user's CPU speed and load, which made the
//! same file produce different geometry on different machines.
//!
//! [`tick`] is called at coarse points that every long-running geometry path
//! passes through repeatedly (each boolean, each analytic prism cut, each
//! coplanar consolidation bucket, a strided count of exact-predicate
//! escalations, each element). With no hook installed, the default on every
//! native target, it is a single atomic load. The wasm bindings install a hook
//! that rate-limits by the JS clock and lets the worker post a heartbeat, so a
//! call that is still working is never mistaken for a hung one. The hook has no
//! influence on WHAT is computed: geometry output is identical with or without
//! it.

use std::sync::OnceLock;

static HOOK: OnceLock<fn()> = OnceLock::new();

/// Install the process-wide progress hook. First installation wins; a later
/// call is ignored and returns `false`. The hook must be cheap and must not
/// re-enter geometry code.
pub fn set_hook(hook: fn()) -> bool {
    HOOK.set(hook).is_ok()
}

/// Report that geometry work is progressing. A no-op until a hook is installed.
#[inline]
pub fn tick() {
    if let Some(hook) = HOOK.get() {
        hook();
    }
}

/// [`tick`] on every `(stride_mask + 1)`-th call, for a hot loop whose single
/// iteration is too cheap to report on its own. `stride_mask` is a power of two
/// minus one; `counter` is the loop's own call count.
#[inline]
pub fn tick_strided(counter: &mut u32, stride_mask: u32) {
    *counter = counter.wrapping_add(1);
    if *counter & stride_mask == 0 {
        tick();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    thread_local! {
        // Per thread: the hook is process-wide, and other tests in this binary
        // tick it concurrently from their own threads (every boolean, CDT and
        // consolidation calls `tick`). Counting only this thread's calls keeps
        // the exact-delta assertion exact.
        static TICKS: Cell<u64> = const { Cell::new(0) };
    }
    fn count() {
        TICKS.with(|t| t.set(t.get() + 1));
    }

    #[test]
    fn hook_receives_ticks_and_the_first_installation_wins() {
        // Either test in this module may install `count` first; the tick
        // delta below proves it is the installed hook.
        let _ = set_hook(count);
        assert!(!set_hook(|| panic!("a second hook must not replace the first")));
        let before = TICKS.with(Cell::get);
        tick();
        tick();
        assert_eq!(TICKS.with(Cell::get) - before, 2);
    }

    #[test]
    fn tick_strided_reports_once_per_stride() {
        let _ = set_hook(count);
        let before = TICKS.with(Cell::get);
        let mut calls = 0u32;
        for _ in 0..64 {
            tick_strided(&mut calls, 0xF);
        }
        assert_eq!(TICKS.with(Cell::get) - before, 4);
    }
}
