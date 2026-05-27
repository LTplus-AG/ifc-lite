// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geo-referencing and RTC offset methods for IFC-Lite API

use super::styling::{
    build_element_style_index, build_geometry_style_index, get_default_color_for_type,
};
use super::{GeoReferenceJs, IfcAPI, MeshCollectionWithRtc, RtcOffsetJs};
use crate::zero_copy::{MeshCollection, MeshDataJs};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Extract georeferencing information from IFC content
    /// Returns null if no georeferencing is present
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const georef = api.getGeoReference(ifcData);
    /// if (georef) {
    ///   console.log('CRS:', georef.crsName);
    ///   const [e, n, h] = georef.localToMap(10, 20, 5);
    /// }
    /// ```
    #[wasm_bindgen(js_name = getGeoReference)]
    pub fn get_geo_reference(&self, content: String) -> Option<GeoReferenceJs> {
        use ifc_lite_core::{
            build_entity_index, EntityDecoder, EntityScanner, GeoRefExtractor, IfcType,
        };

        // Build entity index and decoder
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Collect entity types
        let mut scanner = EntityScanner::new(&content);
        let mut entity_types: Vec<(u32, IfcType)> = Vec::new();

        while let Some((id, type_name, _, _)) = scanner.next_entity() {
            let ifc_type = IfcType::from_str(type_name);
            entity_types.push((id, ifc_type));
        }

        // Extract georeferencing
        match GeoRefExtractor::extract(&mut decoder, &entity_types) {
            Ok(Some(georef)) => Some(GeoReferenceJs::from(georef)),
            _ => None,
        }
    }

    /// Parse IFC file and return mesh with RTC offset for large coordinates
    /// This handles georeferenced models by shifting to centroid
    ///
    /// # Deprecated
    /// Prefer `parseMeshesAsync` or the pre-pass/batch geometry pipeline, which
    /// emits RTC metadata without this legacy synchronous full-parse path.
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const result = api.parseMeshesWithRtc(ifcData);
    /// const rtcOffset = result.rtcOffset;
    /// const meshes = result.meshes;
    ///
    /// // Convert local coords back to world:
    /// if (rtcOffset.isSignificant()) {
    ///   const [wx, wy, wz] = rtcOffset.toWorld(localX, localY, localZ);
    /// }
    /// ```
    #[wasm_bindgen(js_name = parseMeshesWithRtc)]
    pub fn parse_meshes_with_rtc(&self, content: String) -> MeshCollectionWithRtc {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, RtcOffset};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        // Build entity index once upfront
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Build style indices
        let geometry_styles = build_geometry_style_index(&content, &mut decoder);
        let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);

        // OPTIMIZATION: Collect all FacetedBrep IDs for batch processing
        let mut scanner = EntityScanner::new(&content);
        let mut faceted_brep_ids: Vec<u32> = Vec::new();
        while let Some((id, type_name, _, _)) = scanner.next_entity() {
            if type_name == "IFCFACETEDBREP" {
                faceted_brep_ids.push(id);
            }
        }

        let router = GeometryRouter::with_units(&content, &mut decoder);

        // Batch preprocess FacetedBrep entities for maximum parallelism
        if !faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
        }

        // Reset scanner for main processing pass
        scanner = EntityScanner::new(&content);

        let estimated_elements = content.len() / 500;
        let mut mesh_collection = MeshCollection::with_capacity(estimated_elements);

        // Collect all positions to calculate RTC offset
        let mut all_positions: Vec<f32> = Vec::with_capacity(100000);

        // Process all building elements
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // Check if entity actually has representation (attribute index 6 for IfcProduct)
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    continue;
                }

                if let Ok(mut mesh) = router.process_element(&entity, &mut decoder) {
                    if !mesh.is_empty() {
                        if mesh.normals.is_empty() {
                            calculate_normals(&mut mesh);
                        }

                        // Collect positions for RTC calculation
                        all_positions.extend_from_slice(&mesh.positions);

                        let color = style_index
                            .get(&id)
                            .copied()
                            .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                        let ifc_type_name = entity.ifc_type.name().to_string();
                        let mesh_data = MeshDataJs::new(id, ifc_type_name, mesh, color);
                        mesh_collection.add(mesh_data);
                    }
                }
            }
        }

        // Calculate RTC offset from all positions
        let rtc_offset = RtcOffset::from_positions(&all_positions);
        let rtc_offset_js = RtcOffsetJs::from(rtc_offset.clone());

        // Apply RTC offset if significant
        if rtc_offset.is_significant() {
            mesh_collection.apply_rtc_offset(rtc_offset.x, rtc_offset.y, rtc_offset.z);
        }

        MeshCollectionWithRtc {
            meshes: mesh_collection,
            rtc_offset: rtc_offset_js,
        }
    }
}
