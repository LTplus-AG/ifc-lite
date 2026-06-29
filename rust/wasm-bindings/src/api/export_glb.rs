// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_glb — IFC render geometry → binary glTF (GLB) bytes.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

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
    ) -> Vec<u8> {
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
        };
        ifc_lite_export::export_glb(content, &opts)
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
        )
        .0
    }

    /// Package an already-produced **GLB** + georeference into a **KMZ** (`Uint8Array`)
    /// for Google Earth: a ZIP of `doc.kml` (a `<Model>` placed at `latitude`/`longitude`/
    /// `altitude`) + `model.glb`. `x_axis_abscissa`/`x_axis_ordinate` are the
    /// `IfcMapConversion` grid-north components; pass both as `undefined` for heading 0.
    #[wasm_bindgen(js_name = exportKmz)]
    pub fn export_kmz(
        &self,
        glb: &[u8],
        latitude: f64,
        longitude: f64,
        altitude: f64,
        x_axis_abscissa: Option<f64>,
        x_axis_ordinate: Option<f64>,
        name: String,
    ) -> Vec<u8> {
        let opts = ifc_lite_export::KmzOptions {
            latitude,
            longitude,
            altitude,
            x_axis_abscissa,
            x_axis_ordinate,
            name: if name.is_empty() { None } else { Some(name) },
        };
        ifc_lite_export::export_kmz(glb, &opts)
    }
}
