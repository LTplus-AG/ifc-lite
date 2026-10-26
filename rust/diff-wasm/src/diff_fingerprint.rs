// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::fingerprint::{build_component_fingerprint_entries_checked, build_data_fingerprint_checked};
use ifc_lite_diff::stable_hash_units;
use wasm_bindgen::prelude::*;

/// Raw code units preserve JS strings that cannot be represented as Rust UTF-8.
#[wasm_bindgen(js_name = diffStableHash)]
pub fn diff_stable_hash(units: &[u16]) -> String { stable_hash_units(units.iter().copied()) }

/// The host engine's own string-length limit, which the oracle's
/// JSON.stringify would hit for a huge sparse collection (#8114).
fn fits(length: u64) -> Result<(), JsValue> { super::diff_fingerprint_host::string_fits(length as f64) }

/// Hash adapter data directly in Rust without a JSON text round trip.
#[wasm_bindgen(js_name = diffBuildDataFingerprint)]
pub fn diff_build_data_fingerprint(input: JsValue) -> Result<String, JsValue> {
    let input = super::diff_fingerprint_input::decode(input, false)?;
    build_data_fingerprint_checked(&input, fits)
}

/// Facade ordering (#8114): the engine string-length checks of collections the
/// facade has just projected, run where the oracle sorts and hashes them and so
/// before the facade reads the adapter's next field. Never a fingerprint.
#[wasm_bindgen(js_name = diffCheckFingerprintCollections)]
pub fn diff_check_fingerprint_collections(input: JsValue, components: bool) -> Result<(), JsValue> {
    super::diff_fingerprint_input::check_collections(input, components)
}

/// Component hashes share the canonical Rust attribute projection.
#[wasm_bindgen(js_name = diffBuildComponentFingerprints)]
pub fn diff_build_component_fingerprints(input: JsValue) -> Result<JsValue, JsValue> {
    let input = super::diff_fingerprint_input::decode(input, true)?;
    crate::diff_transport::host_value(&ifc_lite_diff::DocumentValue::Object(
        build_component_fingerprint_entries_checked(&input, fits)?.into_iter()
            .map(|(key, hash)| (key, ifc_lite_diff::DocumentValue::String(hash.into()))).collect()))
}
