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
    /// `hidden` is an express-id filter mirroring the viewer's visibility state.
    /// `isolated` carries the isolation allowlist's null-vs-empty distinction across
    /// the wasm boundary: omit it (`undefined`) for "no isolation filter" (every mesh
    /// is a candidate); pass an empty `Uint32Array` for "isolation is ACTIVE and
    /// currently matches nothing" (every mesh is excluded). Collapsing the two — as a
    /// bare `Uint32Array` parameter would force a caller to do — silently exports the
    /// whole model when a filter matches nothing (the OBJ twin of #4328/#4364, fixed
    /// for GLB in `export_glb`). A non-empty `Uint32Array` is the ordinary allowlist.
    /// Instanced type-library shapes are skipped regardless of the filter.
    ///
    /// ```javascript
    /// const obj = api.exportObj(ifcContent, true, new Uint32Array(), undefined);
    /// ```
    #[wasm_bindgen(js_name = exportObj)]
    pub fn export_obj(
        &self,
        content: &[u8],
        include_normals: bool,
        hidden: &[u32],
        isolated: Option<Vec<u32>>,
    ) -> Vec<u8> {
        let opts = ifc_lite_export::ObjOptions {
            include_normals,
            hidden: hidden.to_vec(),
            isolated,
        };
        ifc_lite_export::export_obj(content, &opts).into_bytes()
    }
}
