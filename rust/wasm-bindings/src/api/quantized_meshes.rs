// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `parseQuantizedInstanced` — single-call path from IFC bytes to a GPU-ready
//! [`QuantizedScene`] bundle.
//!
//! Mirrors the existing `parseMeshesInstanced` flow (entity scan → router →
//! per-element transform + colour) but emits **content-deduplicated, vertex-
//! quantised** output suitable for a single multi-draw indirect upload. The
//! intermediate float [`Mesh`] is dropped immediately after quantisation so
//! peak memory stays close to the final GPU footprint.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{
    calculate_normals, hash_quantized_mesh, DedupBuilder, GeometryRouter, MeshInstance,
    QuantizedMesh,
};
use rustc_hash::FxHashMap;
use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use wasm_bindgen::prelude::*;

use super::styling::{
    build_element_style_index, build_geometry_style_index, get_default_color_for_type,
};
use super::IfcAPI;
use crate::quantized_scene::QuantizedScene;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse an IFC file into a quantised + instanced GPU bundle.
    ///
    /// The returned [`QuantizedScene`] holds:
    /// * one interleaved 12 B/vertex buffer covering every unique mesh,
    /// * one `u32` index buffer (mesh-local; renderer applies `baseVertex`),
    /// * a per-mesh table with AABB and instance ranges,
    /// * a per-instance buffer (`mat4` + `expressId` + colours + flags) sorted
    ///   by mesh so each mesh is one contiguous draw.
    ///
    /// Memory and draw-call counts scale with the number of **unique** meshes
    /// (typically 5–50× fewer than total elements) rather than total
    /// placements.
    ///
    /// # Example
    ///
    /// ```javascript
    /// const api = new IfcAPI();
    /// const scene = api.parseQuantizedInstanced(ifcText);
    /// const memory = api.getMemory();
    /// const verts = new Uint8Array(memory.buffer, scene.vertexDataPtr, scene.vertexDataByteLength);
    /// device.queue.writeBuffer(vbo, 0, verts);
    /// // ... and so on for indices, mesh table, instance buffer.
    /// scene.free();
    /// ```
    #[wasm_bindgen(js_name = parseQuantizedInstanced)]
    pub fn parse_quantized_instanced(&self, content: String) -> QuantizedScene {
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        let geometry_styles = build_geometry_style_index(&content, &mut decoder);
        let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);

        // Pre-collect FacetedBrep IDs for the parallel preprocess pass.
        let mut faceted_brep_ids: Vec<u32> = Vec::new();
        {
            let mut scanner = EntityScanner::new(&content);
            while let Some((id, type_name, _, _)) = scanner.next_entity() {
                if type_name == "IFCFACETEDBREP" {
                    faceted_brep_ids.push(id);
                }
            }
        }

        let mut router = GeometryRouter::with_units(&content, &mut decoder);

        // ── RTC detection and shift ──
        // Match the legacy `parseToGpuGeometry` path in `gpu_meshes.rs` exactly:
        // sample the first 50 element placements, take their median, and if the
        // model lives more than 10 km from origin set the offset on the router
        // so raw-world-coord representations get RTC-shifted in f64 precision
        // before unit scaling. Without this, georeferenced files (UTM/RT90/
        // local survey CRS) end up with vertex coordinates so far from origin
        // that f32 precision collapses depth at the GPU.
        let rtc_offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        let needs_rtc = rtc_offset.0.abs() > 10_000.0
            || rtc_offset.1.abs() > 10_000.0
            || rtc_offset.2.abs() > 10_000.0;
        if needs_rtc {
            router.set_rtc_offset(rtc_offset);
        }

        if !faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
        }

        // The unit scale extracted from `IFCUNITASSIGNMENT`: 1.0 for files
        // declared in metres, 0.001 for millimetres, etc. Mesh positions are
        // already scaled to metres inside `process_element_with_transform`,
        // but the placement transform it returns is *not* — its translation
        // column lives in raw file units. We scale and RTC-subtract here.
        let unit_scale = router.unit_scale();
        let active_rtc = if needs_rtc { rtc_offset } else { (0.0, 0.0, 0.0) };

        // Group by float-mesh hash so each unique representation is quantised
        // exactly once. The dedup builder downstream collapses on the
        // quantised content hash too — that's a belt-and-braces guarantee
        // against any downstream divergence in quantisation parameters.
        #[allow(clippy::type_complexity)]
        let mut groups: FxHashMap<u64, (QuantizedMesh, Vec<MeshInstance>)> = FxHashMap::default();

        let mut scanner = EntityScanner::new(&content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if !has_geometry_by_name(type_name) {
                continue;
            }
            let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
                continue;
            };
            let Ok((mut mesh, transform)) =
                router.process_element_with_transform(&entity, &mut decoder)
            else {
                continue;
            };
            if mesh.is_empty() {
                continue;
            }
            if mesh.normals.len() != mesh.positions.len() {
                calculate_normals(&mut mesh);
            }

            let float_hash = hash_float_mesh(&mesh);
            let color_f32 = style_index
                .get(&id)
                .copied()
                .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));
            let base_color_rgba8 = pack_rgba8(color_f32);

            // Build the column-major transform sent to the GPU. Two corrections
            // over a naive copy:
            //   1. Scale the translation column from raw file units (mm, etc.)
            //      to metres, matching the unit conversion already applied to
            //      mesh positions inside the processor. (`process_element_with_transform`
            //      returns the placement transform untouched — see
            //      `router/processing.rs:867`.)
            //   2. Subtract the RTC offset from the (now-scaled) translation
            //      so the world-space position the shader produces sits near
            //      the origin even for survey-coord georeferenced files.
            //      Mesh positions for raw-large-coord representations are
            //      already RTC-shifted by the router (see
            //      `router/processing.rs:931–949`); for ordinary local meshes
            //      the shift lives entirely on the placement, here.
            let mut transform_f32 = [0.0_f32; 16];
            for col in 0..4 {
                for row in 0..4 {
                    transform_f32[col * 4 + row] = transform[(row, col)] as f32;
                }
            }
            // Translation column (col 3): rows 0/1/2 → indices 12/13/14.
            let tx_m = transform[(0, 3)] * unit_scale - active_rtc.0;
            let ty_m = transform[(1, 3)] * unit_scale - active_rtc.1;
            let tz_m = transform[(2, 3)] * unit_scale - active_rtc.2;
            transform_f32[12] = tx_m as f32;
            transform_f32[13] = ty_m as f32;
            transform_f32[14] = tz_m as f32;

            let instance = MeshInstance::new(id, transform_f32, base_color_rgba8);

            match groups.entry(float_hash) {
                std::collections::hash_map::Entry::Occupied(mut o) => {
                    o.get_mut().1.push(instance);
                }
                std::collections::hash_map::Entry::Vacant(v) => {
                    let q = QuantizedMesh::from_mesh(&mesh);
                    v.insert((q, vec![instance]));
                }
            }
        }

        // Funnel through DedupBuilder so any post-quantisation collisions are
        // handled and the final scene stats (dedup ratio, byte counts) come
        // from a single source of truth.
        let mut builder = DedupBuilder::with_capacity(groups.len());
        for (_, (mesh, instances)) in groups {
            let (first, rest) = instances.split_first().expect("non-empty group");
            builder.push(mesh.clone(), *first);
            for inst in rest {
                let _hash = hash_quantized_mesh(&mesh);
                builder.push(mesh.clone(), *inst);
            }
        }

        let mut scene = QuantizedScene::from_deduped(&builder.finish());
        scene.set_rtc_offset(active_rtc.0, active_rtc.1, active_rtc.2);
        scene
    }
}

/// Hash the float [`Mesh`] before quantisation to group identical
/// representations cheaply. Mirrors the hash already used by
/// `parse_meshes_instanced` so the two paths agree on what counts as
/// "identical geometry".
fn hash_float_mesh(mesh: &ifc_lite_geometry::Mesh) -> u64 {
    let mut h = FxHasher::default();
    mesh.positions.len().hash(&mut h);
    mesh.indices.len().hash(&mut h);
    for p in &mesh.positions {
        p.to_bits().hash(&mut h);
    }
    for i in &mesh.indices {
        i.hash(&mut h);
    }
    h.finish()
}

/// Pack `[r, g, b, a]` floats in `[0, 1]` to a little-endian `0xAABBGGRR` u32 —
/// the layout WGSL's `unpack4x8unorm` expects.
fn pack_rgba8(c: [f32; 4]) -> u32 {
    let r = (c[0].clamp(0.0, 1.0) * 255.0).round() as u32;
    let g = (c[1].clamp(0.0, 1.0) * 255.0).round() as u32;
    let b = (c[2].clamp(0.0, 1.0) * 255.0).round() as u32;
    let a = (c[3].clamp(0.0, 1.0) * 255.0).round() as u32;
    (a << 24) | (b << 16) | (g << 8) | r
}

#[cfg(test)]
mod tests {
    use super::pack_rgba8;

    #[test]
    fn pack_rgba8_round_trip_endpoints() {
        assert_eq!(pack_rgba8([0.0, 0.0, 0.0, 0.0]), 0x00_00_00_00);
        assert_eq!(pack_rgba8([1.0, 1.0, 1.0, 1.0]), 0xff_ff_ff_ff);
    }

    #[test]
    fn pack_rgba8_channel_order_is_abgr_le() {
        // Pure red → low byte is 0xFF.
        assert_eq!(pack_rgba8([1.0, 0.0, 0.0, 1.0]) & 0xff, 0xff);
        // Pure green → second byte is 0xFF.
        assert_eq!((pack_rgba8([0.0, 1.0, 0.0, 1.0]) >> 8) & 0xff, 0xff);
        // Pure blue → third byte is 0xFF.
        assert_eq!((pack_rgba8([0.0, 0.0, 1.0, 1.0]) >> 16) & 0xff, 0xff);
        // Alpha → high byte.
        assert_eq!((pack_rgba8([0.0, 0.0, 0.0, 0.5]) >> 24) & 0xff, 128);
    }

    #[test]
    fn pack_rgba8_clamps_out_of_range() {
        assert_eq!(pack_rgba8([2.0, -1.0, 0.5, 1.5]) & 0xff, 0xff);
        assert_eq!((pack_rgba8([2.0, -1.0, 0.5, 1.5]) >> 8) & 0xff, 0x00);
    }
}
