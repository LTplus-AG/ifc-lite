// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::appearance::{plan_mesh_transfer, MeshTransferRequest};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Registered mesh observations over canonical target albedo. Host verifies
    /// original GLB identity against decoded source mesh/image and freezes frames.
    /// Run in an owned cancellable worker. IFPA output adds `transfer` coverage;
    /// `plan` is null when no sample is observed. Never infer accuracy approval.
    #[wasm_bindgen(js_name = planMeshTransfer)]
    pub fn plan_mesh_transfer(
        &self,
        content: &[u8],
        request_json: &str,
        rgba: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        transfer_output(content, request_json, rgba).map_err(|e| JsError::new(&e))
    }
}
fn transfer_output(content: &[u8], request_json: &str, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if request_json.len() > 64 * 1024 * 1024 {
        return Err("Transfer decoded mesh request exceeds 64 MiB".into());
    }
    let request: MeshTransferRequest =
        serde_json::from_str(request_json).map_err(|e| format!("Invalid transfer request: {e}"))?;
    let result = plan_mesh_transfer(content, &request, rgba)?;
    super::appearance_atlas::encode_atlas(
        result.output.as_ref(),
        result.texels_per_metre,
        &serde_json::json!({"transfer":result.transfer}),
    )
}
