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
    #[wasm_bindgen(js_name = exportStep)]
    pub fn export_step(&self, content: String, schema: String, included: &[u32]) -> String {
        let opts = ifc_lite_export::StepOptions {
            schema: if schema.is_empty() { None } else { Some(schema) },
            included: if included.is_empty() { None } else { Some(included.to_vec()) },
            ..Default::default()
        };
        ifc_lite_export::export_step(content.as_bytes(), &opts)
    }
}
