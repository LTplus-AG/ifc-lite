// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: CityJSON 2.0 / CityJSONSeq export.

use super::IfcAPI;
use ifc_lite_export::CityJsonOptions;
use js_sys::{Array, Object, Reflect};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "CityJsonOptionsJs")]
    pub type CityJsonOptionsJs;
    #[wasm_bindgen(typescript_type = "CityJsonExportJs")]
    pub type CityJsonExportJs;
}

#[wasm_bindgen(typescript_custom_section)]
const CITYJSON_TYPES: &str = r#"
export interface CityJsonOptionsJs {
  /** `transform.scale` in output units (metres for a metric CRS or local output). Default 0.001. */
  scale?: number;
  /** Write rooms and elements with their LoD3 geometry. Default true. */
  elementGeometry?: boolean;
  /** Write CityJSONSeq (`.city.jsonl`) instead of one CityJSON document. Default false. */
  sequence?: boolean;
}
export interface CityJsonExportJs {
  text: string;
  /** `metadata.referenceSystem`, or null for local coordinates. */
  referenceSystem: string | null;
  warnings: string[];
  buildings: number;
  cityObjects: number;
  vertices: number;
}
"#;

// Reflect, not a serde derive: three scalars, and the engine bundle is held
// by the perf ratchet (see export_landxml.rs).
fn field(options: &JsValue, name: &str) -> Result<Option<JsValue>, JsError> {
    let value = Reflect::get(options, &JsValue::from_str(name))
        .map_err(|_| JsError::new(&format!("exportCityJson options.{name} cannot be read")))?;
    Ok((!value.is_undefined() && !value.is_null()).then_some(value))
}

fn flag(options: &JsValue, name: &str) -> Result<Option<bool>, JsError> {
    field(options, name)?
        .map(|v| v.as_bool().ok_or_else(|| JsError::new(&format!("exportCityJson options.{name} must be a boolean"))))
        .transpose()
}

fn read_options(options: &JsValue) -> Result<CityJsonOptions, JsError> {
    let mut out = CityJsonOptions::default();
    if options.is_undefined() || options.is_null() {
        return Ok(out);
    }
    if !options.is_object() {
        return Err(JsError::new("exportCityJson options must be an object"));
    }
    if let Some(scale) = field(options, "scale")? {
        out.scale = scale.as_f64().ok_or_else(|| JsError::new("exportCityJson options.scale must be a number"))?;
    }
    if let Some(v) = flag(options, "elementGeometry")? {
        out.element_geometry = v;
    }
    if let Some(v) = flag(options, "sequence")? {
        out.sequence = v;
    }
    Ok(out)
}

fn set(target: &Object, key: &str, value: impl Into<JsValue>) -> Result<(), JsError> {
    Reflect::set(target, &JsValue::from_str(key), &value.into())
        .map(|_| ())
        .map_err(|_| JsError::new("exportCityJson: result object is not writable"))
}

#[wasm_bindgen]
impl IfcAPI {
    /// Export `content` as CityJSON 2.0 (or CityJSONSeq with `sequence`).
    ///
    /// A model with no `IfcBuilding` throws an `Error` whose message starts
    /// with `CITYJSON_REFUSED:`. Georeferencing that cannot be resolved is not
    /// an error: the document is written in local coordinates and `warnings`
    /// says why.
    #[wasm_bindgen(js_name = exportCityJson)]
    pub fn export_cityjson(&self, content: &[u8], options: CityJsonOptionsJs) -> Result<CityJsonExportJs, JsError> {
        let options = read_options(&options.into())?;
        let export = ifc_lite_export::try_export_cityjson(content, &options).map_err(|e| JsError::new(&e.to_string()))?;
        let out = Object::new();
        set(&out, "text", export.text)?;
        set(&out, "referenceSystem", export.reference_system.map_or(JsValue::NULL, JsValue::from))?;
        set(&out, "warnings", export.warnings.into_iter().map(JsValue::from).collect::<Array>())?;
        set(&out, "buildings", export.buildings as f64)?;
        set(&out, "cityObjects", export.city_objects as f64)?;
        set(&out, "vertices", export.vertices as f64)?;
        Ok(JsValue::from(out).into())
    }
}
