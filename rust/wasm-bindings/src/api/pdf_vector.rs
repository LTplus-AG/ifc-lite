// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::pdf_vector::{prepare_pdf_vector_page, PdfVectorPage};
use wasm_bindgen::prelude::*;
fn prepare_json(input: &str) -> Result<Vec<u8>, String> {
    if input.len() > 32 * 1024 * 1024 {
        return Err("PDF vector request exceeds 32 MiB".into());
    }
    let page: PdfVectorPage =
        serde_json::from_str(input).map_err(|e| format!("Invalid PDF vector display list: {e}"))?;
    let report = prepare_pdf_vector_page(&page)?;
    serde_json::to_vec(&report).map_err(|e| format!("Cannot encode PDF vector report: {e}"))
}
#[wasm_bindgen]
impl IfcAPI {
    /// Prepare bounded ordered PDF vector graphics states. No IFC entities or
    /// flattened geometry are produced; unsupported content prevents qualification.
    #[wasm_bindgen(js_name = preparePdfVectorPage)]
    pub fn prepare_pdf_vector_page(&self, request_json: &str) -> Result<Vec<u8>, JsError> {
        prepare_json(request_json).map_err(|message| JsError::new(&message))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_4406_pdf_vector_boundary_is_strict_and_bounded() {
        assert!(prepare_json("{}")
            .unwrap_err()
            .contains("Invalid PDF vector"));
        assert!(prepare_json(&" ".repeat(32 * 1024 * 1024 + 1))
            .unwrap_err()
            .contains("32 MiB"));
    }
}
