// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::pdf_vector::{prepare_pdf_vector_page, PdfVectorPage};
use wasm_bindgen::prelude::*;
use ifc_lite_processing::appearance::{plan_pdf_fill_annotation, PdfFillAnnotationRequest};
fn prepare_json(input: &str) -> Result<Vec<u8>, String> {
    if input.len() > 32 * 1024 * 1024 {
        return Err("PDF vector request exceeds 32 MiB".into());
    }
    let page: PdfVectorPage =
        serde_json::from_str(input).map_err(|e| format!("Invalid PDF vector display list: {e}"))?;
    let report = prepare_pdf_vector_page(&page)?;
    serde_json::to_vec(&report).map_err(|e| format!("Cannot encode PDF vector report: {e}"))
}
fn plan_json(source:&[u8],input:&str)->Result<Vec<u8>,String> {
    if source.len()>128*1024*1024 || input.len()>32*1024*1024 {return Err("PDF annotation source/request exceeds byte budget".into());}
    let request:PdfFillAnnotationRequest=serde_json::from_str(input).map_err(|e|format!("Invalid PDF fill annotation request: {e}"))?;
    serde_json::to_vec(&plan_pdf_fill_annotation(source,&request)?).map_err(|e|format!("Cannot encode PDF fill annotation: {e}"))
}
#[wasm_bindgen]
impl IfcAPI {
    /// Plan an opaque polygonal PDF fill page as canonical IfcAnnotation
    /// geometry with a provenance property set. An exact page plans directly; a
    /// page with visible omissions needs the accepted fidelity report digest.
    #[wasm_bindgen(js_name = planPdfFillAnnotation)]
    pub fn plan_pdf_fill_annotation(&self, source:&[u8], request_json:&str)->Result<Vec<u8>,JsError> {
        plan_json(source,request_json).map_err(|message|JsError::new(&message))
    }

    /// Prepare bounded ordered PDF vector graphics states and the page fidelity
    /// report (convertible paths, omissions with extent, exact/raster-only).
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
