// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: IFC terrain → LandXML 1.2 surface export (#7600, options #7618).

use super::IfcAPI;
use ifc_lite_export::{LandXmlLinearUnit, LandXmlTerrainOptions};
use js_sys::{Array, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "LandXmlTerrainOptionsJs")]
    pub type LandXmlTerrainOptionsJs;
}

#[wasm_bindgen(typescript_custom_section)]
const LANDXML_TERRAIN_TYPES: &str = r#"
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

// Read field by field with `Reflect` rather than a serde derive: the options
// are a handful of scalars, and the derive cost 734 B of brotli (measured) in
// an engine bundle held by the perf ratchet (#7618).
fn field(options: &JsValue, name: &str) -> Result<Option<JsValue>, JsError> {
    let value = Reflect::get(options, &JsValue::from_str(name))
        .map_err(|_| JsError::new(&format!("exportLandXmlTerrain options.{name} cannot be read")))?;
    Ok((!value.is_undefined() && !value.is_null()).then_some(value))
}

fn text(options: &JsValue, name: &str) -> Result<Option<String>, JsError> {
    field(options, name)?
        .map(|value| value.as_string().ok_or_else(|| JsError::new(&format!("exportLandXmlTerrain options.{name} must be a string"))))
        .transpose()
}

fn read_options(options: &JsValue) -> Result<LandXmlTerrainOptions, JsError> {
    if !options.is_object() {
        return Err(JsError::new("exportLandXmlTerrain options must be an object"));
    }
    let required = |name: &str| text(options, name)?.ok_or_else(|| JsError::new(&format!("exportLandXmlTerrain options.{name} is required")));
    let mut out = LandXmlTerrainOptions::new(required("date")?, required("time")?);
    if let Some(unit) = text(options, "linearUnit")? {
        out.linear_unit = match unit.as_str() {
            "metre" => LandXmlLinearUnit::Metre,
            "internationalFoot" => LandXmlLinearUnit::InternationalFoot,
            "usSurveyFoot" => LandXmlLinearUnit::UsSurveyFoot,
            other => return Err(JsError::new(&format!("exportLandXmlTerrain options.linearUnit {other:?} is not 'metre', 'internationalFoot' or 'usSurveyFoot'"))),
        };
    }
    if let Some(decimals) = field(options, "decimals")? {
        out.decimals = decimals.as_f64().filter(|value| value.fract() == 0.0 && (0.0..=255.0).contains(value))
            .ok_or_else(|| JsError::new("exportLandXmlTerrain options.decimals must be a whole number"))? as u8;
    }
    if let Some(names) = field(options, "surfaceNames")? {
        let names = names.dyn_into::<Array>().map_err(|_| JsError::new("exportLandXmlTerrain options.surfaceNames must be an array"))?;
        for entry in names.iter() {
            let id = field(&entry, "productId")?.and_then(|id| id.as_f64())
                .filter(|id| id.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(id))
                .ok_or_else(|| JsError::new("exportLandXmlTerrain options.surfaceNames[].productId must be an express id"))?;
            let name = text(&entry, "name")?.ok_or_else(|| JsError::new("exportLandXmlTerrain options.surfaceNames[].name is required"))?;
            out.surface_names.insert(id as u32, name);
        }
    }
    Ok(out)
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
        let options = read_options(&options.into())?;
        let export = ifc_lite_export::try_export_landxml_terrain(content, &product_ids, &options)
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&export)
            .map_err(|error| JsError::new(&format!("exportLandXmlTerrain: {error}")))
    }
}
