// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_dfjson — IFC → Dragonfly DFJSON (energy model) string.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export the `IfcSpace` volumes in `content` as a Dragonfly **DFJSON** string.
    ///
    /// Each space becomes an extruded `Room2D` (floor polygon + floor-to-ceiling height)
    /// grouped into stories — the simpler Ladybug Tools target for mostly-vertical-wall
    /// models. Loads via `dragonfly.model.Model.from_dfjson`.
    ///
    /// ```javascript
    /// const api = new IfcAPI();
    /// const dfjson = api.exportDfjson(ifcContent, "my_model");
    /// ```
    #[wasm_bindgen(js_name = exportDfjson)]
    pub fn export_dfjson(&self, content: &[u8], name: String) -> String {
        let opts = ifc_lite_export::DfjsonOptions { name, tolerance: 0.01 };
        ifc_lite_export::export_dfjson(content, &opts)
    }
}
