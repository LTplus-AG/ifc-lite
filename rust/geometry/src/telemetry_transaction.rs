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
pub(crate) struct Transaction {
    active: bool,
    _same_thread: PhantomData<Rc<()>>,
}

impl Transaction {
    pub(crate) fn new() -> Self {
        PENDING.with(|pending| pending.borrow_mut().push(Vec::new()));
        Self {
            active: true,
            _same_thread: PhantomData,
        }
    }

    pub(crate) fn commit(mut self) {
        let events = PENDING.with(|pending| {
            let mut pending = pending.borrow_mut();
            let events = pending.pop().expect("active telemetry transaction");
            if let Some(parent) = pending.last_mut() {
                parent.extend(events);
                Vec::new()
            } else {
                events
            }
        });
        self.active = false;
        for event in events {
            event();
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
