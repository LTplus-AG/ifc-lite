// SPDX-License-Identifier: MPL-2.0
//! Test-thread configuration, isolated from production process profiles.
use std::{cell::Cell, marker::PhantomData};
use super::{COUNT, OP_CAP, ELEM_COUNT, ELEM_CAP};

// Other fixture diagnostic/reset channels still use this serialization lock.
pub(crate) static GLOBAL_CAP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
type Config = (Option<u64>, Option<u64>);
thread_local! { static CONFIG: Cell<Option<Config>> = const { Cell::new(None) }; }

pub(crate) struct Scope {
    prior: Option<Config>,
    counters: (u64,u64,u64,u64),
    _thread_bound: PhantomData<*const ()>,
}
/// Snapshot only this test thread. A spawned worker must install its own scope.
pub(crate) fn scope() -> Scope {
    let prior = CONFIG.with(Cell::get);
    let config = (super::cap(), super::element_cap());
    CONFIG.with(|slot| slot.set(Some(config)));
    Scope { prior, counters: (COUNT.with(Cell::get), OP_CAP.with(Cell::get),
        ELEM_COUNT.with(Cell::get), ELEM_CAP.with(Cell::get)), _thread_bound: PhantomData }
}
impl Drop for Scope {
    fn drop(&mut self) {
        CONFIG.with(|slot| slot.set(self.prior));
        COUNT.with(|slot| slot.set(self.counters.0));
        OP_CAP.with(|slot| slot.set(self.counters.1));
        ELEM_COUNT.with(|slot| slot.set(self.counters.2));
        ELEM_CAP.with(|slot| slot.set(self.counters.3));
    }
}
pub(crate) fn set_cap(cap: Option<u64>) {
    CONFIG.with(|slot| { let mut config=slot.get().expect("test cap requires a scope");
        config.0=cap.filter(|value| *value != 0); slot.set(Some(config)); });
}
pub(crate) fn set_element_cap(cap: Option<u64>) {
    CONFIG.with(|slot| { let mut config=slot.get().expect("test cap requires a scope");
        config.1=cap.filter(|value| *value != 0); slot.set(Some(config)); });
}
pub(super) fn configured_operation() -> Option<Option<u64>> { CONFIG.with(|slot|slot.get().map(|v|v.0)) }
pub(super) fn configured_element() -> Option<Option<u64>> { CONFIG.with(|slot|slot.get().map(|v|v.1)) }
pub(super) fn operation(fallback:u64) -> u64 { configured_operation().map_or(fallback,|v|v.unwrap_or(0)) }
pub(super) fn unbounded(fallback:bool) -> bool { configured_operation().map_or(fallback,|v|v.is_none()) }
pub(super) fn element(fallback:u64, unbounded:bool) -> u64 {
    if unbounded {0} else {configured_element().map_or(fallback,|v|v.unwrap_or(0))}
}

#[cfg(test)]
#[path = "budget_test_caps_tests.rs"]
mod tests;
