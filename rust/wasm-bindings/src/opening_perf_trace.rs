// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Diagnostic-only export; absent from default bindings and their type surface.
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = takeOpeningPerfCounters)]
pub fn take_opening_perf_counters() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&ifc_lite_geometry::opening_perf_trace::take())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}
