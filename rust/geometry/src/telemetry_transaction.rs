// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Publish route telemetry only after speculative geometry is accepted (#4617).
//! Buffers are thread-local: rejecting one host never resets another worker's
//! counters. Nested attempts publish into their parent until it also commits.
//! Actual-work measurements (CSG operand census, weld calls and resource budgets)
//! bypass this buffer so rejected attempts remain visible to performance probes.

use std::cell::RefCell;
use std::marker::PhantomData;
use std::rc::Rc;

/// Plain owned route facts. A detached effect set carries no executable
/// callbacks, so it can cross a thread boundary and be committed exactly once.
#[derive(Clone, Copy)]
pub(crate) enum Event {
    ParametricCut,
    PlanarCut {
        footprints: u64,
    },
    #[cfg(any(
        feature = "observability",
        feature = "csg_capture",
        feature = "debug_geometry"
    ))]
    PrismDefer {
        reason: usize,
    },
    #[cfg(any(
        feature = "observability",
        feature = "csg_capture",
        feature = "debug_geometry"
    ))]
    PrismCut {
        committed: u64,
        residual: u64,
    },
}

impl Event {
    /// Add this fact to the owning process-global counter.
    fn publish(self) {
        match self {
            Self::ParametricCut => crate::rect_fast::publish_param_fire(),
            Self::PlanarCut { footprints } => {
                crate::router::voids::bool2d_path::publish_cut(footprints)
            }
            #[cfg(any(
                feature = "observability",
                feature = "csg_capture",
                feature = "debug_geometry"
            ))]
            Self::PrismDefer { reason } => crate::router::voids::prism_cut::publish_defer(reason),
            #[cfg(any(
                feature = "observability",
                feature = "csg_capture",
                feature = "debug_geometry"
            ))]
            Self::PrismCut {
                committed,
                residual,
            } => crate::router::voids::prism_cut::publish_cut(committed, residual),
        }
    }
}

thread_local! {
    static PENDING: RefCell<Vec<Vec<Event>>> = const { RefCell::new(Vec::new()) };
}

/// Buffer into the innermost open attempt, or publish immediately when none.
pub(crate) fn record(event: Event) {
    let buffered = PENDING.with(|pending| match pending.borrow_mut().last_mut() {
        Some(buffer) => {
            buffer.push(event);
            true
        }
        None => false,
    });
    if !buffered {
        event.publish();
    }
}

/// Must stay on the thread that owns its buffer, including during unwinding.
struct Transaction {
    active: bool,
    _same_thread: PhantomData<Rc<()>>,
}

impl Transaction {
    fn new() -> Self {
        PENDING.with(|pending| pending.borrow_mut().push(Vec::new()));
        Self {
            active: true,
            _same_thread: PhantomData,
        }
    }

    fn detach(mut self) -> EffectSet {
        let events = PENDING.with(|pending| pending.borrow_mut().pop().unwrap_or_default());
        self.active = false;
        EffectSet(events)
    }
}

impl Drop for Transaction {
    fn drop(&mut self) {
        if self.active {
            PENDING.with(|pending| {
                pending.borrow_mut().pop();
            });
        }
    }
}

/// Detached events have no TLS buffer or transaction guard. They are linear:
/// dropping discards only these events; committing publishes once into the
/// currently reached parent scope (or the aggregate sinks).
pub(crate) struct EffectSet(Vec<Event>);

impl EffectSet {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    pub(crate) fn commit(self) {
        for event in self.0 {
            record(event);
        }
    }
}

/// The thread-bound guard exists only while one synchronous numerical step
/// runs; an unwinding step discards its buffer and the original panic
/// propagates untouched.
pub(crate) fn capture<T>(run: impl FnOnce() -> T) -> (T, EffectSet) {
    let transaction = Transaction::new();
    let value = run();
    (value, transaction.detach())
}

#[cfg(test)]
#[path = "telemetry_transaction_tests.rs"]
mod tests;
