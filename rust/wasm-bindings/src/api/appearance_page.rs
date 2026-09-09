// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{appearance::{decode_request}, IfcAPI};
use ifc_lite_processing::appearance::{plan_page_appearance, PageAppearanceRequest};
use wasm_bindgen::prelude::*;

fn page_output(content: &[u8], request_json: &str, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let request: PageAppearanceRequest = decode_request(request_json)?;
    let result = plan_page_appearance(content, &request, rgba)?;
    super::appearance_atlas::encode_atlas(Some(&result),result.texels_per_metre,&serde_json::json!({}))
}

#[wasm_bindgen]
impl IfcAPI {
    /// Finite-page composition over original canonical albedo. RGBA is supplied
    /// separately from the bounded JSON request. Result: IFPA magic, little-endian
    /// u32 JSON byte length, metadata JSON, then PNG bytes addressed by metadata.
    /// Run in a cancellable worker; atomically adopt every item asset and IFC edit.
    #[wasm_bindgen(js_name = planPageAppearance)]
    pub fn plan_page_appearance(&self, content: &[u8], request_json: &str, rgba: &[u8]) -> Result<Vec<u8>, JsError> {
        page_output(content, request_json, rgba).map_err(|message| JsError::new(&message))
    }
}
