// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: IFC terrain → LandXML 1.2 surface export (#7600).

use super::IfcAPI;
use ifc_lite_export::LandXmlTerrainOptions;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export the terrain products `product_ids` (express ids) of `content` as
    /// one LandXML 1.2 document, one `<Surface>` each.
    ///
    /// Returns JSON `{ xml, crsName, surfaces: [{ productId, globalId, name,
    /// points, faces }] }`. A selection that is not an authored triangulated
    /// terrain, or whose georeferencing is missing or ambiguous, throws an
    /// `Error` whose message starts with `TERRAIN_REFUSED:` and names the
    /// reason. `date` (`YYYY-MM-DD`) and `time` (`HH:MM:SS`) stamp the header:
    /// the caller owns the clock.
    #[wasm_bindgen(js_name = exportLandXmlTerrain)]
    pub fn export_landxml_terrain(
        &self,
        content: &[u8],
        product_ids: Vec<u32>,
        date: String,
        time: String,
    ) -> Result<String, JsError> {
        let options = LandXmlTerrainOptions { date, time };
        let export = ifc_lite_export::try_export_landxml_terrain(content, &product_ids, &options)
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&export)
            .map_err(|error| JsError::new(&format!("exportLandXmlTerrain: {error}")))
    }
}
