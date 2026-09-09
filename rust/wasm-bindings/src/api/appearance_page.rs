// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{appearance::{decode_request, encode_bounded}, IfcAPI};
use ifc_lite_processing::appearance::{plan_page_appearance, AppearancePlan, AppearanceItemImage, PageAppearanceRequest};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn page_output(content: &[u8], request_json: &str, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let request: PageAppearanceRequest = decode_request(request_json)?;
    let result = plan_page_appearance(content, &request, rgba)?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Asset<'a> { image_uri: &'a str, width: u32, height: u32, byte_offset: usize, byte_length: usize }
    let mut offset = 0usize;
    let assets: Vec<_> = result.assets.iter().map(|asset| {
        let metadata = Asset { image_uri: &asset.image_uri, width: asset.width, height: asset.height,
            byte_offset: offset, byte_length: asset.png.len() };
        offset += asset.png.len(); metadata
    }).collect();
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata<'a> { plan: &'a AppearancePlan, item_images: &'a [AppearanceItemImage], assets: &'a [Asset<'a>], texels_per_metre: f64 }
    let metadata = encode_bounded(&Metadata { plan: &result.plan, item_images: &result.item_images,
        assets: &assets, texels_per_metre: result.texels_per_metre })?;
    let size = 8usize.checked_add(metadata.len()).and_then(|v| v.checked_add(offset)).ok_or("Page output length overflow")?;
    if size > 160 * 1024 * 1024 { return Err("Page output exceeds 160 MiB transport budget".into()); }
    let mut output = Vec::with_capacity(size);
    output.extend_from_slice(b"IFPA"); output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    output.extend_from_slice(&metadata);
    for asset in result.assets { output.extend_from_slice(&asset.png); }
    Ok(output)
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
