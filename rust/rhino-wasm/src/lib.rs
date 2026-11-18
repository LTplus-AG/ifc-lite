// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Independently loaded exporters: the Rhino scene builder and CityJSON 2.0.
//! Kept out of the default geometry engine (`ifc-lite-wasm`) so these rarely
//! used exporters never grow the download every viewer load pays for; the
//! payload is fetched only when a .3dm or CityJSON export runs.
use js_sys::{Array, Object, Reflect};
use wasm_bindgen::prelude::*;

/// Encoded Rhino scene. Getters copy data out so the handle can be freed immediately.
// Both values are copied into JS once, when the scene is built; a getter hands
// out the same JS value, so neither read copies wasm memory again.
#[wasm_bindgen]
pub struct RhinoSceneJs {
    manifest: js_sys::JsString,
    blob: js_sys::Uint8Array,
}

#[wasm_bindgen]
impl RhinoSceneJs {
    #[wasm_bindgen(getter)]
    pub fn manifest(&self) -> js_sys::JsString { self.manifest.clone() }
    #[wasm_bindgen(getter)]
    pub fn blob(&self) -> js_sys::Uint8Array { self.blob.clone() }
}

/// Build the shared Rhino scene; archive writing belongs to the adapter.
/// A model with no render geometry throws an `Error` whose message starts with
/// `NO_RENDER_GEOMETRY`, like the default engine's `exportUsd`.
#[wasm_bindgen(js_name = exportRhinoScene)]
pub fn export_rhino_scene(content: &[u8], options_json: &str) -> Result<RhinoSceneJs, JsValue> {
    let options: ifc_lite_export::rhino::RhinoSceneOptions = serde_json::from_str(options_json)
        .map_err(|e| JsValue::from(js_sys::Error::new(&e.to_string())))?;
    let scene = ifc_lite_export::rhino::build_rhino_scene(content, &options)
        .map_err(|e| JsValue::from(js_sys::Error::new(&e.to_string())))?;
    let (manifest, blob) = scene.encode();
    Ok(RhinoSceneJs { manifest: js_sys::JsString::from(manifest), blob: js_sys::Uint8Array::from(blob.as_slice()) })
}

#[wasm_bindgen(typescript_custom_section)]
const CITYJSON_TYPES: &str = r#"
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

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "CityJsonExportJs")]
    pub type CityJsonExportJs;
}

fn js_error(message: &str) -> JsValue {
    JsValue::from(js_sys::Error::new(message))
}

/// `{ scale?: number, elementGeometry?: boolean, sequence?: boolean }`, every
/// field optional; anything else is refused rather than ignored.
fn cityjson_options(options_json: &str) -> Result<ifc_lite_export::CityJsonOptions, JsValue> {
    let mut out = ifc_lite_export::CityJsonOptions::default();
    let value: serde_json::Value = serde_json::from_str(options_json).map_err(|e| js_error(&format!("exportCityJson options: {e}")))?;
    let Some(map) = value.as_object() else {
        return if value.is_null() { Ok(out) } else { Err(js_error("exportCityJson options must be an object")) };
    };
    for (key, v) in map {
        if v.is_null() {
            continue;
        }
        let bad = |kind: &str| js_error(&format!("exportCityJson options.{key} must be a {kind}"));
        match key.as_str() {
            "scale" => out.scale = v.as_f64().ok_or_else(|| bad("number"))?,
            "elementGeometry" => out.element_geometry = v.as_bool().ok_or_else(|| bad("boolean"))?,
            "sequence" => out.sequence = v.as_bool().ok_or_else(|| bad("boolean"))?,
            _ => return Err(js_error(&format!("exportCityJson options.{key} is not an option"))),
        }
    }
    Ok(out)
}

fn set(target: &Object, key: &str, value: impl Into<JsValue>) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), &value.into()).map(|_| ())
}

/// Export `content` as CityJSON 2.0 (or CityJSONSeq with `sequence`).
///
/// A model with no `IfcBuilding` throws an `Error` whose message starts with
/// `CITYJSON_REFUSED:`. Georeferencing that cannot be resolved is not an
/// error: the document is written in local coordinates and `warnings` says why.
#[wasm_bindgen(js_name = exportCityJson)]
pub fn export_cityjson(content: &[u8], options_json: &str) -> Result<CityJsonExportJs, JsValue> {
    let options = cityjson_options(options_json)?;
    let export = ifc_lite_export::try_export_cityjson(content, &options).map_err(|e| js_error(&e.to_string()))?;
    let out = Object::new();
    set(&out, "text", export.text)?;
    set(&out, "referenceSystem", export.reference_system.map_or(JsValue::NULL, JsValue::from))?;
    set(&out, "warnings", export.warnings.into_iter().map(JsValue::from).collect::<Array>())?;
    set(&out, "buildings", export.buildings as f64)?;
    set(&out, "cityObjects", export.city_objects as f64)?;
    set(&out, "vertices", export.vertices as f64)?;
    Ok(JsValue::from(out).into())
}
