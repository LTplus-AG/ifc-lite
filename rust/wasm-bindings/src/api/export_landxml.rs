// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: IFC terrain → LandXML 1.2 surface export (#7600, options #7618).

use super::IfcAPI;
use ifc_lite_export::{LandXmlLinearUnit, LandXmlTerrainOptions};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "LandXmlTerrainOptionsJs")]
    pub type LandXmlTerrainOptionsJs;
}

#[wasm_bindgen(typescript_custom_section)]
const LANDXML_TERRAIN_TYPES: &str = r#"
/** Unknown fields are refused. */
export interface LandXmlTerrainOptionsJs {
  /** `YYYY-MM-DD`, the required `LandXML@date`; the caller owns the clock. */
  date: string;
  /** `HH:MM:SS`, the required `LandXML@time`. */
  time: string;
  /** Default `'metre'`. US survey feet write elevations in international feet (LandXML 1.2 has no US-survey-foot elevation unit); both are declared. */
  linearUnit?: 'metre' | 'internationalFoot' | 'usSurveyFoot';
  /** Decimal places in the written unit, 0 to 9. Default 6. */
  decimals?: number;
  /** `Surface@name` per product; a blank name keeps the IFC name. */
  surfaceNames?: { productId: number; name: string }[];
}
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OptionsInput {
    date: String,
    time: String,
    // Each optional field is an `Option`, not `#[serde(default)]`: a JS
    // caller passing `undefined` reaches serde as a present unit value, which
    // only `Option` accepts.
    linear_unit: Option<LandXmlLinearUnit>,
    decimals: Option<u8>,
    surface_names: Option<Vec<SurfaceName>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceName {
    product_id: u32,
    name: String,
}

#[wasm_bindgen]
impl IfcAPI {
    /// Export the terrain products `product_ids` (express ids) of `content` as
    /// one LandXML 1.2 document, one `<Surface>` each.
    ///
    /// Returns JSON `{ xml, crsName, surfaces: [{ productId, globalId, name,
    /// points, faces }] }`. A selection that is not an authored triangulated
    /// terrain, or whose georeferencing is missing or ambiguous, throws an
    /// `Error` whose message starts with `TERRAIN_REFUSED:` and names the
    /// reason.
    #[wasm_bindgen(js_name = exportLandXmlTerrain)]
    pub fn export_landxml_terrain(
        &self,
        content: &[u8],
        product_ids: Vec<u32>,
        options: LandXmlTerrainOptionsJs,
    ) -> Result<String, JsError> {
        let input: OptionsInput = serde_wasm_bindgen::from_value(options.into())
            .map_err(|error| JsError::new(&format!("exportLandXmlTerrain options: {error}")))?;
        let mut options = LandXmlTerrainOptions::new(input.date, input.time);
        options.linear_unit = input.linear_unit.unwrap_or_default();
        if let Some(decimals) = input.decimals {
            options.decimals = decimals;
        }
        options.surface_names = input.surface_names.unwrap_or_default().into_iter().map(|entry| (entry.product_id, entry.name)).collect();
        let export = ifc_lite_export::try_export_landxml_terrain(content, &product_ids, &options)
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&export)
            .map_err(|error| JsError::new(&format!("exportLandXmlTerrain: {error}")))
    }
}
