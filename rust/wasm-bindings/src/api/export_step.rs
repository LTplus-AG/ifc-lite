// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_step — re-serialize the parsed model to STEP/IFC (ISO-10303-21).

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Re-serialize the model in `content` to a STEP/IFC string.
    ///
    /// `schema` is the FILE_SCHEMA label to write (empty ⇒ preserve the source schema).
    /// `included` is an express-id allowlist (empty ⇒ whole model); when set, the forward
    /// `#`-reference closure is added so the subset never dangles a reference.
    /// `mutations_json` carries `MutablePropertyView` edits (attribute updates +
    /// property-set synthesis); empty ⇒ none. See `export_step_json` for the shape.
    #[wasm_bindgen(js_name = exportStep)]
    pub fn export_step(
        &self,
        content: &[u8],
        schema: String,
        included: &[u32],
        mutations_json: String,
    ) -> String {
        ifc_lite_export::export_step_json(
            content,
            if schema.is_empty() { None } else { Some(schema) },
            if included.is_empty() { None } else { Some(included.to_vec()) },
            &mutations_json,
        )
    }

    /// Merge several IFC models into one STEP/IFC string. `concatenated` is every model's
    /// bytes laid end-to-end; `lengths[i]` is the byte length of model `i`. The first model
    /// keeps its ids; later models are id-offset and their project unified to the first.
    #[wasm_bindgen(js_name = exportMerged)]
    pub fn export_merged(&self, concatenated: &[u8], lengths: &[u32], schema: String) -> String {
        // Strict segmentation: a malformed `lengths` (overflow, out-of-bounds, or not
        // summing to the buffer) must surface an error rather than silently dropping a
        // model and returning a partial merge.
        let mut models: Vec<&[u8]> = Vec::with_capacity(lengths.len());
        let mut off = 0usize;
        for &len in lengths {
            let end = off.checked_add(len as usize).unwrap_or_else(|| {
                wasm_bindgen::throw_str("exportMerged: segment length overflow")
            });
            if end > concatenated.len() {
                wasm_bindgen::throw_str("exportMerged: segment lengths exceed concatenated buffer");
            }
            models.push(&concatenated[off..end]);
            off = end;
        }
        if off != concatenated.len() {
            wasm_bindgen::throw_str("exportMerged: segment lengths do not cover the whole buffer");
        }
        let opts = ifc_lite_export::MergedOptions {
            schema: if schema.is_empty() { None } else { Some(schema) },
            ..Default::default()
        };
        ifc_lite_export::export_merged(&models, &opts)
    }
}
