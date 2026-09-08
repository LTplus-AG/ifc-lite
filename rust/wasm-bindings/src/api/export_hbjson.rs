// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_hbjson — IFC → Honeybee HBJSON (energy/daylight model) string.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export the `IfcSpace` volumes in `content` as Honeybee **HBJSON** UTF-8 bytes.
    ///
    /// Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
    /// V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
    /// is genuinely needed.
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
    pub fn export_hbjson(&self, content: &[u8], name: String) -> Vec<u8> {
        let opts = ifc_lite_export::HbjsonOptions { name, tolerance: 0.01 };
        ifc_lite_export::export_hbjson(content, &opts).into_bytes()
    }

    /// Like [`Self::export_hbjson`], but also returns the export's coverage stats
    /// (`HbjsonStats`: spaces seen, rooms emitted, spaces skipped as degenerate, plus
    /// apertures / doors / shades / constructions / interior adjacencies) so a caller
    /// can tell whether the "success" result silently dropped input.
    ///
    /// Returns a plain JS object `{ content: Uint8Array, stats: HbjsonStats }`; `content`
    /// is UTF-8 HBJSON bytes (same encoding rationale as [`Self::export_hbjson`] — not
    /// capped by the V8 max-string ceiling). Runs the export once — `content` and `stats`
    /// come from the same pass, not two separate exports.
    ///
    /// ```javascript
    /// const api = new IfcAPI();
    /// const { content, stats } = api.exportHbjsonWithStats(ifcContent, "my_model");
    /// if (stats.skipped > 0) console.warn(`${stats.skipped} spaces skipped as degenerate`);
    /// ```
    #[wasm_bindgen(js_name = exportHbjsonWithStats)]
    pub fn export_hbjson_with_stats(&self, content: &[u8], name: String) -> JsValue {
        let opts = ifc_lite_export::HbjsonOptions { name, tolerance: 0.01 };
        let (json, stats) = ifc_lite_export::export_hbjson_with_stats(content, &opts);
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("content"),
            &js_sys::Uint8Array::from(json.as_bytes()),
        );
        let _ = js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("stats"),
            &serde_wasm_bindgen::to_value(&stats).unwrap_or(JsValue::UNDEFINED),
        );
        obj.into()
    }
}
