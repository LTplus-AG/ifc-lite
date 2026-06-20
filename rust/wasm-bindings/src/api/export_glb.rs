// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_glb — IFC render geometry → binary glTF (GLB) bytes.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export the render geometry in `content` as a binary **GLB** (`Uint8Array`).
    ///
    /// `hidden` / `isolated` are express-id visibility filters; `hidden_types_csv` is a
    /// comma-separated list of IFC type names whose class toggle is off (e.g.
    /// `"IfcOpeningElement,IfcSpace"`). `include_metadata` attaches counts + per-node
    /// `expressId`. Per-mesh RTC origin rides the node translation (precision-safe).
    #[wasm_bindgen(js_name = exportGlb)]
    pub fn export_glb(
        &self,
        content: String,
        include_metadata: bool,
        hidden: &[u32],
        isolated: &[u32],
        hidden_types_csv: String,
    ) -> Vec<u8> {
        let hidden_types = hidden_types_csv
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let opts = ifc_lite_export::GltfOptions {
            include_metadata,
            hidden: hidden.to_vec(),
            isolated: isolated.to_vec(),
            hidden_types,
        };
        ifc_lite_export::export_glb(content.as_bytes(), &opts)
    }
}
