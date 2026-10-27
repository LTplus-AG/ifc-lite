// SPDX-License-Identifier: MPL-2.0
//! Monotonic deadline clock and platform-independent latch transition. No Date fallback or retained JS callback.
#[cfg(target_arch = "wasm32")]
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(
    inline_js = "export function budgetMonotonicNow() { return globalThis.performance.now(); }"
)]
extern "C" {
    #[wasm_bindgen(catch, js_name = budgetMonotonicNow)]
    fn now_milliseconds() -> Result<f64, JsValue>;
}

/// Clone shares the regression/unavailable latch, not a new clock origin.
#[cfg(target_arch = "wasm32")]
#[derive(Clone, Debug)]
pub(super) struct Instant {
    start: f64,
    last: Arc<AtomicU64>,
}
#[cfg(target_arch = "wasm32")]
impl Instant {
    pub(super) fn now() -> Self {
        let start = sample().unwrap_or(f64::NAN);
        Self {
            start,
            last: Arc::new(AtomicU64::new(start.to_bits())),
        }
    }

    pub(super) fn elapsed(&self) -> Option<Duration> {
        let now = sample().unwrap_or(f64::NAN);
        // A lost/regressing clock remains unusable even if the host repairs it.
        // Positive finite f64 bit order matches numeric order.
        let accepted = self
            .last
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |bits| {
                Some(accept(f64::from_bits(bits), now).to_bits())
            })
            .ok()?;
        if !accept(f64::from_bits(accepted), now).is_finite() {
            return None;
        }
        Duration::try_from_secs_f64((now - self.start) / 1000.).ok()
    }
}

#[cfg(target_arch = "wasm32")]
fn sample() -> Option<f64> {
    now_milliseconds()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.)
}

fn accept(previous: f64, now: f64) -> f64 {
    if previous.is_finite() && previous >= 0. && now.is_finite() && now >= previous {
        now
    } else {
        f64::NAN
    }
}

#[cfg(test)]
mod tests {
    use super::accept;

    // #7955: a failed or regressing clock stays latched across later samples.
    #[test]
    fn budget_clock_accepts_progress_and_latches_failure() {
        assert_eq!(accept(0., 0.), 0.);
        assert_eq!(accept(10., 10.25), 10.25);
        for bad in [9., -1., f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let failed = accept(10., bad);
            assert!(failed.is_nan());
            assert!(accept(failed, 11.).is_nan());
        }
        assert!(accept(-1., 0.).is_nan());
        assert!(accept(f64::INFINITY, 11.).is_nan());
    }
}
