// SPDX-License-Identifier: MPL-2.0
//! Test-only monotonic clock behind the existing test-support feature.
//! Installed before the REAL public entry; production exposes no clock setter.
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
#[derive(Debug, Default)]
pub struct Clock {
    elapsed: AtomicU64,
    trigger: Mutex<Option<Trigger>>,
}
#[derive(Debug)]
struct Trigger {
    point: &'static str,
    remaining: usize,
    milliseconds: u64,
}
thread_local! { static CLOCK: RefCell<Option<Arc<Clock>>> = const { RefCell::new(None) }; }
impl Clock {
    pub fn advance(&self, milliseconds: u64) {
        self.elapsed.fetch_add(milliseconds, Ordering::Relaxed);
    }
    pub fn expire_at(&self, point: &'static str, occurrence: usize, milliseconds: u64) {
        assert!(occurrence > 0);
        *self.trigger.lock().unwrap() = Some(Trigger {
            point,
            remaining: occurrence,
            milliseconds,
        });
    }
    pub(super) fn elapsed(&self) -> u64 {
        self.elapsed.load(Ordering::Relaxed)
    }
}
pub fn scope<T>(run: impl FnOnce(Arc<Clock>) -> T) -> T {
    struct Restore(Option<Arc<Clock>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CLOCK.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let clock = Arc::new(Clock::default());
    let _restore = Restore(CLOCK.with(|slot| slot.replace(Some(clock.clone()))));
    run(clock)
}
pub fn point(point: &str) {
    CLOCK.with(|slot| {
        if let Some(clock) = slot.borrow().as_ref() {
            let mut trigger = clock.trigger.lock().unwrap();
            if let Some(trigger) = trigger.as_mut().filter(|trigger| trigger.point == point) {
                trigger.remaining = trigger.remaining.saturating_sub(1);
                if trigger.remaining == 0 {
                    clock.advance(trigger.milliseconds);
                    trigger.milliseconds = 0;
                }
            }
        }
    });
}
pub(super) fn capture() -> Option<(Arc<Clock>, u64)> {
    CLOCK.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|clock| (clock.clone(), clock.elapsed()))
    })
}
