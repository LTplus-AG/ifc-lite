// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_glb — IFC render geometry → binary glTF (GLB) bytes.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

/// Map the optional KML altitude-mode string from the JS boundary to the
/// exporter enum. `None` (or any unrecognised value) ⇒ `ClampToGround` so the
/// safe, non-floating default (#1427) is preserved and existing callers that
/// omit the argument are unchanged. The UI exposes only `"clampToGround"`
/// ("Rest on ground") and `"absolute"` ("True elevation (MSL)"); the literal
/// `"relativeToGround"` is accepted for completeness.
fn kmz_altitude_mode(mode: Option<String>) -> ifc_lite_export::AltitudeMode {
    use ifc_lite_export::AltitudeMode;
    match mode.as_deref() {
        Some("absolute") => AltitudeMode::Absolute,
        Some("relativeToGround") => AltitudeMode::RelativeToGround,
        _ => AltitudeMode::ClampToGround,
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Export the render geometry in `content` as a binary **GLB** (`Uint8Array`).
    ///
    /// `hidden` / `isolated` are express-id visibility filters; `hidden_types_csv` is a
    /// comma-separated list of IFC type names whose class toggle is off (e.g.
    /// `"IfcOpeningElement,IfcSpace"`). `include_metadata` attaches counts + per-node
    /// `expressId`. Per-mesh RTC origin rides the node translation (precision-safe).
    /// `lit` emits standard PBR materials that shade from normals; omitted or
    /// `true` ⇒ lit (the default), `false` ⇒ flat `KHR_materials_unlit` (the
    /// historical look — #1321). Optional at the boundary so older 5-arg callers
    /// keep lit-by-default behaviour.
    /// `emissive` self-illuminates each material at its base colour (core glTF
    /// `emissiveFactor`) so renderers without ambient/IBL — Google Earth — don't
    /// render the model near-black (#1427); omitted or `false` ⇒ off.
    ///
    /// Fails CLOSED: when the visible mesh set is empty this throws an `Error`
    /// whose message starts with `NO_RENDER_GEOMETRY`, instead of returning a
    /// structurally valid but empty GLB. #1438 put that guard only in the TS
    /// CLI/MCP wrappers; making the boundary itself refuse means SDK/viewer/
    /// direct callers inherit it too (the TS guards stay as defense-in-depth).
    #[wasm_bindgen(js_name = exportGlb)]
    #[allow(clippy::too_many_arguments)]
    pub fn export_glb(
        &self,
        content: &[u8],
        include_metadata: bool,
        hidden: &[u32],
        isolated: &[u32],
        hidden_types_csv: String,
        lit: Option<bool>,
        emissive: Option<bool>,
    ) -> Result<Vec<u8>, JsValue> {
        let hidden_types = hidden_types_csv
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let opts = ifc_lite_export::GltfOptions {
            include_metadata,
            hidden: hidden.to_vec(),
            isolated: isolated.to_vec(),
            hidden_types,
            lit: lit.unwrap_or(true),
            emissive: emissive.unwrap_or(false),
            // Federation (modelId stamping) is a server-side concern; the viewer's
            // wasm export path is single-model. Add a parameter here if/when the
            // browser needs to federate.
            model_id: None,
            // The viewer loads the GLB directly; quantization is a server/export-pipeline
            // concern (KHR_mesh_quantization needs loader support the viewer doesn't wire).
            quantize: false,
        };
        ifc_lite_export::try_export_glb(content, &opts)
            .map_err(|e| JsValue::from(js_sys::Error::new(&e.to_string())))
    }

    /// Assemble a **GLB** from already-produced meshes (the viewer's `MeshData`, flattened)
    /// — no re-meshing. Per mesh `i`: `vertex_counts[i]` verts + `index_counts[i]` indices
    /// taken in order from the concatenated `positions`/`normals`/`indices`; `colors` is
    /// RGBA per mesh, `origins` xyz per mesh, `express_ids` labels each mesh (indices are
    /// per-mesh local). The caller passes exactly the meshes it wants emitted.
    #[wasm_bindgen(js_name = exportGlbFromMeshes)]
    #[allow(clippy::too_many_arguments)]
    pub fn export_glb_from_meshes(
        &self,
        positions: &[f32],
        normals: &[f32],
        indices: &[u32],
        vertex_counts: &[u32],
        index_counts: &[u32],
        colors: &[f32],
        origins: &[f64],
        express_ids: &[u32],
        include_metadata: bool,
        lit: Option<bool>,
        emissive: Option<bool>,
    ) -> Vec<u8> {
        ifc_lite_export::export_glb_from_meshes(
            positions,
            normals,
            indices,
            vertex_counts,
            index_counts,
            colors,
            origins,
            express_ids,
            include_metadata,
            lit.unwrap_or(true),
            emissive.unwrap_or(false),
        )
        .0
    }

    /// Package an already-produced **GLB** + georeference into a **KMZ** (`Uint8Array`)
    /// for Google Earth: a ZIP of `doc.kml` (a `<Model>` placed at `latitude`/`longitude`/
    /// `altitude`) + `model.glb`. `x_axis_abscissa`/`x_axis_ordinate` are the
    /// `IfcMapConversion` grid-north components; pass both as `undefined` for heading 0.
    ///
    /// `altitude_mode` selects the KML vertical placement: `"clampToGround"`
    /// (the default when omitted) rests the model on the terrain, ignoring
    /// `altitude`; `"absolute"` places the origin at `altitude` metres MSL.
    /// Google Earth's terrain already encodes the site elevation, so clamping
    /// keeps a wrong/zero/double-counted OrthogonalHeight from floating the
    /// model into the sky (#1427); absolute is offered for models whose
    /// OrthogonalHeight is a true MSL elevation the user wants honoured.
    #[wasm_bindgen(js_name = exportKmz)]
    #[allow(clippy::too_many_arguments)]
    pub fn export_kmz(
        &self,
        glb: &[u8],
        latitude: f64,
        longitude: f64,
        altitude: f64,
        x_axis_abscissa: Option<f64>,
        x_axis_ordinate: Option<f64>,
        name: String,
        altitude_mode: Option<String>,
    ) -> Vec<u8> {
        let opts = ifc_lite_export::KmzOptions {
            latitude,
            longitude,
            altitude,
            altitude_mode: kmz_altitude_mode(altitude_mode),
            x_axis_abscissa,
            x_axis_ordinate,
            name: if name.is_empty() { None } else { Some(name) },
        };
        ifc_lite_export::export_kmz(glb, &opts)
    }

    /// Build a Google-Earth-ready **KMZ** (`Uint8Array`) straight from the viewer's
    /// already-produced meshes — the working path (#1427). The model is embedded as
    /// **COLLADA** (`model.dae`), the only `<Model>` format Google Earth loads (a GLB
    /// raises "Unsupported element: Model"), with emission-lit double-sided materials
    /// placement. Mesh arrays match `exportGlbFromMeshes`;
    /// `latitude`/`longitude`/`altitude` + `x_axis_abscissa`/`x_axis_ordinate`
    /// (grid-north, `undefined` ⇒ heading 0) place + orient the model.
    /// `altitude_mode` (`"clampToGround"` default ⇒ rest on terrain, ignoring
    /// `altitude`; `"absolute"` ⇒ place at `altitude` metres MSL) selects the
    /// KML vertical placement (#1427).
    #[wasm_bindgen(js_name = exportKmzFromMeshes)]
    #[allow(clippy::too_many_arguments)]
    pub fn export_kmz_from_meshes(
        &self,
        positions: &[f32],
        normals: &[f32],
        indices: &[u32],
        vertex_counts: &[u32],
        index_counts: &[u32],
        colors: &[f32],
        origins: &[f64],
        latitude: f64,
        longitude: f64,
        altitude: f64,
        x_axis_abscissa: Option<f64>,
        x_axis_ordinate: Option<f64>,
        name: String,
        altitude_mode: Option<String>,
    ) -> Vec<u8> {
        let opts = ifc_lite_export::KmzOptions {
            latitude,
            longitude,
            altitude,
            altitude_mode: kmz_altitude_mode(altitude_mode),
            x_axis_abscissa,
            x_axis_ordinate,
            name: if name.is_empty() { None } else { Some(name) },
        };
        ifc_lite_export::export_kmz_collada_from_meshes(
            positions,
            normals,
            indices,
            vertex_counts,
            index_counts,
            colors,
            origins,
            &opts,
        )
    }
}
