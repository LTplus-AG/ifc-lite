// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: diagnose_geometry — run the geometry pass and return ONLY its typed
//! CSG / opening diagnostics (the `GeometryDiagnostics` contract).
//!
//! This drives the unified `process_geometry` pass (wasm-safe via its clock shim)
//! and returns `ProcessingStats.geometry_diagnostics`, so the CLI / SDK surface the
//! exact same contract the WASM batch loader and the native server produce. The
//! meshes themselves are discarded — only the diagnostics cross the FFI boundary.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Run geometry extraction on `content` and return its typed CSG / opening
    /// diagnostics (the `GeometryDiagnostics` contract) as a JS object, or
    /// `undefined` when nothing diagnostic-worthy happened (no openings, no
    /// failures). Takes the raw IFC bytes (`Uint8Array`) so there is no input-size
    /// cap. The produced meshes are dropped; only the diagnostics are returned.
    #[wasm_bindgen(js_name = diagnoseGeometry)]
    pub fn diagnose_geometry(&self, content: &[u8]) -> JsValue {
        let result = ifc_lite_processing::process_geometry(&content);
        match result.stats.geometry_diagnostics.as_ref() {
            Some(d) => serde_wasm_bindgen::to_value(d).unwrap_or(JsValue::UNDEFINED),
            None => JsValue::UNDEFINED,
        }
    }
}
