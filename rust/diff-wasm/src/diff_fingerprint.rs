// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{build_data_fingerprint, build_component_fingerprint_entries, stable_hash_units};
use wasm_bindgen::prelude::*;

/// Raw code units preserve JS strings that cannot be represented as Rust UTF-8.
#[wasm_bindgen(js_name = diffStableHash)]
pub fn diff_stable_hash(units: &[u16]) -> String { stable_hash_units(units.iter().copied()) }

/// Hash adapter data directly in Rust without a JSON text round trip.
#[wasm_bindgen(js_name = diffBuildDataFingerprint)]
pub fn diff_build_data_fingerprint(input: JsValue) -> Result<String, JsValue> {
    let input = super::diff_fingerprint_input::decode(input)?;
    Ok(build_data_fingerprint(&input))
}

/// Component hashes share the canonical Rust attribute projection.
#[wasm_bindgen(js_name = diffBuildComponentFingerprints)]
pub fn diff_build_component_fingerprints(input: JsValue) -> Result<JsValue, JsValue> {
    let input = super::diff_fingerprint_input::decode(input)?;
    // Raw callers bypass the public facade's staged host iteration (#8042).
    // Enforce the native component precondition with a catchable JS error,
    // never a Rust assertion/panic that would trap the WASM instance.
    if input.property_sets.holes() > 0 || input.quantity_sets.holes() > 0 {
        return Err(js_sys::TypeError::new("Cannot read properties of undefined (reading 'name')").into());
    }
    crate::diff_transport::host_value(&ifc_lite_diff::DocumentValue::Object(
        build_component_fingerprint_entries(&input).into_iter()
            .map(|(key, hash)| (key, ifc_lite_diff::DocumentValue::String(hash.into()))).collect()))
}
