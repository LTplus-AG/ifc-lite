// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_hbjson — IFC → Honeybee HBJSON (energy/daylight model) string.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export the `IfcSpace` volumes in `content` as a Honeybee **HBJSON** string.
    ///
    /// Rooms are built analytically from extruded-area profiles (watertight by construction);
    /// faces are typed Floor / RoofCeiling / Wall with outward normals. The result loads via
    /// `honeybee.model.Model.from_hbjson` and is ready for Ladybug Tools / Pollination.
    ///
    /// ```javascript
    /// const api = new IfcAPI();
    /// const hbjson = api.exportHbjson(ifcContent, "my_model");
    /// ```
    #[wasm_bindgen(js_name = exportHbjson)]
    pub fn export_hbjson(&self, content: &[u8], name: String) -> String {
        let opts = ifc_lite_export::HbjsonOptions { name, tolerance: 0.01 };
        ifc_lite_export::export_hbjson(content, &opts)
    }
}
