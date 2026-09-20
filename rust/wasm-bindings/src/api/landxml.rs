// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Raw-byte LandXML ingestion binding.
//!
//! XML decoding belongs to `ifc-lite-landxml`: taking a `Uint8Array` prevents
//! callers from accidentally decoding UTF-16 source as JavaScript text first.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse a LandXML 1.2 TIN document from its original bytes.
    ///
    /// The object is an owned serialization of the semantic document. Errors
    /// deliberately use `LandXmlError::Display`, including its stable LXML code.
    #[wasm_bindgen(js_name = parseLandXmlTinBytes)]
    pub fn parse_landxml_tin_bytes(&self, data: &[u8]) -> Result<JsValue, JsValue> {
        let document = ifc_lite_landxml::parse_landxml_tin(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        serde_wasm_bindgen::to_value(&document).map_err(|error| {
            JsValue::from_str(&format!("LandXML result serialization failed: {error}"))
        })
    }
}
