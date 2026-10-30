// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Independently loaded diff engine; no geometry or parser dependencies.
mod diff;
mod diff_binary;
mod diff_fingerprint_binary;
mod diff_class_normalization;
mod diff_fingerprint;
mod diff_fingerprint_input;
mod diff_fingerprint_de;
mod diff_fingerprint_host;
mod diff_sidecar;
mod diff_lineage;
mod diff_provenance;
mod diff_normalize;
mod diff_transport;
mod diff_sidecar_host;
mod diff_sidecar_observe;
mod diff_sidecar_lineage;
mod diff_sidecar_create;
mod diff_sidecar_public;

/// Test-only ownership probe; absent from the default production ABI.
#[cfg(feature = "decode-leak-test")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = diffTestExternrefLiveCount)]
pub fn diff_test_externref_live_count() -> u32 {
    wasm_bindgen::externref_heap_live_count()
}

/// Test-only resident-model ownership probe; absent from the production ABI.
#[cfg(feature = "decode-leak-test")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = diffTestModelLiveCount)]
pub fn diff_test_model_live_count() -> u32 { diff::live_count() }
