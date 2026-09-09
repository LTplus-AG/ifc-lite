// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{appearance::{decode_request, encode_bounded}, IfcAPI};
use ifc_lite_processing::appearance::{plan_captured_mesh, CapturedMeshRequest};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Create a captured textured surface through canonical native geometry.
    /// Input is CapturedMeshRequest; output UTF-8 CapturedMeshPlan JSON.
    /// Does not mutate the IFC snapshot or decode the host-owned image.
    #[wasm_bindgen(js_name = planCapturedMesh)]
    pub fn plan_captured_mesh(&self, content: &[u8], request_json: &str) -> Result<Vec<u8>, JsError> {
        let result=(|| {
            let request: CapturedMeshRequest=decode_request(request_json)?;
            encode_bounded(&plan_captured_mesh(content,&request)?)
        })();
        result.map_err(|message: String|JsError::new(&message))
    }
}
