// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU mesh parsing methods for IFC-Lite API
//!
//! Includes synchronous and async mesh parsing, instanced geometry,
//! and GPU-ready geometry generation.

use super::styling::{
    build_element_material_styles_from_content, build_element_style_index,
    build_geometry_style_index, extract_building_rotation, get_default_color_for_type,
    resolve_element_color, resolve_submesh_color,
};
use super::GeometryStats;
use super::IfcAPI;
use crate::gpu_geometry::{GpuGeometry, GpuInstancedGeometry, GpuInstancedGeometryCollection};
use crate::zero_copy::{
    InstanceData, InstancedGeometry, InstancedMeshCollection, MeshCollection, MeshDataJs,
};
use js_sys::Function;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

fn decode_ifc_bytes<'a>(data: &'a [u8]) -> &'a str {
    match std::str::from_utf8(data) {
        Ok(content) => content,
        Err(error) => wasm_bindgen::throw_str(&format!("Invalid UTF-8 IFC data: {error}")),
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Parse IFC file and return individual meshes with express IDs and colors
    /// This matches the MeshData[] format expected by the viewer
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const collection = api.parseMeshes(ifcData);
    /// for (let i = 0; i < collection.length; i++) {
    ///   const mesh = collection.get(i);
    ///   console.log('Express ID:', mesh.expressId);
    ///   console.log('Positions:', mesh.positions);
    ///   console.log('Color:', mesh.color);
    /// }
    /// ```

    #[wasm_bindgen(js_name = parseMeshes)]
    pub fn parse_meshes(&self, content: String) -> MeshCollection {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        // Build entity index once upfront for O(1) lookups
        let entity_index = build_entity_index(&content);

        // Create decoder with pre-built index
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Build style index: first map geometry IDs to colors, then map element IDs to colors
        let geometry_styles = build_geometry_style_index(&content, &mut decoder);
        let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);
        // Build material-based styles for sub-element color fallback (windows, doors)
        let element_material_styles =
            build_element_material_styles_from_content(&content, &mut decoder);

        // OPTIMIZATION: Collect all FacetedBrep IDs for batch processing
        // Also build void relationship index (host → openings)
        let mut scanner = EntityScanner::new(&content);
        let mut faceted_brep_ids: Vec<u32> = Vec::new();
        let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name == "IFCFACETEDBREP" {
                faceted_brep_ids.push(id);
            } else if type_name == "IFCRELVOIDSELEMENT" {
                // IfcRelVoidsElement: Attr 4 = RelatingBuildingElement, Attr 5 = RelatedOpeningElement
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    if let (Some(host_id), Some(opening_id)) =
                        (entity.get_ref(4), entity.get_ref(5))
                    {
                        void_index.entry(host_id).or_default().push(opening_id);
                    }
                }
            }
        }

        // Propagate voids from aggregate parents (IfcWall) to children (IfcBuildingElementPart)
        // so that multilayer wall parts also get window/door cutouts.
        ifc_lite_geometry::propagate_voids_to_parts(&mut void_index, &content, &mut decoder);

        // Create geometry router (without RTC offset initially)
        let mut router = GeometryRouter::with_units(&content, &mut decoder);

        // DETECT RTC OFFSET from actual building element transforms
        // This is more reliable than scanning cartesian points because it uses
        // the actual transform chain (which accumulates to world coordinates)
        let rtc_offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        if needs_shift {
            router.set_rtc_offset(rtc_offset);
        }

        // Batch preprocess FacetedBrep entities for maximum parallelism
        // This triangulates ALL faces from ALL BREPs in one parallel batch
        if !faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
        }

        // Reset scanner for main processing pass
        scanner = EntityScanner::new(&content);

        // Estimate capacity: typical IFC files have ~5-10% building elements
        let estimated_elements = content.len() / 500;
        let mut mesh_collection = MeshCollection::with_capacity(estimated_elements);

        // Store RTC offset in collection for JavaScript to use (for camera/world coordinate display)
        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_offset.0, rtc_offset.1, rtc_offset.2);
        }

        // Extract building rotation from IfcSite's top-level placement
        let building_rotation = extract_building_rotation(&content, &mut decoder);
        mesh_collection.set_building_rotation(building_rotation);

        // Track geometry parsing statistics
        let mut stats = GeometryStats::default();

        // Process all building elements
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Check if this is a building element type
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            stats.total += 1;

            // Decode and process the entity
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // Check if entity actually has representation (attribute index 6 for IfcProduct)
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    web_sys::console::debug_1(
                        &format!(
                            "[IFC-LITE] #{} ({}) has no representation — skipping geometry",
                            id,
                            entity.ifc_type.name()
                        )
                        .into(),
                    );
                    stats.no_representation += 1;
                    continue;
                }

                // Preserve sub-mesh colors for multi-material elements (windows/doors).
                // Elements with openings still use merged void-subtracted geometry.
                let has_openings = void_index.contains_key(&id);
                let default_color = get_default_color_for_type(&entity.ifc_type);
                let ifc_type_name = entity.ifc_type.name().to_string();
                let mut added_any_mesh = false;

                let mut push_mesh_if_valid =
                    |mesh: &mut ifc_lite_geometry::Mesh, color: [f32; 4]| {
                        if mesh.is_empty() {
                            return;
                        }

                        // Calculate normals if not present or incomplete
                        if mesh.normals.len() != mesh.positions.len() {
                            calculate_normals(mesh);
                        }

                        // Safety filter: exclude meshes with unreasonable coordinates after RTC
                        const MAX_REASONABLE_OFFSET: f32 = 50_000.0; // 50km from RTC center
                        let mut max_coord = 0.0f32;
                        let mut outlier_vertex_count = 0;
                        let mut has_non_finite = false;

                        for chunk in mesh.positions.chunks_exact(3) {
                            let x = chunk[0];
                            let y = chunk[1];
                            let z = chunk[2];

                            if !x.is_finite() || !y.is_finite() || !z.is_finite() {
                                outlier_vertex_count += 1;
                                has_non_finite = true;
                                continue;
                            }

                            let coord_mag = x.abs().max(y.abs()).max(z.abs());
                            max_coord = max_coord.max(coord_mag);
                            if coord_mag > MAX_REASONABLE_OFFSET {
                                outlier_vertex_count += 1;
                            }
                        }

                        if has_non_finite {
                            web_sys::console::warn_1(
                                &format!(
                                    "[WASM FILTER] Mesh #{} ({}) contains NaN/Inf coordinates",
                                    id,
                                    entity.ifc_type.name()
                                )
                                .into(),
                            );
                        }

                        let total_vertices = mesh.positions.len() / 3;
                        let outlier_ratio = if total_vertices > 0 {
                            outlier_vertex_count as f32 / total_vertices as f32
                        } else {
                            0.0
                        };

                        if outlier_ratio > 0.9 || max_coord > MAX_REASONABLE_OFFSET * 4.0 {
                            web_sys::console::warn_1(
                            &format!(
                                "[WASM FILTER] Excluding mesh #{} ({}) - {:.1}% outliers, max coord: {:.2}m",
                                id,
                                entity.ifc_type.name(),
                                outlier_ratio * 100.0,
                                max_coord
                            )
                            .into(),
                        );
                            stats.outlier_filtered += 1;
                            return;
                        }

                        let mesh_data =
                            MeshDataJs::new(id, ifc_type_name.clone(), mesh.clone(), color);
                        mesh_collection.add(mesh_data);
                        added_any_mesh = true;
                    };

                if has_openings {
                    // Try per-sub-mesh voiding first so each layer (e.g. air /
                    // insulation / brick) keeps its own direct IfcStyledItem
                    // color while openings are still subtracted. Falls through
                    // to the merged-mesh path on error or when every sub-mesh
                    // is destroyed by CSG.
                    let submesh_voids = router
                        .process_element_with_submeshes_and_voids(
                            &entity,
                            &mut decoder,
                            &void_index,
                        )
                        .ok()
                        .filter(|c| !c.is_empty());

                    if let Some(sub_meshes) = submesh_voids {
                        let mat_colors = element_material_styles.get(&id);
                        let mut mat_color_idx = 0usize;

                        for sub in sub_meshes.sub_meshes {
                            let mut mesh = sub.mesh;
                            let color = resolve_submesh_color(
                                sub.geometry_id,
                                &geometry_styles,
                                &mut decoder,
                                mat_colors,
                                &mut mat_color_idx,
                                style_index.get(&id).copied(),
                                default_color,
                            );
                            push_mesh_if_valid(&mut mesh, color);
                        }
                    } else {
                        match router
                            .process_element_with_voids(&entity, &mut decoder, &void_index)
                        {
                            Err(e) => {
                                web_sys::console::warn_1(
                                    &format!(
                                        "[IFC-LITE] Failed to process #{} ({}): {}",
                                        id,
                                        entity.ifc_type.name(),
                                        e
                                    )
                                    .into(),
                                );
                                stats.process_failed += 1;
                            }
                            Ok(mut mesh) => {
                                let color =
                                    style_index.get(&id).copied().unwrap_or(default_color);
                                push_mesh_if_valid(&mut mesh, color);
                            }
                        }
                    }
                } else {
                    let skip_submesh = matches!(entity.ifc_type, ifc_lite_core::IfcType::IfcSite);
                    let sub_meshes_result = if skip_submesh {
                        Err(ifc_lite_geometry::Error::geometry(
                            "Skip submesh for IfcSite".to_string(),
                        ))
                    } else {
                        router.process_element_with_submeshes(&entity, &mut decoder)
                    };

                    let has_submeshes = sub_meshes_result
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);

                    if has_submeshes {
                        let sub_meshes = sub_meshes_result.unwrap();
                        let mat_colors = element_material_styles.get(&id);
                        let mut mat_color_idx = 0usize;

                        for sub in sub_meshes.sub_meshes {
                            let mut mesh = sub.mesh;
                            let color = resolve_submesh_color(
                                sub.geometry_id,
                                &geometry_styles,
                                &mut decoder,
                                mat_colors,
                                &mut mat_color_idx,
                                style_index.get(&id).copied(),
                                default_color,
                            );
                            push_mesh_if_valid(&mut mesh, color);
                        }
                    } else {
                        match router.process_element(&entity, &mut decoder) {
                            Err(e) => {
                                web_sys::console::warn_1(
                                    &format!(
                                        "[IFC-LITE] Failed to process #{} ({}): {}",
                                        id,
                                        entity.ifc_type.name(),
                                        e
                                    )
                                    .into(),
                                );
                                stats.process_failed += 1;
                            }
                            Ok(mut mesh) => {
                                let color = style_index.get(&id).copied().unwrap_or(default_color);
                                push_mesh_if_valid(&mut mesh, color);
                            }
                        }
                    }
                }

                if added_any_mesh {
                    stats.success += 1;
                } else {
                    stats.empty_mesh += 1;
                }
            } else {
                stats.decode_failed += 1;
            }
        }

        // Always emit geometry summary at debug level
        if stats.total > 0 {
            let actual_candidates = stats.total - stats.no_representation;
            let candidate_success_rate = if actual_candidates > 0 {
                stats.success as f64 / actual_candidates as f64
            } else {
                1.0 // No candidates = nothing failed
            };

            web_sys::console::debug_1(&format!(
                "[IFC-LITE] Geometry: {}/{} meshes extracted ({} candidates had representation, {} skipped without)",
                stats.success, stats.total, actual_candidates, stats.no_representation
            ).into());

            // Warn only on actual processing failures (not missing representations — those are expected)
            let actual_failures = stats.decode_failed + stats.process_failed;
            if actual_failures > 0 || candidate_success_rate < 0.5 {
                web_sys::console::warn_1(&format!(
                    "[IFC-LITE] Geometry issues: decode failed: {}, process failed: {}, empty: {}, filtered: {}",
                    stats.decode_failed, stats.process_failed,
                    stats.empty_mesh, stats.outlier_filtered
                ).into());
            }
        }

        mesh_collection
    }

    /// Parse a subset of IFC geometry entities by index range.
    ///
    /// Performs the full pre-pass (entity index, combined style/void/brep scan)
    /// but only processes geometry entities whose index (in the combined
    /// simple + complex job list) falls within `[start_idx, end_idx)`.
    ///
    /// This enables Web Worker parallelization: each worker processes a
    /// disjoint slice of the entity list while sharing the same pre-pass data.
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// // Worker 1: entities 0..500
    /// const batch1 = api.parseMeshesSubset(content, 0, 500);
    /// // Worker 2: entities 500..1000
    /// const batch2 = api.parseMeshesSubset(content, 500, 1000);
    /// ```
    #[wasm_bindgen(js_name = parseMeshesSubset)]
    pub fn parse_meshes_subset(
        &self,
        content: String,
        start_idx: u32,
        end_idx: u32,
        skip_expensive: bool,
    ) -> MeshCollection {
        use super::styling::{
            combined_pre_pass, extract_building_rotation_from_site, get_default_color_for_type,
            resolve_element_color, resolve_submesh_color,
        };
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        // ── Phase 1: Build entity index (fast memchr scan, ~200 ms) ──
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // ── Phase 2: Single combined pre-pass (~600 ms) ──
        let pre_pass = combined_pre_pass(&content, &mut decoder);

        let total_jobs = pre_pass.simple_jobs.len() + pre_pass.complex_jobs.len();
        decoder.reserve_cache(if skip_expensive {
            total_jobs
        } else {
            total_jobs * 2
        });

        // ── Phase 3: Setup ──
        let unit_scale = pre_pass
            .project_id
            .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
            .unwrap_or(1.0);
        let mut router = GeometryRouter::with_scale(unit_scale);

        let rtc_jobs: Vec<_> = pre_pass
            .simple_jobs
            .iter()
            .take(25)
            .chain(pre_pass.complex_jobs.iter().take(25))
            .copied()
            .collect();
        let rtc_offset = router
            .detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder)
            .unwrap_or((0.0, 0.0, 0.0));
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        if needs_shift {
            router.set_rtc_offset(rtc_offset);
        }

        let building_rotation = pre_pass
            .site_position
            .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

        // ── Phase 3b: Build element style map (SKIP if skip_expensive) ──
        let mut element_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        if !skip_expensive && !pre_pass.geometry_styles.is_empty() {
            for jobs in [&pre_pass.simple_jobs, &pre_pass.complex_jobs] {
                for &(id, start, end, _ifc_type) in jobs.iter() {
                    if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                        if entity.get(6).map(|a| !a.is_null()).unwrap_or(false) {
                            if let Some(color) = resolve_element_color(
                                &entity,
                                &pre_pass.geometry_styles,
                                &mut decoder,
                            ) {
                                element_styles.insert(id, color);
                            }
                        }
                    }
                }
            }
        }

        // Batch preprocess FacetedBreps (skip in fast worker mode)
        if !skip_expensive && !pre_pass.faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&pre_pass.faceted_brep_ids, &mut decoder);
            decoder.clear_point_cache();
        }

        // ── Phase 4: Process only the requested subset of geometry entities ──
        // Build a combined job list: simple first, then complex (same order as parseMeshesAsync)
        let all_jobs: Vec<(u32, usize, usize, ifc_lite_core::IfcType)> = pre_pass
            .simple_jobs
            .iter()
            .chain(pre_pass.complex_jobs.iter())
            .copied()
            .collect();

        let start = start_idx as usize;
        let end = (end_idx as usize).min(all_jobs.len());

        let estimated_elements = if end > start { end - start } else { 0 };
        let mut mesh_collection = MeshCollection::with_capacity(estimated_elements);

        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_offset.0, rtc_offset.1, rtc_offset.2);
        }
        mesh_collection.set_building_rotation(building_rotation);

        // Cache IFC type name strings
        let mut type_name_cache: rustc_hash::FxHashMap<ifc_lite_core::IfcType, String> =
            rustc_hash::FxHashMap::default();

        for &(id, job_start, job_end, ifc_type) in &all_jobs[start..end] {
            if let Ok(entity) = decoder.decode_at_with_id(id, job_start, job_end) {
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    continue;
                }

                let has_openings = pre_pass.void_index.contains_key(&id);
                let default_color = get_default_color_for_type(&ifc_type);
                let element_color = element_styles.get(&id).copied();
                let ifc_type_name = type_name_cache
                    .entry(ifc_type)
                    .or_insert_with(|| ifc_type.name().to_string())
                    .clone();

                let mut push_mesh = |mesh: &mut ifc_lite_geometry::Mesh, color: [f32; 4]| {
                    if mesh.is_empty() {
                        return;
                    }
                    if mesh.normals.len() != mesh.positions.len() {
                        calculate_normals(mesh);
                    }
                    let mesh_data = MeshDataJs::new(id, ifc_type_name.clone(), mesh.clone(), color);
                    mesh_collection.add(mesh_data);
                };

                if has_openings {
                    // Per-sub-mesh void subtraction preserves layer colors;
                    // fall back to merged void path if every sub-mesh is
                    // destroyed (or the element produced no sub-meshes).
                    let submesh_voids = router
                        .process_element_with_submeshes_and_voids(
                            &entity,
                            &mut decoder,
                            &pre_pass.void_index,
                        )
                        .ok()
                        .filter(|c| !c.is_empty());

                    if let Some(sub_meshes) = submesh_voids {
                        let mat_colors = pre_pass.element_material_styles.get(&id);
                        let mut mat_color_idx = 0usize;

                        for sub in sub_meshes.sub_meshes {
                            let mut mesh = sub.mesh;
                            let color = resolve_submesh_color(
                                sub.geometry_id,
                                &pre_pass.geometry_styles,
                                &mut decoder,
                                mat_colors,
                                &mut mat_color_idx,
                                element_color,
                                default_color,
                            );
                            push_mesh(&mut mesh, color);
                        }
                    } else if let Ok(mut mesh) = router.process_element_with_voids(
                        &entity,
                        &mut decoder,
                        &pre_pass.void_index,
                    ) {
                        let color = element_color.unwrap_or(default_color);
                        push_mesh(&mut mesh, color);
                    }
                } else {
                    let skip_submesh = matches!(ifc_type, ifc_lite_core::IfcType::IfcSite);
                    let sub_meshes_result = if skip_submesh {
                        Err(ifc_lite_geometry::Error::geometry(
                            "Skip submesh for IfcSite".to_string(),
                        ))
                    } else {
                        router.process_element_with_submeshes(&entity, &mut decoder)
                    };

                    let has_submeshes = sub_meshes_result
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);

                    if has_submeshes {
                        let sub_meshes = sub_meshes_result.unwrap();
                        let mat_colors = pre_pass.element_material_styles.get(&id);
                        let mut mat_color_idx = 0usize;

                        for sub in sub_meshes.sub_meshes {
                            let mut mesh = sub.mesh;
                            let color = resolve_submesh_color(
                                sub.geometry_id,
                                &pre_pass.geometry_styles,
                                &mut decoder,
                                mat_colors,
                                &mut mat_color_idx,
                                element_color,
                                default_color,
                            );
                            push_mesh(&mut mesh, color);
                        }
                    } else if let Ok(mut mesh) = router.process_element(&entity, &mut decoder) {
                        let color = element_color.unwrap_or(default_color);
                        push_mesh(&mut mesh, color);
                    }
                }
            }
        }

        mesh_collection
    }

    /// Parse IFC file and return instanced geometry grouped by geometry hash
    /// This reduces draw calls by grouping identical geometries with different transforms
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const collection = api.parseMeshesInstanced(ifcData);
    /// for (let i = 0; i < collection.length; i++) {
    ///   const geometry = collection.get(i);
    ///   console.log('Geometry ID:', geometry.geometryId);
    ///   console.log('Instances:', geometry.instanceCount);
    ///   for (let j = 0; j < geometry.instanceCount; j++) {
    ///     const inst = geometry.getInstance(j);
    ///     console.log('  Express ID:', inst.expressId);
    ///     console.log('  Transform:', inst.transform);
    ///   }
    /// }
    /// ```
    #[wasm_bindgen(js_name = parseMeshesInstanced)]
    pub fn parse_meshes_instanced(&self, content: String) -> InstancedMeshCollection {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter, Mesh};
        use rustc_hash::FxHashMap;
        use rustc_hash::FxHasher;
        use std::hash::{Hash, Hasher};

        // Build entity index once upfront for O(1) lookups
        let entity_index = build_entity_index(&content);

        // Create decoder with pre-built index
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Build style index: first map geometry IDs to colors, then map element IDs to colors
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

        // Create geometry router (reuses processor instances)
        let router = GeometryRouter::with_units(&content, &mut decoder);

        // Batch preprocess FacetedBrep entities for maximum parallelism
        if !faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
        }

        // Reset scanner for main processing pass
        scanner = EntityScanner::new(&content);

        // Group meshes by geometry hash
        // Key: geometry hash, Value: (base mesh, Vec<(express_id, transform, color)>)
        // Note: transform is returned as Matrix4<f64> from process_element_with_transform
        #[allow(clippy::type_complexity)]
        let mut geometry_groups: FxHashMap<u64, (Mesh, Vec<(u32, [f64; 16], [f32; 4])>)> =
            FxHashMap::default();

        // Process all building elements
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Check if this is a building element type
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            // Decode and process the entity
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Ok((mut mesh, transform)) =
                    router.process_element_with_transform(&entity, &mut decoder)
                {
                    if !mesh.is_empty() {
                        // Calculate normals if not present or incomplete
                        // CSG operations may produce partial normals, so check for matching count
                        if mesh.normals.len() != mesh.positions.len() {
                            calculate_normals(&mut mesh);
                        }

                        // Compute geometry hash (same as router does)
                        let mut hasher = FxHasher::default();
                        mesh.positions.len().hash(&mut hasher);
                        mesh.indices.len().hash(&mut hasher);
                        for pos in &mesh.positions {
                            pos.to_bits().hash(&mut hasher);
                        }
                        for idx in &mesh.indices {
                            idx.hash(&mut hasher);
                        }
                        let geometry_hash = hasher.finish();

                        // Try to get color from style index, otherwise use default
                        let color = style_index
                            .get(&id)
                            .copied()
                            .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                        // Convert Matrix4<f64> to [f64; 16] array (column-major for WebGPU)
                        let mut transform_array = [0.0; 16];
                        for col in 0..4 {
                            for row in 0..4 {
                                transform_array[col * 4 + row] = transform[(row, col)];
                            }
                        }

                        // Add to group - only store mesh once per hash
                        let entry = geometry_groups.entry(geometry_hash);
                        match entry {
                            std::collections::hash_map::Entry::Occupied(mut o) => {
                                // Geometry already exists, just add instance
                                o.get_mut().1.push((id, transform_array, color));
                            }
                            std::collections::hash_map::Entry::Vacant(v) => {
                                // First instance of this geometry
                                v.insert((mesh, vec![(id, transform_array, color)]));
                            }
                        }
                    }
                }
            }
        }

        // Convert groups to InstancedGeometry
        let mut collection = InstancedMeshCollection::new();
        for (geometry_id, (mesh, instances)) in geometry_groups {
            let mut instanced_geom =
                InstancedGeometry::new(geometry_id, mesh.positions, mesh.normals, mesh.indices);

            // Convert transforms from [f64; 16] to Vec<f32>
            for (express_id, transform_array, color) in instances {
                let mut transform_f32 = Vec::with_capacity(16);
                for val in transform_array.iter() {
                    transform_f32.push(*val as f32);
                }
                instanced_geom.add_instance(InstanceData::new(express_id, transform_f32, color));
            }

            collection.add(instanced_geom);
        }

        collection
    }

    /// Parse IFC file with streaming instanced geometry batches for progressive rendering
    /// Groups identical geometries and yields batches of InstancedGeometry
    /// Uses fast-first-frame streaming: simple geometry (walls, slabs) first
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// await api.parseMeshesInstancedAsync(ifcData, {
    ///   batchSize: 25,  // Number of unique geometries per batch
    ///   onBatch: (geometries, progress) => {
    ///     for (const geom of geometries) {
    ///       renderer.addInstancedGeometry(geom);
    ///     }
    ///   },
    ///   onComplete: (stats) => {
    ///     console.log(`Done! ${stats.totalGeometries} unique geometries, ${stats.totalInstances} instances`);
    ///   }
    /// });
    /// ```
    #[wasm_bindgen(js_name = parseMeshesInstancedAsync)]
    pub fn parse_meshes_instanced_async(
        &self,
        content: String,
        options: JsValue,
    ) -> js_sys::Promise {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter, Mesh};
        use rustc_hash::{FxHashMap, FxHasher};
        use std::hash::{Hash, Hasher};

        // Use Option::take() to move ownership into the closure without cloning.
        // This avoids doubling WASM memory usage for large files (700MB+ saves ~700MB).
        let mut content = Some(content);
        let mut options = Some(options);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            let content = content.take().expect("content already taken");
            let options = options.take().expect("options already taken");

            spawn_local(async move {
                // Parse options
                let batch_size: usize = js_sys::Reflect::get(&options, &"batchSize".into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .map(|v| v as usize)
                    .unwrap_or(25); // Batch size = number of unique geometries per batch

                let on_batch = js_sys::Reflect::get(&options, &"onBatch".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                let on_complete = js_sys::Reflect::get(&options, &"onComplete".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                // Build entity index once upfront for O(1) lookups
                let entity_index = build_entity_index(&content);
                let mut decoder = EntityDecoder::with_index(&content, entity_index);

                // Build style index
                let geometry_styles = build_geometry_style_index(&content, &mut decoder);
                let style_index =
                    build_element_style_index(&content, &geometry_styles, &mut decoder);

                // Collect FacetedBrep IDs for batch preprocessing
                let mut scanner = EntityScanner::new(&content);
                let mut faceted_brep_ids: Vec<u32> = Vec::new();
                while let Some((id, type_name, _, _)) = scanner.next_entity() {
                    if type_name == "IFCFACETEDBREP" {
                        faceted_brep_ids.push(id);
                    }
                }

                // Create geometry router
                let router = GeometryRouter::with_units(&content, &mut decoder);

                // Batch preprocess FacetedBreps
                if !faceted_brep_ids.is_empty() {
                    router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
                }

                // Reset scanner for main processing
                scanner = EntityScanner::new(&content);

                // Group meshes by geometry hash (accumulated across batches)
                // Key: geometry hash, Value: (base mesh, Vec<(express_id, transform, color)>)
                #[allow(clippy::type_complexity)]
                let mut geometry_groups: FxHashMap<
                    u64,
                    (Mesh, Vec<(u32, [f64; 16], [f32; 4])>),
                > = FxHashMap::default();
                let mut processed = 0;
                let mut total_geometries = 0;
                let mut total_instances = 0;
                let mut deferred_complex: Vec<(u32, usize, usize, ifc_lite_core::IfcType)> =
                    Vec::new();

                // First pass - process simple geometry immediately
                while let Some((id, type_name, start, end)) = scanner.next_entity() {
                    if !ifc_lite_core::has_geometry_by_name(type_name) {
                        continue;
                    }

                    let ifc_type = ifc_lite_core::IfcType::from_str(type_name);

                    // Simple geometry: process immediately
                    if matches!(
                        type_name,
                        "IFCWALL"
                            | "IFCWALLSTANDARDCASE"
                            | "IFCSLAB"
                            | "IFCBEAM"
                            | "IFCCOLUMN"
                            | "IFCPLATE"
                            | "IFCROOF"
                            | "IFCCOVERING"
                            | "IFCFOOTING"
                            | "IFCRAILING"
                            | "IFCSTAIR"
                            | "IFCSTAIRFLIGHT"
                            | "IFCRAMP"
                            | "IFCRAMPFLIGHT"
                    ) {
                        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                            if let Ok((mut mesh, transform)) =
                                router.process_element_with_transform(&entity, &mut decoder)
                            {
                                if !mesh.is_empty() {
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }

                                    // Compute geometry hash (before transformation)
                                    let mut hasher = FxHasher::default();
                                    mesh.positions.len().hash(&mut hasher);
                                    mesh.indices.len().hash(&mut hasher);
                                    for pos in &mesh.positions {
                                        pos.to_bits().hash(&mut hasher);
                                    }
                                    for idx in &mesh.indices {
                                        idx.hash(&mut hasher);
                                    }
                                    let geometry_hash = hasher.finish();

                                    // Get color
                                    let color = style_index
                                        .get(&id)
                                        .copied()
                                        .unwrap_or_else(|| get_default_color_for_type(&ifc_type));

                                    // Convert Matrix4<f64> to [f64; 16] array (column-major for WebGPU)
                                    let mut transform_array = [0.0; 16];
                                    for col in 0..4 {
                                        for row in 0..4 {
                                            transform_array[col * 4 + row] = transform[(row, col)];
                                        }
                                    }

                                    // Add to group
                                    let entry = geometry_groups.entry(geometry_hash);
                                    match entry {
                                        std::collections::hash_map::Entry::Occupied(mut o) => {
                                            o.get_mut().1.push((id, transform_array, color));
                                            total_instances += 1;
                                        }
                                        std::collections::hash_map::Entry::Vacant(v) => {
                                            v.insert((mesh, vec![(id, transform_array, color)]));
                                            total_geometries += 1;
                                            total_instances += 1;
                                        }
                                    }
                                    processed += 1;
                                }
                            }
                        }

                        // Yield batch when we have enough unique geometries
                        if geometry_groups.len() >= batch_size {
                            let mut batch_geometries = Vec::new();
                            let mut geometries_to_remove = Vec::new();

                            // Convert groups to InstancedGeometry
                            for (geometry_id, (mesh, instances)) in geometry_groups.iter() {
                                let mut instanced_geom = InstancedGeometry::new(
                                    *geometry_id,
                                    mesh.positions.clone(),
                                    mesh.normals.clone(),
                                    mesh.indices.clone(),
                                );

                                for (express_id, transform_array, color) in instances.iter() {
                                    let mut transform_f32 = Vec::with_capacity(16);
                                    for val in transform_array.iter() {
                                        transform_f32.push(*val as f32);
                                    }
                                    instanced_geom.add_instance(InstanceData::new(
                                        *express_id,
                                        transform_f32,
                                        *color,
                                    ));
                                }

                                batch_geometries.push(instanced_geom);
                                geometries_to_remove.push(*geometry_id);
                            }

                            // Remove processed geometries from map
                            for geometry_id in geometries_to_remove {
                                geometry_groups.remove(&geometry_id);
                            }

                            // Yield batch
                            if let Some(ref callback) = on_batch {
                                let js_geometries = js_sys::Array::new();
                                for geom in batch_geometries {
                                    js_geometries.push(&geom.into());
                                }

                                let progress = js_sys::Object::new();
                                super::set_js_prop(&progress, "percent", &0u32.into());
                                super::set_js_prop(
                                    &progress,
                                    "processed",
                                    &(processed as f64).into(),
                                );
                                super::set_js_prop(&progress, "phase", &"simple".into());

                                let _ = callback.call2(&JsValue::NULL, &js_geometries, &progress);
                            }

                            // Yield to browser
                            // yield removed — sync for speed
                        }
                    } else {
                        // Defer complex geometry
                        deferred_complex.push((id, start, end, ifc_type));
                    }
                }

                // Flush remaining simple geometries
                if !geometry_groups.is_empty() {
                    let mut batch_geometries = Vec::new();
                    for (geometry_id, (mesh, instances)) in geometry_groups.drain() {
                        let mut instanced_geom = InstancedGeometry::new(
                            geometry_id,
                            mesh.positions,
                            mesh.normals,
                            mesh.indices,
                        );

                        for (express_id, transform_array, color) in instances {
                            let mut transform_f32 = Vec::with_capacity(16);
                            for val in transform_array.iter() {
                                transform_f32.push(*val as f32);
                            }
                            instanced_geom.add_instance(InstanceData::new(
                                express_id,
                                transform_f32,
                                color,
                            ));
                        }

                        batch_geometries.push(instanced_geom);
                    }

                    if let Some(ref callback) = on_batch {
                        let js_geometries = js_sys::Array::new();
                        for geom in batch_geometries {
                            js_geometries.push(&geom.into());
                        }

                        let progress = js_sys::Object::new();
                        super::set_js_prop(&progress, "phase", &"simple_complete".into());

                        let _ = callback.call2(&JsValue::NULL, &js_geometries, &progress);
                    }

                    // yield removed — sync for speed
                }

                // Process deferred complex geometry
                let total_elements = processed + deferred_complex.len();
                for (id, start, end, ifc_type) in deferred_complex {
                    if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                        if let Ok((mut mesh, transform)) =
                            router.process_element_with_transform(&entity, &mut decoder)
                        {
                            if !mesh.is_empty() {
                                if mesh.normals.len() != mesh.positions.len() {
                                    calculate_normals(&mut mesh);
                                }

                                // Compute geometry hash
                                let mut hasher = FxHasher::default();
                                mesh.positions.len().hash(&mut hasher);
                                mesh.indices.len().hash(&mut hasher);
                                for pos in &mesh.positions {
                                    pos.to_bits().hash(&mut hasher);
                                }
                                for idx in &mesh.indices {
                                    idx.hash(&mut hasher);
                                }
                                let geometry_hash = hasher.finish();

                                // Get color
                                let color = style_index
                                    .get(&id)
                                    .copied()
                                    .unwrap_or_else(|| get_default_color_for_type(&ifc_type));

                                // Convert transform (column-major for WebGPU)
                                let mut transform_array = [0.0; 16];
                                for col in 0..4 {
                                    for row in 0..4 {
                                        transform_array[col * 4 + row] = transform[(row, col)];
                                    }
                                }

                                // Add to group
                                let entry = geometry_groups.entry(geometry_hash);
                                match entry {
                                    std::collections::hash_map::Entry::Occupied(mut o) => {
                                        o.get_mut().1.push((id, transform_array, color));
                                        total_instances += 1;
                                    }
                                    std::collections::hash_map::Entry::Vacant(v) => {
                                        v.insert((mesh, vec![(id, transform_array, color)]));
                                        total_geometries += 1;
                                        total_instances += 1;
                                    }
                                }
                                processed += 1;
                            }
                        }
                    }

                    // Yield batch when we have enough unique geometries
                    if geometry_groups.len() >= batch_size {
                        let mut batch_geometries = Vec::new();
                        let mut geometries_to_remove = Vec::new();

                        for (geometry_id, (mesh, instances)) in geometry_groups.iter() {
                            let mut instanced_geom = InstancedGeometry::new(
                                *geometry_id,
                                mesh.positions.clone(),
                                mesh.normals.clone(),
                                mesh.indices.clone(),
                            );

                            for (express_id, transform_array, color) in instances.iter() {
                                let mut transform_f32 = Vec::with_capacity(16);
                                for val in transform_array.iter() {
                                    transform_f32.push(*val as f32);
                                }
                                instanced_geom.add_instance(InstanceData::new(
                                    *express_id,
                                    transform_f32,
                                    *color,
                                ));
                            }

                            batch_geometries.push(instanced_geom);
                            geometries_to_remove.push(*geometry_id);
                        }

                        for geometry_id in geometries_to_remove {
                            geometry_groups.remove(&geometry_id);
                        }

                        if let Some(ref callback) = on_batch {
                            let js_geometries = js_sys::Array::new();
                            for geom in batch_geometries {
                                js_geometries.push(&geom.into());
                            }

                            let progress = js_sys::Object::new();
                            let percent = (processed as f64 / total_elements as f64 * 100.0) as u32;
                            super::set_js_prop(&progress, "percent", &percent.into());
                            super::set_js_prop(&progress, "processed", &(processed as f64).into());
                            super::set_js_prop(&progress, "total", &(total_elements as f64).into());
                            super::set_js_prop(&progress, "phase", &"complex".into());

                            let _ = callback.call2(&JsValue::NULL, &js_geometries, &progress);
                        }

                        // yield removed — sync for speed
                    }
                }

                // Final flush
                if !geometry_groups.is_empty() {
                    let mut batch_geometries = Vec::new();
                    for (geometry_id, (mesh, instances)) in geometry_groups.drain() {
                        let mut instanced_geom = InstancedGeometry::new(
                            geometry_id,
                            mesh.positions,
                            mesh.normals,
                            mesh.indices,
                        );

                        for (express_id, transform_array, color) in instances {
                            let mut transform_f32 = Vec::with_capacity(16);
                            for val in transform_array.iter() {
                                transform_f32.push(*val as f32);
                            }
                            instanced_geom.add_instance(InstanceData::new(
                                express_id,
                                transform_f32,
                                color,
                            ));
                        }

                        batch_geometries.push(instanced_geom);
                    }

                    if let Some(ref callback) = on_batch {
                        let js_geometries = js_sys::Array::new();
                        for geom in batch_geometries {
                            js_geometries.push(&geom.into());
                        }

                        let progress = js_sys::Object::new();
                        super::set_js_prop(&progress, "percent", &100u32.into());
                        super::set_js_prop(&progress, "phase", &"complete".into());

                        let _ = callback.call2(&JsValue::NULL, &js_geometries, &progress);
                    }
                }

                // Call completion callback
                if let Some(ref callback) = on_complete {
                    let stats = js_sys::Object::new();
                    super::set_js_prop(
                        &stats,
                        "totalGeometries",
                        &(total_geometries as f64).into(),
                    );
                    super::set_js_prop(&stats, "totalInstances", &(total_instances as f64).into());
                    let _ = callback.call1(&JsValue::NULL, &stats);
                }

                let _ = resolve.call0(&JsValue::NULL);
            });
        });

        promise
    }

    /// Parse IFC file with streaming mesh batches for progressive rendering
    /// Calls the callback with batches of meshes, yielding to browser between batches
    ///
    /// Options:
    /// - `batchSize`: Number of meshes per batch (default: 25)
    /// - `onBatch(meshes, progress)`: Called for each batch of meshes
    /// - `onRtcOffset({x, y, z, hasRtc})`: Called early with RTC offset for camera/world setup
    /// - `onColorUpdate(Map<id, color>)`: Called with style updates after initial render
    /// - `onComplete(stats)`: Called when parsing completes with stats including rtcOffset
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// await api.parseMeshesAsync(ifcData, {
    ///   batchSize: 100,
    ///   onRtcOffset: (rtc) => {
    ///     if (rtc.hasRtc) {
    ///       // Model uses large coordinates - adjust camera/world origin
    ///       viewer.setWorldOffset(rtc.x, rtc.y, rtc.z);
    ///     }
    ///   },
    ///   onBatch: (meshes, progress) => {
    ///     for (const mesh of meshes) {
    ///       scene.add(createThreeMesh(mesh));
    ///     }
    ///     console.log(`Progress: ${progress.percent}%`);
    ///   },
    ///   onComplete: (stats) => {
    ///     console.log(`Done! ${stats.totalMeshes} meshes`);
    ///     // stats.rtcOffset also available here: {x, y, z, hasRtc}
    ///   }
    /// });
    /// ```
    #[wasm_bindgen(js_name = parseMeshesAsync)]
    pub fn parse_meshes_async(&self, content: String, options: JsValue) -> js_sys::Promise {
        use super::styling::{
            combined_pre_pass, extract_building_rotation_from_site, resolve_element_color,
        };
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        // Use Option::take() to move ownership into the closure without cloning.
        // This avoids doubling WASM memory usage for large files (700MB+ saves ~700MB).
        let mut content = Some(content);
        let mut options = Some(options);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            let content = content.take().expect("content already taken");
            let options = options.take().expect("options already taken");

            spawn_local(async move {
                // Parse options - smaller default batch size for faster first frame
                let batch_size: usize = js_sys::Reflect::get(&options, &"batchSize".into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .map(|v| v as usize)
                    .unwrap_or(25); // Reduced from 50 for faster first frame

                let on_batch = js_sys::Reflect::get(&options, &"onBatch".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                let on_complete = js_sys::Reflect::get(&options, &"onComplete".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                // Color updates no longer needed — styles are built before geometry processing.
                let _on_color_update = js_sys::Reflect::get(&options, &"onColorUpdate".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                let on_rtc_offset = js_sys::Reflect::get(&options, &"onRtcOffset".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                // ── Phase 1: Build entity index (fast memchr scan, ~200 ms) ──
                let entity_index = ifc_lite_core::build_entity_index(&content);
                let mut decoder = EntityDecoder::with_index(&content, entity_index);

                // ── Phase 2: Single combined pre-pass (~600 ms, was ~3 s for 4 scans) ──
                // Collects geometry styles, void relationships, brep IDs, project ID,
                // and classifies all geometry entities into simple/complex job lists.
                // Replaces: build_geometry_style_index + build_element_style_index +
                //           void pre-pass + processing scan.
                let pre_pass = combined_pre_pass(&content, &mut decoder);

                // Pre-allocate decoder cache to avoid HashMap resize-and-rehash
                // during Phase 3b/4. Each building element + shared placement/repr
                // chain entities = ~2x the job count.
                let total_jobs = pre_pass.simple_jobs.len() + pre_pass.complex_jobs.len();
                decoder.reserve_cache(total_jobs * 2);

                // ── Phase 3: Setup (~150 ms) ──
                // Extract unit scale from collected IfcProject (avoids with_units scan)
                let unit_scale = pre_pass
                    .project_id
                    .and_then(|pid| {
                        ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok()
                    })
                    .unwrap_or(1.0);
                let mut router = GeometryRouter::with_scale(unit_scale);

                // DETECT RTC OFFSET from pre-collected building element jobs (no re-scan)
                // Use both simple AND complex jobs: infrastructure models (IFC4X3) may
                // only have complex-classified elements (e.g., IfcPavement, IfcCourse).
                let rtc_jobs: Vec<_> = pre_pass
                    .simple_jobs
                    .iter()
                    .take(25)
                    .chain(pre_pass.complex_jobs.iter().take(25))
                    .copied()
                    .collect();
                let rtc_offset = router
                    .detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder)
                    .unwrap_or((0.0, 0.0, 0.0));
                let needs_shift = rtc_offset.0.abs() > 10000.0
                    || rtc_offset.1.abs() > 10000.0
                    || rtc_offset.2.abs() > 10000.0;

                if needs_shift {
                    router.set_rtc_offset(rtc_offset);
                }

                // Surface RTC offset to JavaScript callers early so they can prepare camera/world state
                if let Some(ref callback) = on_rtc_offset {
                    let rtc_info = js_sys::Object::new();
                    super::set_js_prop(&rtc_info, "x", &rtc_offset.0.into());
                    super::set_js_prop(&rtc_info, "y", &rtc_offset.1.into());
                    super::set_js_prop(&rtc_info, "z", &rtc_offset.2.into());
                    super::set_js_prop(&rtc_info, "hasRtc", &needs_shift.into());
                    let _ = callback.call1(&JsValue::NULL, &rtc_info);
                }

                // Extract building rotation from pre-collected IfcSite (no re-scan)
                let building_rotation = pre_pass
                    .site_position
                    .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

                // ── Phase 3b: Build element style map + pre-warm decoder cache (~1.2 s) ──
                // Iterates collected jobs (no re-scan!) to:
                //   1. Build element_id → color map for O(1) color lookup during processing
                //   2. Pre-warm the decoder cache with all building elements + repr chains
                // The cache pre-warming is critical: without it, every decode_at_with_id
                // during processing must parse from raw bytes (~35 µs vs ~0.2 µs cache hit).
                // For 208 K elements that's ~7 s of cold-parse overhead.
                let mut element_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
                    rustc_hash::FxHashMap::default();
                // Only walk representation chains if there are actual styled items.
                // Also pre-warms decoder cache (all building elements + repr chains
                // cached for O(1) access during geometry processing).
                if !pre_pass.geometry_styles.is_empty() {
                    for jobs in [&pre_pass.simple_jobs, &pre_pass.complex_jobs] {
                        for &(id, start, end, _ifc_type) in jobs.iter() {
                            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                                if entity.get(6).map(|a| !a.is_null()).unwrap_or(false) {
                                    if let Some(color) = resolve_element_color(
                                        &entity,
                                        &pre_pass.geometry_styles,
                                        &mut decoder,
                                    ) {
                                        element_styles.insert(id, color);
                                    }
                                }
                            }
                        }
                    }
                }

                // ── Phase 4: Process geometry (iterate collected jobs, no re-scan) ──
                let mut processed = 0;
                let mut total_meshes = 0;
                let mut total_vertices = 0;
                let mut total_triangles = 0;
                let mut batch_meshes: Vec<MeshDataJs> = Vec::with_capacity(batch_size);

                // ADAPTIVE BATCHING: Small first batch for fast first render,
                // then large batches for throughput. setTimeout(0) gets clamped to
                // 4ms by browsers after 5 nested calls — with 208K meshes / 25 =
                // 8300 yields × 4ms = 33s of pure yield overhead!
                // With 500-mesh batches: 416 yields × 4ms = 1.7s — a ~30s savings.
                let mut current_batch_size = batch_size; // Start small (25) for fast first frame
                let throughput_batch_size = batch_size.max(500); // Ramp up after first batch

                // Cache IFC type name strings: ~30 unique types repeated across 200K+ meshes.
                let mut type_name_cache: rustc_hash::FxHashMap<ifc_lite_core::IfcType, String> =
                    rustc_hash::FxHashMap::default();

                // Process simple geometry first (walls, slabs, etc.) for fast first frame
                for &(id, start, end, ifc_type) in &pre_pass.simple_jobs {
                    if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                        // Check if entity actually has representation
                        let has_representation =
                            entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                        if has_representation {
                            let has_openings = pre_pass.void_index.contains_key(&id);
                            let default_color = get_default_color_for_type(&ifc_type);
                            let element_color = element_styles.get(&id).copied();
                            let ifc_type_name = type_name_cache
                                .entry(ifc_type)
                                .or_insert_with(|| ifc_type.name().to_string())
                                .clone();

                            // Prefer per-sub-mesh processing so multi-layer
                            // walls keep per-item IfcStyledItem colors. Apply
                            // void subtraction per sub-mesh when the element
                            // has openings; otherwise use the plain sub-mesh
                            // collector. Fall back to the merged mesh path if
                            // neither produces any sub-meshes.
                            let submesh_result = if has_openings {
                                router.process_element_with_submeshes_and_voids(
                                    &entity,
                                    &mut decoder,
                                    &pre_pass.void_index,
                                )
                            } else {
                                router.process_element_with_submeshes(&entity, &mut decoder)
                            };
                            let submesh_ok = submesh_result.ok().filter(|c| !c.is_empty());

                            if let Some(sub_meshes) = submesh_ok {
                                let mat_colors = pre_pass.element_material_styles.get(&id);
                                let mut mat_color_idx = 0usize;

                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }

                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &pre_pass.geometry_styles,
                                        &mut decoder,
                                        mat_colors,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mesh_data = MeshDataJs::new(
                                        id,
                                        ifc_type_name.clone(),
                                        mesh,
                                        color,
                                    );
                                    batch_meshes.push(mesh_data);
                                }
                                processed += 1;
                            } else if let Ok(mut mesh) = router.process_element_with_voids(
                                &entity,
                                &mut decoder,
                                &pre_pass.void_index,
                            ) {
                                if !mesh.is_empty() {
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }

                                    let color = element_color.unwrap_or(default_color);
                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mesh_data = MeshDataJs::new(id, ifc_type_name, mesh, color);
                                    batch_meshes.push(mesh_data);
                                    processed += 1;
                                }
                            }
                        }
                    }

                    // Yield batch when full
                    if batch_meshes.len() >= current_batch_size {
                        if let Some(ref callback) = on_batch {
                            let js_meshes = js_sys::Array::new();
                            for mesh in batch_meshes.drain(..) {
                                js_meshes.push(&mesh.into());
                            }

                            let progress = js_sys::Object::new();
                            super::set_js_prop(&progress, "percent", &0u32.into());
                            super::set_js_prop(&progress, "processed", &(processed as f64).into());
                            super::set_js_prop(&progress, "phase", &"simple".into());

                            let _ = callback.call2(&JsValue::NULL, &js_meshes, &progress);
                            total_meshes += js_meshes.length() as usize;
                        }

                        // After first batch, ramp up batch size for throughput
                        current_batch_size = throughput_batch_size;

                        // Yield to browser
                        // yield removed — sync for speed
                    }
                }

                // Flush remaining simple elements
                if !batch_meshes.is_empty() {
                    if let Some(ref callback) = on_batch {
                        let js_meshes = js_sys::Array::new();
                        for mesh in batch_meshes.drain(..) {
                            js_meshes.push(&mesh.into());
                        }

                        let progress = js_sys::Object::new();
                        super::set_js_prop(&progress, "phase", &"simple_complete".into());

                        let _ = callback.call2(&JsValue::NULL, &js_meshes, &progress);
                        total_meshes += js_meshes.length() as usize;
                    }

                    // yield removed — sync for speed
                }

                let total_elements = processed + pre_pass.complex_jobs.len();

                // CRITICAL: Batch preprocess FacetedBreps BEFORE complex phase
                // This triangulates ALL faces in parallel - massive speedup for repeated geometry
                if !pre_pass.faceted_brep_ids.is_empty() {
                    router.preprocess_faceted_breps(&pre_pass.faceted_brep_ids, &mut decoder);
                    // Clear point_cache after BREP preprocessing — these coordinates
                    // are no longer needed and can be large for complex models.
                    decoder.clear_point_cache();
                }

                // Process complex geometry with proper styles and void subtraction
                // Uses pre-collected job list — no EntityScanner re-scan needed.

                for &(id, start, end, ifc_type) in &pre_pass.complex_jobs {
                    if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                        let has_openings = pre_pass.void_index.contains_key(&id);
                        let ifc_type_name = type_name_cache
                            .entry(ifc_type)
                            .or_insert_with(|| ifc_type.name().to_string())
                            .clone();
                        let default_color = get_default_color_for_type(&ifc_type);
                        // O(1) color lookup from pre-built element style map
                        let element_color = element_styles.get(&id).copied();

                        if has_openings {
                            // Prefer per-sub-mesh void subtraction for correct
                            // per-layer colors; fall back to merged mesh if
                            // every sub-mesh is destroyed or unavailable.
                            let submesh_voids = router
                                .process_element_with_submeshes_and_voids(
                                    &entity,
                                    &mut decoder,
                                    &pre_pass.void_index,
                                )
                                .ok()
                                .filter(|c| !c.is_empty());

                            if let Some(sub_meshes) = submesh_voids {
                                let mat_colors = pre_pass.element_material_styles.get(&id);
                                let mut mat_color_idx = 0usize;

                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }

                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &pre_pass.geometry_styles,
                                        &mut decoder,
                                        mat_colors,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mesh_data = MeshDataJs::new(
                                        id,
                                        ifc_type_name.clone(),
                                        mesh,
                                        color,
                                    );
                                    batch_meshes.push(mesh_data);
                                }
                            } else if let Ok(mut mesh) = router.process_element_with_voids(
                                &entity,
                                &mut decoder,
                                &pre_pass.void_index,
                            ) {
                                if !mesh.is_empty() {
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }

                                    let color = element_color.unwrap_or(default_color);

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mesh_data = MeshDataJs::new(id, ifc_type_name, mesh, color);
                                    batch_meshes.push(mesh_data);
                                }
                            }
                        } else {
                            // No openings - try sub-mesh approach for per-item colors
                            // Skip submesh approach for IfcSite (terrain) - use process_element
                            // which correctly scales ObjectPlacement
                            let skip_submesh = matches!(ifc_type, ifc_lite_core::IfcType::IfcSite);

                            let sub_meshes_result = if skip_submesh {
                                Err(ifc_lite_geometry::Error::geometry(
                                    "Skip submesh for IfcSite".to_string(),
                                ))
                            } else {
                                router.process_element_with_submeshes(&entity, &mut decoder)
                            };

                            let has_submeshes = sub_meshes_result
                                .as_ref()
                                .map(|s| !s.is_empty())
                                .unwrap_or(false);

                            if has_submeshes {
                                // Use sub-meshes for multi-material elements (windows, doors, etc.)
                                let sub_meshes = sub_meshes_result.unwrap();
                                let mat_colors = pre_pass.element_material_styles.get(&id);
                                let mut mat_color_idx = 0usize;

                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }

                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &pre_pass.geometry_styles,
                                        &mut decoder,
                                        mat_colors,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mesh_data =
                                        MeshDataJs::new(id, ifc_type_name.clone(), mesh, color);
                                    batch_meshes.push(mesh_data);
                                }
                            } else {
                                // Fallback: use simple single-mesh approach
                                // This handles elements without IfcStyledItem references
                                if let Ok(mut mesh) = router.process_element(&entity, &mut decoder)
                                {
                                    if !mesh.is_empty() {
                                        if mesh.normals.len() != mesh.positions.len() {
                                            calculate_normals(&mut mesh);
                                        }

                                        let color = element_color.unwrap_or(default_color);

                                        total_vertices += mesh.positions.len() / 3;
                                        total_triangles += mesh.indices.len() / 3;

                                        let mesh_data =
                                            MeshDataJs::new(id, ifc_type_name, mesh, color);
                                        batch_meshes.push(mesh_data);
                                    }
                                }
                            }
                        }
                    }

                    processed += 1;

                    // Yield batch (uses adaptive batch size)
                    if batch_meshes.len() >= current_batch_size {
                        if let Some(ref callback) = on_batch {
                            let js_meshes = js_sys::Array::new();
                            for mesh in batch_meshes.drain(..) {
                                js_meshes.push(&mesh.into());
                            }

                            let progress = js_sys::Object::new();
                            let percent = (processed as f64 / total_elements as f64 * 100.0) as u32;
                            super::set_js_prop(&progress, "percent", &percent.into());
                            super::set_js_prop(&progress, "processed", &(processed as f64).into());
                            super::set_js_prop(&progress, "total", &(total_elements as f64).into());
                            super::set_js_prop(&progress, "phase", &"complex".into());

                            let _ = callback.call2(&JsValue::NULL, &js_meshes, &progress);
                            total_meshes += js_meshes.length() as usize;
                        }

                        // yield removed — sync for speed
                    }
                }

                // Final flush
                if !batch_meshes.is_empty() {
                    if let Some(ref callback) = on_batch {
                        let js_meshes = js_sys::Array::new();
                        for mesh in batch_meshes.drain(..) {
                            js_meshes.push(&mesh.into());
                        }

                        let progress = js_sys::Object::new();
                        super::set_js_prop(&progress, "percent", &100u32.into());
                        super::set_js_prop(&progress, "phase", &"complete".into());

                        let _ = callback.call2(&JsValue::NULL, &js_meshes, &progress);
                        total_meshes += js_meshes.length() as usize;
                    }
                }

                // Free large data structures before the completion callback.
                // The decoder cache + point cache + content string can hold
                // 200-600 MB at this point — releasing them immediately
                // reduces peak WASM memory and prevents GC pressure on the
                // JS side that processes the final callback.
                drop(decoder);
                drop(content);
                drop(element_styles);
                drop(type_name_cache);

                // Call completion callback
                if let Some(ref callback) = on_complete {
                    let stats = js_sys::Object::new();
                    super::set_js_prop(&stats, "totalMeshes", &(total_meshes as f64).into());
                    super::set_js_prop(&stats, "totalVertices", &(total_vertices as f64).into());
                    super::set_js_prop(&stats, "totalTriangles", &(total_triangles as f64).into());
                    // Include RTC offset info in completion stats
                    let rtc_info = js_sys::Object::new();
                    super::set_js_prop(&rtc_info, "x", &rtc_offset.0.into());
                    super::set_js_prop(&rtc_info, "y", &rtc_offset.1.into());
                    super::set_js_prop(&rtc_info, "z", &rtc_offset.2.into());
                    super::set_js_prop(&rtc_info, "hasRtc", &needs_shift.into());
                    super::set_js_prop(&stats, "rtcOffset", &rtc_info);
                    // Include building rotation in completion stats
                    if let Some(rotation) = building_rotation {
                        super::set_js_prop(&stats, "buildingRotation", &rotation.into());
                    }
                    let _ = callback.call1(&JsValue::NULL, &stats);
                }

                let _ = resolve.call0(&JsValue::NULL);
            });
        });

        promise
    }

    /// Parse IFC file and return GPU-ready geometry for zero-copy upload
    ///
    /// This method generates geometry that is:
    /// - Pre-interleaved (position + normal per vertex)
    /// - Coordinate-converted (Z-up to Y-up)
    /// - Ready for direct GPU upload via pointer access
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const gpuGeom = api.parseToGpuGeometry(ifcData);
    ///
    /// // Get WASM memory for zero-copy views
    /// const memory = api.getMemory();
    ///
    /// // Create views directly into WASM memory (NO COPY!)
    /// const vertexView = new Float32Array(
    ///   memory.buffer,
    ///   gpuGeom.vertexDataPtr,
    ///   gpuGeom.vertexDataLen
    /// );
    /// const indexView = new Uint32Array(
    ///   memory.buffer,
    ///   gpuGeom.indicesPtr,
    ///   gpuGeom.indicesLen
    /// );
    ///
    /// // Upload directly to GPU (single copy: WASM → GPU)
    /// device.queue.writeBuffer(vertexBuffer, 0, vertexView);
    /// device.queue.writeBuffer(indexBuffer, 0, indexView);
    ///
    /// // Free when done
    /// gpuGeom.free();
    /// ```
    #[wasm_bindgen(js_name = parseToGpuGeometry)]
    pub fn parse_to_gpu_geometry(&self, content: String) -> GpuGeometry {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        // Build entity index once upfront for O(1) lookups
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Build style index for colors
        let geometry_styles = build_geometry_style_index(&content, &mut decoder);
        let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);

        // Collect FacetedBrep IDs for batch preprocessing
        let mut scanner = EntityScanner::new(&content);
        let mut faceted_brep_ids: Vec<u32> = Vec::new();
        let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name == "IFCFACETEDBREP" {
                faceted_brep_ids.push(id);
            } else if type_name == "IFCRELVOIDSELEMENT" {
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    if let (Some(host_id), Some(opening_id)) =
                        (entity.get_ref(4), entity.get_ref(5))
                    {
                        void_index.entry(host_id).or_default().push(opening_id);
                    }
                }
            }
        }

        // Create geometry router (without RTC offset initially)
        let mut router = GeometryRouter::with_units(&content, &mut decoder);

        // DETECT RTC OFFSET from actual building element transforms
        let rtc_offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        if needs_shift {
            router.set_rtc_offset(rtc_offset);
        }

        // Batch preprocess FacetedBreps
        if !faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
        }

        // Reset scanner for main processing
        scanner = EntityScanner::new(&content);

        // Estimate capacity
        let estimated_vertices = content.len() / 50; // Rough estimate
        let estimated_indices = estimated_vertices * 2;
        let mut gpu_geometry =
            GpuGeometry::with_capacity(estimated_vertices * 6, estimated_indices);

        // Process all building elements
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // Check if entity has representation
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    continue;
                }

                if let Ok(mut mesh) =
                    router.process_element_with_voids(&entity, &mut decoder, &void_index)
                {
                    if !mesh.is_empty() {
                        // Calculate normals if not present or incomplete
                        // CSG operations may produce partial normals, so check for matching count
                        if mesh.normals.len() != mesh.positions.len() {
                            calculate_normals(&mut mesh);
                        }

                        // Get color from style index or default
                        let color = style_index
                            .get(&id)
                            .copied()
                            .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                        // Add to GPU geometry (interleaves and converts coordinates)
                        gpu_geometry.add_mesh(
                            id,
                            entity.ifc_type.name(),
                            &mesh.positions,
                            &mesh.normals,
                            &mesh.indices,
                            color,
                        );
                    }
                }
            }
        }

        // Set RTC offset on the GPU geometry so callers can apply it
        if needs_shift {
            gpu_geometry.set_rtc_offset(rtc_offset.0, rtc_offset.1, rtc_offset.2);
        }

        gpu_geometry
    }

    /// Parse IFC file with streaming GPU-ready geometry batches
    ///
    /// Yields batches of GPU-ready geometry for progressive rendering with zero-copy upload.
    /// Uses fast-first-frame streaming: simple geometry (walls, slabs) first.
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const memory = api.getMemory();
    ///
    /// await api.parseToGpuGeometryAsync(ifcData, {
    ///   batchSize: 25,
    ///   onBatch: (gpuGeom, progress) => {
    ///     // Create zero-copy views
    ///     const vertexView = new Float32Array(
    ///       memory.buffer,
    ///       gpuGeom.vertexDataPtr,
    ///       gpuGeom.vertexDataLen
    ///     );
    ///
    ///     // Upload to GPU
    ///     device.queue.writeBuffer(vertexBuffer, 0, vertexView);
    ///
    ///     // IMPORTANT: Free immediately after upload!
    ///     gpuGeom.free();
    ///   },
    ///   onComplete: (stats) => {
    ///     console.log(`Done! ${stats.totalMeshes} meshes`);
    ///   }
    /// });
    /// ```
    #[wasm_bindgen(js_name = parseToGpuGeometryAsync)]
    pub fn parse_to_gpu_geometry_async(
        &self,
        content: String,
        options: JsValue,
    ) -> js_sys::Promise {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        // Use Option::take() to move ownership into the closure without cloning.
        // This avoids doubling WASM memory usage for large files (700MB+ saves ~700MB).
        let mut content = Some(content);
        let mut options = Some(options);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            let content = content.take().expect("content already taken");
            let options = options.take().expect("options already taken");

            spawn_local(async move {
                // Parse options
                let batch_size: usize = js_sys::Reflect::get(&options, &"batchSize".into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .map(|v| v as usize)
                    .unwrap_or(25);

                let on_batch = js_sys::Reflect::get(&options, &"onBatch".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                let on_complete = js_sys::Reflect::get(&options, &"onComplete".into())
                    .ok()
                    .and_then(|v| v.dyn_into::<Function>().ok());

                // Build entity index
                let entity_index = build_entity_index(&content);
                let mut decoder = EntityDecoder::with_index(&content, entity_index);

                // Build style index
                let geometry_styles = build_geometry_style_index(&content, &mut decoder);
                let style_index =
                    build_element_style_index(&content, &geometry_styles, &mut decoder);

                // Collect FacetedBrep IDs and void relationships
                let mut scanner = EntityScanner::new(&content);
                let mut faceted_brep_ids: Vec<u32> = Vec::new();
                let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> =
                    rustc_hash::FxHashMap::default();

                while let Some((id, type_name, start, end)) = scanner.next_entity() {
                    if type_name == "IFCFACETEDBREP" {
                        faceted_brep_ids.push(id);
                    } else if type_name == "IFCRELVOIDSELEMENT" {
                        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                            if let (Some(host_id), Some(opening_id)) =
                                (entity.get_ref(4), entity.get_ref(5))
                            {
                                void_index.entry(host_id).or_default().push(opening_id);
                            }
                        }
                    }
                }

                // Create geometry router
                let mut router = GeometryRouter::with_units(&content, &mut decoder);

                // DETECT RTC OFFSET from actual building element transforms
                let rtc_offset =
                    router.detect_rtc_offset_from_first_element(&content, &mut decoder);
                let needs_shift = rtc_offset.0.abs() > 10000.0
                    || rtc_offset.1.abs() > 10000.0
                    || rtc_offset.2.abs() > 10000.0;

                if needs_shift {
                    router.set_rtc_offset(rtc_offset);
                }

                // Batch preprocess FacetedBreps
                if !faceted_brep_ids.is_empty() {
                    router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
                }

                // Reset scanner
                scanner = EntityScanner::new(&content);

                // Processing state
                let mut current_batch =
                    GpuGeometry::with_capacity(batch_size * 1000, batch_size * 3000);
                let mut processed = 0;
                let mut total_meshes = 0;
                let mut total_vertices = 0;
                let mut total_triangles = 0;
                let mut deferred_complex: Vec<(u32, usize, usize, ifc_lite_core::IfcType)> =
                    Vec::new();

                // Helper to flush current batch (captures RTC offset for each batch)
                let flush_batch =
                    |batch: &mut GpuGeometry, on_batch: &Option<Function>, progress: &JsValue| {
                        if batch.mesh_count() == 0 {
                            return;
                        }

                        if let Some(ref callback) = on_batch {
                            // Swap out the batch and set RTC offset before sending
                            let mut to_send =
                                std::mem::replace(batch, GpuGeometry::with_capacity(1000, 3000));
                            if needs_shift {
                                to_send.set_rtc_offset(rtc_offset.0, rtc_offset.1, rtc_offset.2);
                            }
                            let _ = callback.call2(&JsValue::NULL, &to_send.into(), progress);
                        } else {
                            batch.clear();
                        }
                    };

                // First pass - process simple geometry immediately
                while let Some((id, type_name, start, end)) = scanner.next_entity() {
                    if !ifc_lite_core::has_geometry_by_name(type_name) {
                        continue;
                    }

                    let ifc_type = ifc_lite_core::IfcType::from_str(type_name);

                    // Simple geometry: process immediately
                    if matches!(
                        type_name,
                        "IFCWALL"
                            | "IFCWALLSTANDARDCASE"
                            | "IFCSLAB"
                            | "IFCBEAM"
                            | "IFCCOLUMN"
                            | "IFCPLATE"
                            | "IFCROOF"
                            | "IFCCOVERING"
                            | "IFCFOOTING"
                            | "IFCRAILING"
                            | "IFCSTAIR"
                            | "IFCSTAIRFLIGHT"
                            | "IFCRAMP"
                            | "IFCRAMPFLIGHT"
                    ) {
                        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                            let has_representation =
                                entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                            if has_representation {
                                if let Ok(mut mesh) = router.process_element_with_voids(
                                    &entity,
                                    &mut decoder,
                                    &void_index,
                                ) {
                                    if !mesh.is_empty() {
                                        if mesh.normals.len() != mesh.positions.len() {
                                            calculate_normals(&mut mesh);
                                        }

                                        let color =
                                            style_index.get(&id).copied().unwrap_or_else(|| {
                                                get_default_color_for_type(&ifc_type)
                                            });

                                        total_vertices += mesh.positions.len() / 3;
                                        total_triangles += mesh.indices.len() / 3;

                                        current_batch.add_mesh(
                                            id,
                                            ifc_type.name(),
                                            &mesh.positions,
                                            &mesh.normals,
                                            &mesh.indices,
                                            color,
                                        );
                                        processed += 1;
                                        total_meshes += 1;
                                    }
                                }
                            }
                        }

                        // Yield batch when full
                        if current_batch.mesh_count() >= batch_size {
                            let progress = js_sys::Object::new();
                            super::set_js_prop(&progress, "percent", &0u32.into());
                            super::set_js_prop(&progress, "processed", &(processed as f64).into());
                            super::set_js_prop(&progress, "phase", &"simple".into());

                            flush_batch(&mut current_batch, &on_batch, &progress.into());

                            // Yield to browser
                            // yield removed — sync for speed
                        }
                    } else {
                        // Defer complex geometry
                        deferred_complex.push((id, start, end, ifc_type));
                    }
                }

                // Flush remaining simple geometry
                if current_batch.mesh_count() > 0 {
                    let progress = js_sys::Object::new();
                    super::set_js_prop(&progress, "phase", &"simple_complete".into());
                    flush_batch(&mut current_batch, &on_batch, &progress.into());
                    // yield removed — sync for speed
                }

                // Process deferred complex geometry
                let total_elements = processed + deferred_complex.len();
                for (id, start, end, ifc_type) in deferred_complex {
                    if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                        if let Ok(mut mesh) =
                            router.process_element_with_voids(&entity, &mut decoder, &void_index)
                        {
                            if !mesh.is_empty() {
                                if mesh.normals.len() != mesh.positions.len() {
                                    calculate_normals(&mut mesh);
                                }

                                let color = style_index
                                    .get(&id)
                                    .copied()
                                    .unwrap_or_else(|| get_default_color_for_type(&ifc_type));

                                total_vertices += mesh.positions.len() / 3;
                                total_triangles += mesh.indices.len() / 3;

                                current_batch.add_mesh(
                                    id,
                                    ifc_type.name(),
                                    &mesh.positions,
                                    &mesh.normals,
                                    &mesh.indices,
                                    color,
                                );
                                total_meshes += 1;
                            }
                        }
                    }

                    processed += 1;

                    // Yield batch when full
                    if current_batch.mesh_count() >= batch_size {
                        let progress = js_sys::Object::new();
                        let percent = (processed as f64 / total_elements as f64 * 100.0) as u32;
                        super::set_js_prop(&progress, "percent", &percent.into());
                        super::set_js_prop(&progress, "processed", &(processed as f64).into());
                        super::set_js_prop(&progress, "total", &(total_elements as f64).into());
                        super::set_js_prop(&progress, "phase", &"complex".into());

                        flush_batch(&mut current_batch, &on_batch, &progress.into());
                        // yield removed — sync for speed
                    }
                }

                // Final flush
                if current_batch.mesh_count() > 0 {
                    let progress = js_sys::Object::new();
                    super::set_js_prop(&progress, "percent", &100u32.into());
                    super::set_js_prop(&progress, "phase", &"complete".into());
                    flush_batch(&mut current_batch, &on_batch, &progress.into());
                }

                // Call completion callback
                if let Some(ref callback) = on_complete {
                    let stats = js_sys::Object::new();
                    super::set_js_prop(&stats, "totalMeshes", &(total_meshes as f64).into());
                    super::set_js_prop(&stats, "totalVertices", &(total_vertices as f64).into());
                    super::set_js_prop(&stats, "totalTriangles", &(total_triangles as f64).into());

                    // Include RTC offset if applied
                    if needs_shift {
                        let rtc_obj = js_sys::Object::new();
                        super::set_js_prop(&rtc_obj, "x", &rtc_offset.0.into());
                        super::set_js_prop(&rtc_obj, "y", &rtc_offset.1.into());
                        super::set_js_prop(&rtc_obj, "z", &rtc_offset.2.into());
                        super::set_js_prop(&stats, "rtcOffset", &rtc_obj);
                    }

                    let _ = callback.call1(&JsValue::NULL, &stats);
                }

                let _ = resolve.call0(&JsValue::NULL);
            });
        });

        promise
    }

    /// Parse IFC file to GPU-ready instanced geometry for zero-copy upload
    ///
    /// Groups identical geometries by hash for efficient GPU instancing.
    /// Returns a collection of instanced geometries with pointer access.
    #[wasm_bindgen(js_name = parseToGpuInstancedGeometry)]
    pub fn parse_to_gpu_instanced_geometry(
        &self,
        content: String,
    ) -> GpuInstancedGeometryCollection {
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
        use ifc_lite_geometry::{calculate_normals, GeometryRouter, Mesh};
        use rustc_hash::FxHashMap;
        use rustc_hash::FxHasher;
        use std::hash::{Hash, Hasher};

        // Build entity index
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Build style index
        let geometry_styles = build_geometry_style_index(&content, &mut decoder);
        let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);

        // Collect FacetedBrep IDs
        let mut scanner = EntityScanner::new(&content);
        let mut faceted_brep_ids: Vec<u32> = Vec::new();

        while let Some((id, type_name, _, _)) = scanner.next_entity() {
            if type_name == "IFCFACETEDBREP" {
                faceted_brep_ids.push(id);
            }
        }

        // Create geometry router
        let router = GeometryRouter::with_units(&content, &mut decoder);

        // Batch preprocess FacetedBreps
        if !faceted_brep_ids.is_empty() {
            router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
        }

        // Reset scanner
        scanner = EntityScanner::new(&content);

        // Group meshes by geometry hash
        #[allow(clippy::type_complexity)]
        let mut geometry_groups: FxHashMap<u64, (Mesh, Vec<(u32, [f64; 16], [f32; 4])>)> =
            FxHashMap::default();

        // Process all building elements
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Ok((mut mesh, transform)) =
                    router.process_element_with_transform(&entity, &mut decoder)
                {
                    if !mesh.is_empty() {
                        if mesh.normals.len() != mesh.positions.len() {
                            calculate_normals(&mut mesh);
                        }

                        // Compute geometry hash
                        let mut hasher = FxHasher::default();
                        mesh.positions.len().hash(&mut hasher);
                        mesh.indices.len().hash(&mut hasher);
                        for pos in &mesh.positions {
                            pos.to_bits().hash(&mut hasher);
                        }
                        for idx in &mesh.indices {
                            idx.hash(&mut hasher);
                        }
                        let geometry_hash = hasher.finish();

                        // Get color
                        let color = style_index
                            .get(&id)
                            .copied()
                            .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                        // Convert transform to column-major array
                        let mut transform_array = [0.0f64; 16];
                        for col in 0..4 {
                            for row in 0..4 {
                                transform_array[col * 4 + row] = transform[(row, col)];
                            }
                        }

                        // Add to group
                        let entry = geometry_groups.entry(geometry_hash);
                        match entry {
                            std::collections::hash_map::Entry::Occupied(mut o) => {
                                o.get_mut().1.push((id, transform_array, color));
                            }
                            std::collections::hash_map::Entry::Vacant(v) => {
                                v.insert((mesh, vec![(id, transform_array, color)]));
                            }
                        }
                    }
                }
            }
        }

        // Convert to GPU instanced geometry collection
        let mut collection = GpuInstancedGeometryCollection::new();

        for (geometry_id, (mesh, instances)) in geometry_groups {
            let mut gpu_instanced = GpuInstancedGeometry::new(geometry_id);

            // Set shared geometry (interleaves and converts coordinates)
            gpu_instanced.set_geometry(&mesh.positions, &mesh.normals, &mesh.indices);

            // Add instances
            for (express_id, transform, color) in instances {
                // Convert f64 transform to f32
                let mut transform_f32 = [0.0f32; 16];
                for (i, &val) in transform.iter().enumerate() {
                    transform_f32[i] = val as f32;
                }
                gpu_instanced.add_instance(express_id, &transform_f32, color);
            }

            collection.add(gpu_instanced);
        }

        collection
    }

    /// Run the pre-pass ONCE and return serialized results for worker distribution.
    /// Takes raw bytes (&[u8]) to avoid TextDecoder overhead.
    #[wasm_bindgen(js_name = buildPrePassOnce)]
    pub fn build_pre_pass_once(&self, data: &[u8]) -> JsValue {
        use super::styling::{combined_pre_pass, extract_building_rotation_from_site};
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::GeometryRouter;

        let content = decode_ifc_bytes(data);

        // Build entity index
        let entity_index = ifc_lite_core::build_entity_index(content);
        // Cache for reuse by processGeometryBatch
        *self.cached_entity_index.borrow_mut() = Some(entity_index.clone());
        let mut decoder = EntityDecoder::with_index(content, entity_index);

        // Run combined pre-pass
        let pre_pass = combined_pre_pass(content, &mut decoder);

        // Extract unit scale
        let unit_scale = pre_pass
            .project_id
            .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
            .unwrap_or(1.0);
        let mut router = GeometryRouter::with_scale(unit_scale);

        // Detect RTC offset
        let rtc_jobs: Vec<_> = pre_pass
            .simple_jobs
            .iter()
            .take(25)
            .chain(pre_pass.complex_jobs.iter().take(25))
            .copied()
            .collect();
        let rtc_offset = router
            .detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder)
            .unwrap_or((0.0, 0.0, 0.0));
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        // Extract building rotation
        let building_rotation = pre_pass
            .site_position
            .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

        // Build combined job list: simple first, then complex
        let total_jobs = pre_pass.simple_jobs.len() + pre_pass.complex_jobs.len();

        // Serialize jobs as flat Uint32Array: [id, start, end, id, start, end, ...]
        let jobs_flat = js_sys::Uint32Array::new_with_length((total_jobs * 3) as u32);
        let mut idx = 0u32;
        for &(id, start, end, _ifc_type) in pre_pass
            .simple_jobs
            .iter()
            .chain(pre_pass.complex_jobs.iter())
        {
            jobs_flat.set_index(idx, id);
            jobs_flat.set_index(idx + 1, start as u32);
            jobs_flat.set_index(idx + 2, end as u32);
            idx += 3;
        }

        // Serialize void_index as 3 flat arrays: keys, counts, values
        let void_keys_vec: Vec<u32> = pre_pass.void_index.keys().copied().collect();
        let mut void_counts_vec: Vec<u32> = Vec::with_capacity(void_keys_vec.len());
        let mut void_values_vec: Vec<u32> = Vec::new();
        for &key in &void_keys_vec {
            if let Some(openings) = pre_pass.void_index.get(&key) {
                void_counts_vec.push(openings.len() as u32);
                void_values_vec.extend_from_slice(openings);
            }
        }

        let void_keys = js_sys::Uint32Array::new_with_length(void_keys_vec.len() as u32);
        for (i, &k) in void_keys_vec.iter().enumerate() {
            void_keys.set_index(i as u32, k);
        }
        let void_counts = js_sys::Uint32Array::new_with_length(void_counts_vec.len() as u32);
        for (i, &c) in void_counts_vec.iter().enumerate() {
            void_counts.set_index(i as u32, c);
        }
        let void_values = js_sys::Uint32Array::new_with_length(void_values_vec.len() as u32);
        for (i, &v) in void_values_vec.iter().enumerate() {
            void_values.set_index(i as u32, v);
        }

        // Serialize geometry_styles as two arrays: styleIds (u32) + styleColors (u8 RGBA)
        let styles_len = pre_pass.geometry_styles.len();
        let style_ids = js_sys::Uint32Array::new_with_length(styles_len as u32);
        let style_colors = js_sys::Uint8Array::new_with_length((styles_len * 4) as u32);
        let mut si = 0u32;
        for (&id, &color) in &pre_pass.geometry_styles {
            style_ids.set_index(si, id);
            let ci = si * 4;
            style_colors.set_index(ci, (color[0] * 255.0) as u8);
            style_colors.set_index(ci + 1, (color[1] * 255.0) as u8);
            style_colors.set_index(ci + 2, (color[2] * 255.0) as u8);
            style_colors.set_index(ci + 3, (color[3] * 255.0) as u8);
            si += 1;
        }

        // Serialize faceted_brep_ids
        let faceted_brep_ids =
            js_sys::Uint32Array::new_with_length(pre_pass.faceted_brep_ids.len() as u32);
        for (i, &id) in pre_pass.faceted_brep_ids.iter().enumerate() {
            faceted_brep_ids.set_index(i as u32, id);
        }

        // Build result object
        let result = js_sys::Object::new();
        super::set_js_prop(&result, "jobs", &jobs_flat);
        super::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        super::set_js_prop(&result, "unitScale", &unit_scale.into());

        let rtc_arr = js_sys::Float64Array::new_with_length(3);
        rtc_arr.set_index(0, rtc_offset.0);
        rtc_arr.set_index(1, rtc_offset.1);
        rtc_arr.set_index(2, rtc_offset.2);
        super::set_js_prop(&result, "rtcOffset", &rtc_arr);
        super::set_js_prop(&result, "needsShift", &needs_shift.into());

        match building_rotation {
            Some(rot) => super::set_js_prop(&result, "buildingRotation", &rot.into()),
            None => super::set_js_prop(&result, "buildingRotation", &JsValue::NULL),
        };

        super::set_js_prop(&result, "voidKeys", &void_keys);
        super::set_js_prop(&result, "voidCounts", &void_counts);
        super::set_js_prop(&result, "voidValues", &void_values);
        super::set_js_prop(&result, "styleIds", &style_ids);
        super::set_js_prop(&result, "styleColors", &style_colors);
        super::set_js_prop(&result, "facetedBrepIds", &faceted_brep_ids);

        result.into()
    }

    /// Fast pre-pass: scans for geometry entities ONLY (skips style/void/material resolution).
    /// Returns job list + unit scale + RTC offset in ~1-2s instead of ~6s.
    /// Geometry workers can start immediately with default colors + no void subtraction.
    /// A parallel style worker can run buildPrePassOnce for correct colors later.
    #[wasm_bindgen(js_name = buildPrePassFast)]
    pub fn build_pre_pass_fast(&self, data: &[u8]) -> JsValue {
        use super::styling::{extract_building_rotation_from_site, is_simple_geometry_type};
        use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
        use ifc_lite_geometry::GeometryRouter;

        let content = decode_ifc_bytes(data);

        let mut scanner = EntityScanner::new(content);
        let estimated = content.len() / 2000;
        let mut simple_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(estimated / 2);
        let mut complex_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(estimated / 2);
        let mut project_id: Option<u32> = None;
        let mut site_position: Option<(u32, usize, usize)> = None;

        // Fast scan: only collect geometry entity locations + project/site
        // Skip ALL style/void/material/brep collection
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            match type_name {
                "IFCPROJECT" => {
                    if project_id.is_none() {
                        project_id = Some(id);
                    }
                }
                "IFCSITE" => {
                    if site_position.is_none() {
                        site_position = Some((id, start, end));
                    }
                    let ifc_type = IfcType::from_str(type_name);
                    complex_jobs.push((id, start, end, ifc_type));
                }
                _ => {
                    if ifc_lite_core::has_geometry_by_name(type_name) {
                        let ifc_type = IfcType::from_str(type_name);
                        if is_simple_geometry_type(type_name) {
                            simple_jobs.push((id, start, end, ifc_type));
                        } else {
                            complex_jobs.push((id, start, end, ifc_type));
                        }
                    }
                }
            }
        }

        // Resolve unit scale + RTC offset (needs entity index for decoder)
        let entity_index = ifc_lite_core::build_entity_index(content);
        // Cache for reuse by processGeometryBatch
        *self.cached_entity_index.borrow_mut() = Some(entity_index.clone());
        let mut decoder = EntityDecoder::with_index(content, entity_index);

        let unit_scale = project_id
            .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
            .unwrap_or(1.0);
        let mut router = GeometryRouter::with_scale(unit_scale);

        let rtc_jobs: Vec<_> = simple_jobs
            .iter()
            .take(25)
            .chain(complex_jobs.iter().take(25))
            .copied()
            .collect();
        let rtc_offset = router
            .detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder)
            .unwrap_or((0.0, 0.0, 0.0));
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        let building_rotation =
            site_position.and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

        // Serialize job list
        let total_jobs = simple_jobs.len() + complex_jobs.len();
        let jobs_flat = js_sys::Uint32Array::new_with_length((total_jobs * 3) as u32);
        let mut idx = 0u32;
        for &(id, start, end, _) in simple_jobs.iter().chain(complex_jobs.iter()) {
            jobs_flat.set_index(idx, id);
            jobs_flat.set_index(idx + 1, start as u32);
            jobs_flat.set_index(idx + 2, end as u32);
            idx += 3;
        }

        let result = js_sys::Object::new();
        super::set_js_prop(&result, "jobs", &jobs_flat);
        super::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        super::set_js_prop(&result, "unitScale", &unit_scale.into());

        let rtc_arr = js_sys::Float64Array::new_with_length(3);
        rtc_arr.set_index(0, rtc_offset.0);
        rtc_arr.set_index(1, rtc_offset.1);
        rtc_arr.set_index(2, rtc_offset.2);
        super::set_js_prop(&result, "rtcOffset", &rtc_arr);
        super::set_js_prop(&result, "needsShift", &needs_shift.into());

        match building_rotation {
            Some(rot) => super::set_js_prop(&result, "buildingRotation", &rot.into()),
            None => super::set_js_prop(&result, "buildingRotation", &JsValue::NULL),
        };

        // Empty style/void arrays — workers use default colors, no void subtraction
        super::set_js_prop(
            &result,
            "voidKeys",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "voidCounts",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "voidValues",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "styleIds",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "styleColors",
            &js_sys::Uint8Array::new_with_length(0),
        );

        result.into()
    }

    /// Process geometry for a subset of pre-scanned entities.
    /// Takes raw bytes and pre-pass data from buildPrePassOnce.
    #[wasm_bindgen(js_name = processGeometryBatch)]
    pub fn process_geometry_batch(
        &self,
        data: &[u8],
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        void_keys: &[u32],
        void_counts: &[u32],
        void_values: &[u32],
        style_ids: &[u32],   // geometry style entity IDs
        style_colors: &[u8], // [r, g, b, a, r, g, b, a, ...] (0-255)
    ) -> MeshCollection {
        use super::styling::{
            get_default_color_for_type, resolve_element_color, resolve_submesh_color,
        };
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        let content = decode_ifc_bytes(data);

        // Reuse cached entity index from buildPrePassOnce if available
        let entity_index = self.cached_entity_index.borrow().clone()
            .unwrap_or_else(|| ifc_lite_core::build_entity_index(content));
        let mut decoder = EntityDecoder::with_index(content, entity_index);

        // Create geometry router with unit scale
        let mut router = GeometryRouter::with_scale(unit_scale);

        // Set RTC offset if needed
        if needs_shift {
            router.set_rtc_offset((rtc_x, rtc_y, rtc_z));
        }

        // Reconstruct void_index from flat arrays
        let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
        let mut value_offset = 0usize;
        for i in 0..void_keys.len() {
            let host_id = void_keys[i];
            let count = void_counts[i] as usize;
            let openings = void_values[value_offset..value_offset + count].to_vec();
            void_index.insert(host_id, openings);
            value_offset += count;
        }

        // Reconstruct geometry_styles from flat arrays
        let mut geometry_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        for i in 0..style_ids.len() {
            let base = i * 4;
            if base + 3 < style_colors.len() {
                geometry_styles.insert(
                    style_ids[i],
                    [
                        style_colors[base] as f32 / 255.0,
                        style_colors[base + 1] as f32 / 255.0,
                        style_colors[base + 2] as f32 / 255.0,
                        style_colors[base + 3] as f32 / 255.0,
                    ],
                );
            }
        }

        // Build element_styles by resolving colors for each entity in this batch
        let mut element_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        if !geometry_styles.is_empty() {
            for chunk in jobs_flat.chunks(3) {
                if chunk.len() < 3 {
                    break;
                }
                let id = chunk[0];
                let start = chunk[1] as usize;
                let end = chunk[2] as usize;
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    if entity.get(6).map(|a| !a.is_null()).unwrap_or(false) {
                        if let Some(color) =
                            resolve_element_color(&entity, &geometry_styles, &mut decoder)
                        {
                            element_styles.insert(id, color);
                        }
                    }
                }
            }
        }

        // Pre-allocate
        let num_jobs = jobs_flat.len() / 3;
        decoder.reserve_cache(num_jobs * 2);
        let mut mesh_collection = MeshCollection::with_capacity(num_jobs);

        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }

        // Cache IFC type name strings
        let mut type_name_cache: rustc_hash::FxHashMap<ifc_lite_core::IfcType, String> =
            rustc_hash::FxHashMap::default();

        // Process only the entities specified in jobs_flat
        for chunk in jobs_flat.chunks(3) {
            if chunk.len() < 3 {
                break;
            }
            let id = chunk[0];
            let start = chunk[1] as usize;
            let end = chunk[2] as usize;

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    continue;
                }

                let ifc_type = entity.ifc_type;
                let has_openings = void_index.contains_key(&id);

                if has_openings {
                    if let Ok(mut mesh) =
                        router.process_element_with_voids(&entity, &mut decoder, &void_index)
                    {
                        if !mesh.is_empty() {
                            if mesh.normals.len() != mesh.positions.len() {
                                calculate_normals(&mut mesh);
                            }
                            let color = element_styles
                                .get(&id)
                                .copied()
                                .unwrap_or_else(|| get_default_color_for_type(&ifc_type));
                            let ifc_type_name = type_name_cache
                                .entry(ifc_type)
                                .or_insert_with(|| ifc_type.name().to_string())
                                .clone();
                            mesh_collection.add(MeshDataJs::new(id, ifc_type_name, mesh, color));
                        }
                    }
                } else {
                    // Only use expensive sub-mesh processing for types that need
                    // per-item colors (windows with glass transparency, doors, etc).
                    // Skip for ~90% of entities (beams, columns, slabs, walls).
                    let needs_submesh = matches!(
                        ifc_type,
                        ifc_lite_core::IfcType::IfcWindow
                            | ifc_lite_core::IfcType::IfcDoor
                            | ifc_lite_core::IfcType::IfcCurtainWall
                            | ifc_lite_core::IfcType::IfcPlate
                            | ifc_lite_core::IfcType::IfcMember
                    );

                    let mut used_submesh = false;
                    if needs_submesh {
                        if let Ok(sub_meshes) =
                            router.process_element_with_submeshes(&entity, &mut decoder)
                        {
                            if !sub_meshes.is_empty() {
                                let default_color = get_default_color_for_type(&ifc_type);
                                let element_color = element_styles.get(&id).copied();
                                let mut mat_color_idx = 0usize;
                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }
                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &geometry_styles,
                                        &mut decoder,
                                        None,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );
                                    let ifc_type_name = type_name_cache
                                        .entry(ifc_type)
                                        .or_insert_with(|| ifc_type.name().to_string())
                                        .clone();
                                    mesh_collection.add(MeshDataJs::new(
                                        id,
                                        ifc_type_name,
                                        mesh,
                                        color,
                                    ));
                                    used_submesh = true;
                                }
                            }
                        }
                    }

                    if !used_submesh {
                        // Use submesh path even for non-whitelisted types so that
                        // unsupported representation items are skipped instead of
                        // aborting the entire element (process_element uses `?`).
                        if let Ok(sub_meshes) =
                            router.process_element_with_submeshes(&entity, &mut decoder)
                        {
                            if !sub_meshes.is_empty() {
                                let default_color = get_default_color_for_type(&ifc_type);
                                let element_color = element_styles.get(&id).copied();
                                let mut mat_color_idx = 0usize;
                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }
                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &geometry_styles,
                                        &mut decoder,
                                        None,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );
                                    let ifc_type_name = type_name_cache
                                        .entry(ifc_type)
                                        .or_insert_with(|| ifc_type.name().to_string())
                                        .clone();
                                    mesh_collection.add(MeshDataJs::new(
                                        id,
                                        ifc_type_name,
                                        mesh,
                                        color,
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        mesh_collection
    }

    /// Process instanced geometry for a subset of pre-scanned entities.
    /// Takes raw bytes and pre-pass data from buildPrePassOnce.
    #[wasm_bindgen(js_name = processInstancedGeometryBatch)]
    pub fn process_instanced_geometry_batch(
        &self,
        data: &[u8],
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        style_ids: &[u32],
        style_colors: &[u8],
    ) -> InstancedMeshCollection {
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryRouter, Mesh};
        use rustc_hash::{FxHashMap, FxHasher};
        use std::hash::{Hash, Hasher};

        let content = decode_ifc_bytes(data);

        // Reuse cached entity index from buildPrePassOnce if available
        let entity_index = self.cached_entity_index.borrow().clone()
            .unwrap_or_else(|| ifc_lite_core::build_entity_index(content));
        let mut decoder = EntityDecoder::with_index(content, entity_index);

        let mut router = GeometryRouter::with_scale(unit_scale);
        if needs_shift {
            router.set_rtc_offset((rtc_x, rtc_y, rtc_z));
        }

        let mut geometry_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        for i in 0..style_ids.len() {
            let base = i * 4;
            if base + 3 < style_colors.len() {
                geometry_styles.insert(
                    style_ids[i],
                    [
                        style_colors[base] as f32 / 255.0,
                        style_colors[base + 1] as f32 / 255.0,
                        style_colors[base + 2] as f32 / 255.0,
                        style_colors[base + 3] as f32 / 255.0,
                    ],
                );
            }
        }

        let mut element_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        if !geometry_styles.is_empty() {
            for chunk in jobs_flat.chunks(3) {
                if chunk.len() < 3 {
                    break;
                }
                let id = chunk[0];
                let start = chunk[1] as usize;
                let end = chunk[2] as usize;
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    if entity.get(6).map(|a| !a.is_null()).unwrap_or(false) {
                        if let Some(color) =
                            resolve_element_color(&entity, &geometry_styles, &mut decoder)
                        {
                            element_styles.insert(id, color);
                        }
                    }
                }
            }
        }

        let num_jobs = jobs_flat.len() / 3;
        decoder.reserve_cache(num_jobs * 2);

        #[allow(clippy::type_complexity)]
        let mut geometry_groups: FxHashMap<u64, (Mesh, Vec<(u32, [f64; 16], [f32; 4])>)> =
            FxHashMap::default();

        for chunk in jobs_flat.chunks(3) {
            if chunk.len() < 3 {
                break;
            }

            let id = chunk[0];
            let start = chunk[1] as usize;
            let end = chunk[2] as usize;

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    continue;
                }

                if let Ok((mut mesh, transform)) =
                    router.process_element_with_transform(&entity, &mut decoder)
                {
                    if mesh.is_empty() {
                        continue;
                    }

                    if mesh.normals.len() != mesh.positions.len() {
                        calculate_normals(&mut mesh);
                    }

                    let mut hasher = FxHasher::default();
                    mesh.positions.len().hash(&mut hasher);
                    mesh.indices.len().hash(&mut hasher);
                    for pos in &mesh.positions {
                        pos.to_bits().hash(&mut hasher);
                    }
                    for idx in &mesh.indices {
                        idx.hash(&mut hasher);
                    }
                    let geometry_hash = hasher.finish();

                    let color = element_styles
                        .get(&id)
                        .copied()
                        .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                    let mut transform_array = [0.0; 16];
                    for col in 0..4 {
                        for row in 0..4 {
                            transform_array[col * 4 + row] = transform[(row, col)];
                        }
                    }

                    match geometry_groups.entry(geometry_hash) {
                        std::collections::hash_map::Entry::Occupied(mut entry) => {
                            entry.get_mut().1.push((id, transform_array, color));
                        }
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert((mesh, vec![(id, transform_array, color)]));
                        }
                    }
                }
            }
        }

        let mut collection = InstancedMeshCollection::new();
        for (geometry_id, (mesh, instances)) in geometry_groups {
            let mut instanced_geom =
                InstancedGeometry::new(geometry_id, mesh.positions, mesh.normals, mesh.indices);

            for (express_id, transform_array, color) in instances {
                let mut transform_f32 = Vec::with_capacity(16);
                for val in transform_array.iter() {
                    transform_f32.push(*val as f32);
                }
                instanced_geom.add_instance(InstanceData::new(express_id, transform_f32, color));
            }

            collection.add(instanced_geom);
        }

        collection
    }
}
