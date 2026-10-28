// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The two host services the browser batch reaches for: a wall clock and the
//! console. On wasm32 they ARE `js_sys::Date::now` and `web_sys::console`, the
//! same calls in the same places. Off wasm32 those imports have no
//! implementation and panic, which is what kept `produce_batch` out of native
//! `cargo test`; there the clock is `Instant` and console lines go to stderr.
//! Geometry, cache use and diagnostic draining never depend on the host. This
//! is what lets the C4-0 parity gate (#7782, `batch_parity_tests.rs`) run the
//! production batch natively.

pub(super) struct BatchClock {
    #[cfg(target_arch = "wasm32")]
    started_ms: f64,
    #[cfg(not(target_arch = "wasm32"))]
    started: std::time::Instant,
}

impl BatchClock {
    pub(super) fn start() -> Self {
        Self {
            #[cfg(target_arch = "wasm32")]
            started_ms: js_sys::Date::now(),
            #[cfg(not(target_arch = "wasm32"))]
            started: std::time::Instant::now(),
        }
    }

    pub(super) fn elapsed_ms(self) -> u64 {
        // wasm32 keeps exactly two Date.now reads per batch and the
        // negative-delta clamp (the JS clock is not monotonic).
        #[cfg(target_arch = "wasm32")]
        {
            (js_sys::Date::now() - self.started_ms).max(0.0) as u64
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.started.elapsed().as_millis() as u64
        }
    }
}

pub(in crate::api) fn info(message: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::info_1(&message.into());
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{message}");
}

pub(in crate::api) fn warn(message: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::warn_1(&message.into());
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{message}");
}

/// Layered-wall slicing diagnostics (#563): a quiet success summary, but a
/// per-element warning (id + reason) when a sliceable wall fails to slice — so
/// future regressions surface without spamming healthy loads. Reasons:
/// not-single-unrotated-item / thin-layers-collapsed-to-1 /
/// placement-unresolved / cut-produced-<2 / base-mesh-error. Borrows the
/// batch's single drain; it formats, it never re-takes router state.
pub(super) fn log_layers(layer_diag: &[(u32, &'static str)]) {
    if layer_diag.is_empty() {
        return;
    }
    let sliced = layer_diag
        .iter()
        .filter(|(_, r)| r.starts_with("ok:"))
        .count();
    let not_sliced = layer_diag.len() - sliced;
    if not_sliced == 0 {
        info(&format!(
            "[ifc-lite layers] batch: sliced {} wall(s) into layers",
            sliced
        ));
    } else {
        let detail: Vec<String> = layer_diag
            .iter()
            .filter(|(_, r)| !r.starts_with("ok:"))
            .map(|(id, r)| format!("#{}={}", id, r))
            .collect();
        warn(&format!(
            "[ifc-lite layers] batch: sliced {}, {} NOT sliced — {}",
            sliced,
            not_sliced,
            detail.join(", ")
        ));
    }
}
