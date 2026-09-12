// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::appearance::{
    plan_mesh_transfer, plan_point_transfer, MeshTransferPlan, MeshTransferRequest,
    TransferPointPayload,
};
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
        let request = parse(request_json)?;
        encode(plan_mesh_transfer(content, &request, rgba)).map_err(|e| JsError::new(&e))
    }
    /// Registered RGB point-cloud observations (#4381). `request_json.source`
    /// is `{kind:'points', …}`; `positions` (3n f64, source-frame metres) and
    /// `colors` (3n RGB8) are the payload, `normals` (3n f32, oriented) and
    /// `stations` (n indices into `source.viewpoints`) are empty when absent.
    /// `rgba` carries only the target's existing rasters. Same output as
    /// `planMeshTransfer`; `transfer.source` records the orientation used.
    // Flat typed-array arguments are the wasm-bindgen boundary: each buffer
    // crosses once without a JSON or struct wrapper (as export_glb does).
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = planPointTransfer)]
    pub fn plan_point_transfer(
        &self,
        content: &[u8],
        request_json: &str,
        rgba: &[u8],
        positions: &[f64],
        colors: &[u8],
        normals: &[f32],
        stations: &[u32],
    ) -> Result<Vec<u8>, JsError> {
        let request = parse(request_json)?;
        let payload = TransferPointPayload { positions, colors, normals, stations };
        encode(plan_point_transfer(content, &request, rgba, &payload)).map_err(|e| JsError::new(&e))
    }
}
fn parse(request_json: &str) -> Result<MeshTransferRequest, JsError> {
    if request_json.len() > 64 * 1024 * 1024 {
        return Err(JsError::new("Transfer request exceeds 64 MiB"));
    }
    serde_json::from_str(request_json)
        .map_err(|e| JsError::new(&format!("Invalid transfer request: {e}")))
}
fn encode(result: Result<MeshTransferPlan, String>) -> Result<Vec<u8>, String> {
    let result = result?;
    super::appearance_atlas::encode_atlas(
        result.output.as_ref(),
        result.texels_per_metre,
        &serde_json::json!({"transfer":result.transfer}),
    )
}
