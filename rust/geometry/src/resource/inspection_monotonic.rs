// SPDX-License-Identifier: MPL-2.0
//! WASM-only monotonic deadline clock. No Date fallback or retained JS callback.
use std::{sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = "export function inspectionMonotonicNow() { return globalThis.performance.now(); }")]
extern "C" {
    #[wasm_bindgen(catch, js_name = inspectionMonotonicNow)]
    fn now_milliseconds() -> Result<f64, JsValue>;
}

/// Clone shares the regression/unavailable latch, not a new clock origin.
#[derive(Clone, Debug)]
pub(super) struct Instant {
    start: f64,
    last: Arc<AtomicU64>,
}
impl Instant {
    pub(super) fn now() -> Self {
        let start = sample().unwrap_or(f64::NAN);
        Self { start, last: Arc::new(AtomicU64::new(start.to_bits())) }
    }

    pub(super) fn elapsed(&self) -> Option<Duration> {
        let now = sample().unwrap_or(f64::NAN);
        // A lost/regressing clock remains unusable even if the host repairs it.
        // Positive finite f64 bit order matches numeric order.
        let accepted = self.last.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |bits| {
            let previous = f64::from_bits(bits);
            Some(if previous.is_finite() && now.is_finite() && now >= previous {
                now.to_bits()
            } else { f64::NAN.to_bits() })
        }).expect("update always supplies a value");
        if !f64::from_bits(accepted).is_finite() || !now.is_finite()
            || now < f64::from_bits(accepted) {
            return None;
        }
        Duration::try_from_secs_f64((now - self.start) / 1000.).ok()
    }
}

fn sample() -> Option<f64> {
    now_milliseconds().ok().filter(|value| value.is_finite() && *value >= 0.)
}
