// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::pdf_vector::{prepare_pdf_vector_page_with_clip, PdfVectorPage};
use wasm_bindgen::prelude::*;
use ifc_lite_processing::appearance::{plan_pdf_fill_annotation_with_clip, PdfFillAnnotationRequest};

fn take_clip(value: &mut serde_json::Value) -> Result<Option<[f64; 4]>, String> {
    let Some(object) = value.as_object_mut() else {
        return Err("PDF vector page must be an object".into());
    };
    match object.remove("conversionClipPdf") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(clip) => serde_json::from_value(clip)
            .map(Some)
            .map_err(|e| format!("Invalid PDF conversion clip: {e}")),
    }
}

fn prepare_json(input: &str) -> Result<Vec<u8>, String> {
    if input.len() > 32 * 1024 * 1024 {
        return Err("PDF vector request exceeds 32 MiB".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_str(input).map_err(|e| format!("Invalid PDF vector display list: {e}"))?;
    let clip = take_clip(&mut value)?;
    let page: PdfVectorPage = serde_json::from_value(value)
        .map_err(|e| format!("Invalid PDF vector display list: {e}"))?;
    let report = prepare_pdf_vector_page_with_clip(&page, clip)?;
    serde_json::to_vec(&report).map_err(|e| format!("Cannot encode PDF vector report: {e}"))
}
fn parse_plan_input(input: &str) -> Result<(PdfFillAnnotationRequest, Option<[f64; 4]>), String> {
    let mut value:serde_json::Value=serde_json::from_str(input).map_err(|e|format!("Invalid PDF fill annotation request: {e}"))?;
    let page=value.get_mut("page").ok_or("Invalid PDF fill annotation request: missing page")?;
    let clip=take_clip(page)?;
    let request=serde_json::from_value(value).map_err(|e|format!("Invalid PDF fill annotation request: {e}"))?;
    Ok((request,clip))
}
fn plan_json(source:&[u8],input:&str)->Result<Vec<u8>,String> {
    if source.len()>128*1024*1024 || input.len()>32*1024*1024 {return Err("PDF annotation source/request exceeds byte budget".into());}
    let (request,clip)=parse_plan_input(input)?;
    serde_json::to_vec(&plan_pdf_fill_annotation_with_clip(source,&request,clip)?).map_err(|e|format!("Cannot encode PDF fill annotation: {e}"))
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

    #[test]
    fn issue_4406_wire_clip_is_separate_from_the_public_rust_page_shape() {
        let page = serde_json::json!({
            "pdfSha256": "a".repeat(64),
            "decoderVersion": "6.3.289",
            "pdfFormatVersion": "2.0",
            "pageNumber": 1,
            "viewBox": [0.0, 0.0, 100.0, 100.0],
            "conversionClipPdf": [10.0, 20.0, 30.0, 40.0],
            "userUnit": 1.0,
            "intrinsicRotation": 0,
            "modelMetresFromPdf": [0.01, 0.0, 0.0, 0.01, 0.0, 0.0],
            "calibrationKey": "wire-clip",
            "toleranceMetres": 0.001,
            "operations": []
        });
        let encoded = prepare_json(&page.to_string()).unwrap();
        let prepared: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(prepared["pageClipPdf"], serde_json::json!([10.0, 20.0, 30.0, 40.0]));

        let request = serde_json::json!({
            "schema": "IFC4",
            "sourceRevision": "wire-clip",
            "nextExpressId": 100,
            "containerId": 1,
            "GlobalId": "0aaaaaaaaaaaaaaaaaaaaa",
            "containmentGlobalId": "0bbbbbbbbbbbbbbbbbbbbb",
            "propertySetGlobalId": "0cccccccccccccccccccc1",
            "propertyRelationGlobalId": "0cccccccccccccccccccc2",
            "Name": "PDF plan",
            "frame": {
                "origin": [0.0, 0.0, 0.0],
                "axisU": [1.0, 0.0, 0.0],
                "axisV": [0.0, 1.0, 0.0],
                "sizeMetres": [1.0, 1.0]
            },
            "page": page
        });
        let (parsed, clip) = parse_plan_input(&request.to_string()).unwrap();
        assert_eq!(clip, Some([10.0, 20.0, 30.0, 40.0]));
        assert_eq!(parsed.page.view_box, [0.0, 0.0, 100.0, 100.0]);
    }
}
