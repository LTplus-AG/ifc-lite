// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{appearance::{decode_request, encode_bounded}, IfcAPI};
use ifc_lite_processing::appearance::{plan_annotation_plane, AnnotationPlaneRequest};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Create a calibrated image annotation through canonical native geometry.
    /// Input is AnnotationPlaneRequest; output UTF-8 AnnotationPlanePlan JSON.
    /// Does not mutate the IFC snapshot or decode the host-owned image.
    #[wasm_bindgen(js_name = planAnnotationPlane)]
    pub fn plan_annotation_plane(&self, content: &[u8], request_json: &str) -> Result<Vec<u8>, JsError> {
        let result=(|| {
            let request: AnnotationPlaneRequest=decode_request(request_json)?;
            encode_bounded(&plan_annotation_plane(content,&request)?)
        })();
        result.map_err(|message: String|JsError::new(&message))
    }
}
