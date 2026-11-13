// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Independently loaded Rhino scene builder. Kept out of the default geometry
//! engine (`ifc-lite-wasm`) so the .3dm exporter never grows the download every
//! viewer load pays for; it is fetched only when a .3dm export runs.
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
