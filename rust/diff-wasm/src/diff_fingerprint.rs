// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{DataFingerprintInput, build_data_fingerprint, build_component_fingerprints, stable_hash_units};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Raw code units preserve JS strings that cannot be represented as Rust UTF-8.
#[wasm_bindgen(js_name = diffStableHash)]
pub fn diff_stable_hash(units: &[u16]) -> String { stable_hash_units(units.iter().copied()) }

/// Hash adapter data directly in Rust without a JSON text round trip.
#[wasm_bindgen(js_name = diffBuildDataFingerprint)]
pub fn diff_build_data_fingerprint(input: JsValue) -> Result<String, JsValue> {
    let input: DataFingerprintInput = serde_wasm_bindgen::from_value(input)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(build_data_fingerprint(&input))
}

/// Component hashes share the canonical Rust attribute projection.
#[wasm_bindgen(js_name = diffBuildComponentFingerprints)]
pub fn diff_build_component_fingerprints(input: JsValue) -> Result<JsValue, JsValue> {
    let input: DataFingerprintInput = serde_wasm_bindgen::from_value(input)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    build_component_fingerprints(&input).serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}
