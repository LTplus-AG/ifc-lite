// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JS side of `ifc_lite_geometry::progress`: lets a geometry worker post a
//! heartbeat while ONE synchronous batch call is still working, so the host can
//! tell a slow element from a hung call without a wall-clock guess.

use std::cell::{Cell, RefCell};

use js_sys::Function;
use wasm_bindgen::prelude::*;

/// Minimum spacing between two callback invocations. The host's recovery
/// budget is tens of seconds; one heartbeat a second is ample and keeps the
/// callback (a `postMessage`) off every hot path.
const MIN_INTERVAL_MS: f64 = 1_000.0;

// Thread-local on purpose: a JS `Function` is bound to the thread (worker)
// that created it, so only geometry work on the thread that installed the
// callback reports. In the unpublished `threads` (pkg-threaded) build, rayon
// pool threads see no callback and stay silent; their parent call still ticks
// on its own thread between parallel sections.
thread_local! {
    static CALLBACK: RefCell<Option<Function>> = const { RefCell::new(None) };
    static LAST_CALL_MS: Cell<f64> = const { Cell::new(f64::NEG_INFINITY) };
}

fn on_geometry_progress() {
    let now = js_sys::Date::now();
    if now - LAST_CALL_MS.with(Cell::get) < MIN_INTERVAL_MS {
        return;
    }
    LAST_CALL_MS.with(|last| last.set(now));
    CALLBACK.with(|callback| {
        if let Some(callback) = callback.borrow().as_ref() {
            // A heartbeat must never fail the geometry it reports on. A throwing
            // callback is logged and the work continues.
            if let Err(error) = callback.call0(&JsValue::NULL) {
                web_sys::console::warn_2(&JsValue::from_str("[ifc-lite] geometry progress callback threw:"), &error);
            }
        }
    });
}

/// Install (or, with `undefined`, remove) the callback invoked at most once a
/// second while geometry work is in progress inside a WASM call. It runs
/// synchronously inside that call, so it must only do something cheap such as
/// `postMessage`, and must not call back into this module.
#[wasm_bindgen(js_name = setGeometryProgressCallback)]
pub fn set_geometry_progress_callback(callback: Option<Function>) {
    ifc_lite_geometry::progress::set_hook(on_geometry_progress);
    LAST_CALL_MS.with(|last| last.set(f64::NEG_INFINITY));
    CALLBACK.with(|slot| *slot.borrow_mut() = callback);
}
