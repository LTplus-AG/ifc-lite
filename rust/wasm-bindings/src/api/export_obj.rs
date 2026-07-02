// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_obj — IFC render geometry → Wavefront OBJ string.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export the render geometry in `content` as Wavefront **OBJ** UTF-8 bytes.
    ///
    /// Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
    /// V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
    /// is genuinely needed.
    ///
    /// `hidden` / `isolated` are express-id filters mirroring the viewer's visibility
    /// state (empty `isolated` ⇒ all visible). Instanced type-library shapes are skipped.
    ///
    /// ```javascript
    /// const obj = api.exportObj(ifcContent, true, new Uint32Array(), new Uint32Array());
    /// ```
    #[wasm_bindgen(js_name = exportObj)]
    pub fn export_obj(
        &self,
        content: &[u8],
        include_normals: bool,
        hidden: &[u32],
        isolated: &[u32],
    ) -> Vec<u8> {
        let opts = ifc_lite_export::ObjOptions {
            include_normals,
            hidden: hidden.to_vec(),
            isolated: isolated.to_vec(),
        };
        ifc_lite_export::export_obj(content, &opts).into_bytes()
    }
}
