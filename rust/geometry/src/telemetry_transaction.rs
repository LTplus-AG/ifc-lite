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

type Event = Box<dyn FnOnce()>;
thread_local! {
    static PENDING: RefCell<Vec<Vec<Event>>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn record(event: impl FnOnce() + 'static) {
    let mut event = Some(event);
    PENDING.with(|pending| {
        if let Some(buffer) = pending.borrow_mut().last_mut() {
            buffer.push(Box::new(event.take().unwrap()));
        }
    });
    if let Some(event) = event {
        event();
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
    pub(crate) fn commit(self) {
        for event in self.0 {
            record(event);
        }
    }
}

/// The thread-bound guard exists only while a synchronous numerical step runs.
pub(crate) fn capture<T>(run: impl FnOnce() -> T) -> (T, EffectSet) {
    let transaction = Transaction::new();
    let value = run();
    let effects = transaction.detach();
    (value, effects)
}
impl Transaction {
    fn detach(mut self) -> EffectSet {
        let events = PENDING.with(|pending| {
            pending
                .borrow_mut()
                .pop()
                .expect("active telemetry transaction")
        });
        self.active = false;
        EffectSet(events)
    }
}
