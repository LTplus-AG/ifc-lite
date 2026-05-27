// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Zero-copy mesh parsing for IFC-Lite API

use super::IfcAPI;
use crate::zero_copy::ZeroCopyMesh;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse IFC file with zero-copy mesh data
    /// Maximum performance - returns mesh with direct memory access
    ///
    /// # Deprecated
    /// Prefer `parseToGpuGeometry` / `parseToGpuInstancedGeometry` for GPU
    /// upload paths. This compatibility API performs its own full scan.
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const mesh = await api.parseZeroCopy(ifcData);
    ///
    /// // Create TypedArray views (NO COPYING!)
    /// const memory = await api.getMemory();
    /// const positions = new Float32Array(
    ///   memory.buffer,
    ///   mesh.positions_ptr,
    ///   mesh.positions_len
    /// );
    ///
    /// // Upload directly to GPU
    /// gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    /// ```
    #[wasm_bindgen(js_name = parseZeroCopy)]
    pub fn parse_zero_copy(&self, content: String) -> ZeroCopyMesh {
        // Parse IFC file and generate geometry with optimized processing
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter, Mesh};

        // Build entity index once upfront for O(1) lookups
        let entity_index = build_entity_index(&content);

        // Create scanner and decoder with pre-built index
        let mut scanner = EntityScanner::new(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Create geometry router (reuses processor instances)
        let router = GeometryRouter::with_units(&content, &mut decoder);

        // Collect all meshes first (better for batch merge)
        let mut meshes: Vec<Mesh> = Vec::with_capacity(2000);

        // Process all building elements
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Check if this is a building element type
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            // Decode and process the entity
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Ok(mesh) = router.process_element(&entity, &mut decoder) {
                    if !mesh.is_empty() {
                        meshes.push(mesh);
                    }
                }
            }
        }

        // Batch merge all meshes at once (more efficient)
        let mut combined_mesh = Mesh::new();
        combined_mesh.merge_all(&meshes);

        // Calculate normals if not present
        if combined_mesh.normals.len() != combined_mesh.positions.len() {
            calculate_normals(&mut combined_mesh);
        }

        ZeroCopyMesh::from(combined_mesh)
    }
}
