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

        // Build style index: first map geometry IDs to colors, then map element IDs to colors.
        // `geometry_shading_styles` carries the SurfaceColour for styled
        // items whose DiffuseColour differs — used by the GLB exporter's
        // "Shading" colour source (sparse, only present when authored).
        let style_indexes = super::styling::build_geometry_style_indexes(&content, &mut decoder);
        let mut geometry_styles = style_indexes.colors;
        let geometry_shading_styles = style_indexes.shading_colors;
        let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);
        // Build material-based styles for sub-element color fallback (windows, doors)
        let element_material_styles =
            build_element_material_styles_from_content(&content, &mut decoder);

        // Build material_id → color (merged into geometry_styles so per-layer
        // slices resolve their colour through the normal geometry lookup path)
        // plus the material-layer buildup index for single-solid slicing.
        let material_color_index = super::styling::build_material_color_index_from_content(
            &content, &mut decoder,
        );
        for (&mat_id, &color) in &material_color_index {
            geometry_styles.entry(mat_id).or_insert(color);
        }
        let material_layer_index = std::sync::Arc::new(
            ifc_lite_geometry::MaterialLayerIndex::from_content(&content, &mut decoder),
        );

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
        // Also collects the part → parent map used for the merge-layers toggle (#540).
        let part_to_parent =
            ifc_lite_geometry::propagate_voids_to_parts(&mut void_index, &content, &mut decoder);

        // Build the skip set for the merge-layers toggle: when enabled and
        // the parent wall is sliceable (i.e. its single solid will be cut
        // into per-layer slabs via `MaterialLayerIndex`), skip emitting the
        // child part meshes entirely. Empty set when the toggle is off so
        // existing behaviour is preserved (set lookups are O(1) but still
        // free when empty).
        let parts_to_skip: rustc_hash::FxHashSet<u32> = if self.merge_layers() {
            part_to_parent
                .iter()
                .filter(|(_, parent_id)| material_layer_index.is_sliceable(**parent_id))
                .map(|(part_id, _)| *part_id)
                .collect()
        } else {
            rustc_hash::FxHashSet::default()
        };

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

        // Attach the material-layer index so single-solid multi-layer walls /
        // slabs get per-layer sub-meshes keyed by IfcMaterial id.
        router.set_material_layer_index(std::sync::Arc::clone(&material_layer_index));

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

            // Merge-layers toggle (#540): skip children of sliceable aggregate
            // parents that have their own representation. The parent wall's
            // single solid already carries the per-layer colour slices.
            if parts_to_skip.contains(&id) {
                continue;
            }

            stats.total += 1;

            // Decode and process the entity
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // Check if entity actually has representation (attribute index 6 for IfcProduct).
                // IfcAlignment is the documented exception: its Axis curve is on
                // attr 7, and `Representation` (attr 6) is conventionally `$`.
                // The geometry router has a dedicated early branch for that
                // case (see `processing.rs::process_element` → `try_alignment_mesh`),
                // so let alignments through regardless of attr 6 (PR #849 fix —
                // pre-fix, the user reported the terrain rendered but the
                // alignment curves did not because this guard short-circuited).
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
                if !has_representation && !is_alignment {
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
                    |mesh: &mut ifc_lite_geometry::Mesh,
                     color: [f32; 4],
                     shading_color: Option<[f32; 4]>| {
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

                        let mut mesh_data =
                            MeshDataJs::new(id, ifc_type_name.clone(), mesh.clone(), color);
                        mesh_data.set_shading_color(shading_color);
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
                            let shading =
                                geometry_shading_styles.get(&sub.geometry_id).copied();
                            push_mesh_if_valid(&mut mesh, color, shading);
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
                                // No per-geometry shading info here (color
                                // came from build_element_style_index which
                                // doesn't track the source geometry id).
                                push_mesh_if_valid(&mut mesh, color, None);
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
                            let shading =
                                geometry_shading_styles.get(&sub.geometry_id).copied();
                            push_mesh_if_valid(&mut mesh, color, shading);
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
                                push_mesh_if_valid(&mut mesh, color, None);
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

        // Drain & surface the opening / CSG diagnostics — see
        // `super::drain_and_log_csg_diagnostics` for the full output format.
        let _ = super::drain_and_log_csg_diagnostics(&router);

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

        // Attach material-layer index so sub-mesh routing can slice single-solid
        // elements by their IfcMaterialLayerSetUsage buildup.
        router.set_material_layer_index(std::sync::Arc::clone(&pre_pass.material_layer_index));

        // Merge-layers toggle (#540): skip `IfcBuildingElementPart`s whose
        // sliceable parent will already carry the per-layer slices on its
        // single solid. Empty set when the toggle is off.
        let parts_to_skip: rustc_hash::FxHashSet<u32> = if self.merge_layers() {
            pre_pass
                .part_to_parent
                .iter()
                .filter(|(_, parent_id)| pre_pass.material_layer_index.is_sliceable(**parent_id))
                .map(|(part_id, _)| *part_id)
                .collect()
        } else {
            rustc_hash::FxHashSet::default()
        };

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
            // Merge-layers toggle (#540): suppress layer parts whose parent
            // wall already produces per-layer sub-meshes from its single solid.
            if parts_to_skip.contains(&id) {
                continue;
            }

            if let Ok(entity) = decoder.decode_at_with_id(id, job_start, job_end) {
                // IfcAlignment exception — see the equivalent guard in
                // `parse_meshes`; Axis curve lives on attr 7 and the router
                // routes through `try_alignment_mesh`.
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
                if !has_representation && !is_alignment {
                    continue;
                }

                let has_openings = pre_pass.void_index.contains_key(&id);
                let default_color = get_default_color_for_type(&ifc_type);
                let element_color = element_styles.get(&id).copied();
                let ifc_type_name = type_name_cache
                    .entry(ifc_type)
                    .or_insert_with(|| ifc_type.name().to_string())
                    .clone();

                let mut push_mesh = |mesh: &mut ifc_lite_geometry::Mesh,
                                     color: [f32; 4],
                                     shading_color: Option<[f32; 4]>| {
                    if mesh.is_empty() {
                        return;
                    }
                    if mesh.normals.len() != mesh.positions.len() {
                        calculate_normals(mesh);
                    }
                    let mut mesh_data =
                        MeshDataJs::new(id, ifc_type_name.clone(), mesh.clone(), color);
                    mesh_data.set_shading_color(shading_color);
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
                            let shading = pre_pass
                                .geometry_shading_styles
                                .get(&sub.geometry_id)
                                .copied();
                            push_mesh(&mut mesh, color, shading);
                        }
                    } else if let Ok(mut mesh) = router.process_element_with_voids(
                        &entity,
                        &mut decoder,
                        &pre_pass.void_index,
                    ) {
                        let color = element_color.unwrap_or(default_color);
                        push_mesh(&mut mesh, color, None);
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
                            let shading = pre_pass
                                .geometry_shading_styles
                                .get(&sub.geometry_id)
                                .copied();
                            push_mesh(&mut mesh, color, shading);
                        }
                    } else if let Ok(mut mesh) = router.process_element(&entity, &mut decoder) {
                        let color = element_color.unwrap_or(default_color);
                        push_mesh(&mut mesh, color, None);
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

        // For the merge-layers toggle (#540): build the material-layer index and
        // gather aggregate part→parent mappings so we can suppress
        // `IfcBuildingElementPart`s whose sliceable parent is rendered separately.
        // Only compute these when the toggle is on — they each cost a full pass.
        let parts_to_skip: rustc_hash::FxHashSet<u32> = if self.merge_layers() {
            let material_layer_index =
                ifc_lite_geometry::MaterialLayerIndex::from_content(&content, &mut decoder);
            let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> =
                rustc_hash::FxHashMap::default();
            let part_to_parent = ifc_lite_geometry::propagate_voids_to_parts(
                &mut void_index,
                &content,
                &mut decoder,
            );
            part_to_parent
                .iter()
                .filter(|(_, parent_id)| material_layer_index.is_sliceable(**parent_id))
                .map(|(part_id, _)| *part_id)
                .collect()
        } else {
            rustc_hash::FxHashSet::default()
        };

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

            // Merge-layers toggle (#540).
            if parts_to_skip.contains(&id) {
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

        // Snapshot the merge-layers toggle for the closure (#540).
        let merge_layers = self.merge_layers();

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

                // Merge-layers toggle (#540) — compute the part skip set on
                // demand. The two extra scans only run when the toggle is on.
                let parts_to_skip: rustc_hash::FxHashSet<u32> = if merge_layers {
                    let material_layer_index =
                        ifc_lite_geometry::MaterialLayerIndex::from_content(
                            &content,
                            &mut decoder,
                        );
                    let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> =
                        rustc_hash::FxHashMap::default();
                    let part_to_parent = ifc_lite_geometry::propagate_voids_to_parts(
                        &mut void_index,
                        &content,
                        &mut decoder,
                    );
                    part_to_parent
                        .iter()
                        .filter(|(_, parent_id)| {
                            material_layer_index.is_sliceable(**parent_id)
                        })
                        .map(|(part_id, _)| *part_id)
                        .collect()
                } else {
                    rustc_hash::FxHashSet::default()
                };

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

                    // Merge-layers toggle (#540): suppress layer parts here so
                    // they're never even classified into simple/deferred lists.
                    if parts_to_skip.contains(&id) {
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

        // Snapshot the merge-layers toggle BEFORE the closure so we don't
        // need to capture `self` (which isn't Send) into the async block.
        // (#540)
        let merge_layers = self.merge_layers();

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

                // Attach material-layer index so sub-mesh routing can slice
                // single-solid multi-layer walls / slabs into per-layer slabs.
                router.set_material_layer_index(std::sync::Arc::clone(
                    &pre_pass.material_layer_index,
                ));

                // Merge-layers toggle (#540): skip `IfcBuildingElementPart`s
                // whose sliceable parent will already emit per-layer slices.
                let parts_to_skip: rustc_hash::FxHashSet<u32> = if merge_layers {
                    pre_pass
                        .part_to_parent
                        .iter()
                        .filter(|(_, parent_id)| {
                            pre_pass.material_layer_index.is_sliceable(**parent_id)
                        })
                        .map(|(part_id, _)| *part_id)
                        .collect()
                } else {
                    rustc_hash::FxHashSet::default()
                };

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
                    // Merge-layers toggle (#540).
                    if parts_to_skip.contains(&id) {
                        continue;
                    }
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
                                    let shading = pre_pass
                                        .geometry_shading_styles
                                        .get(&sub.geometry_id)
                                        .copied();

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mut mesh_data = MeshDataJs::new(
                                        id,
                                        ifc_type_name.clone(),
                                        mesh,
                                        color,
                                    );
                                    mesh_data.set_shading_color(shading);
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
                    // Merge-layers toggle (#540).
                    if parts_to_skip.contains(&id) {
                        continue;
                    }
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
                                    let shading = pre_pass
                                        .geometry_shading_styles
                                        .get(&sub.geometry_id)
                                        .copied();

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mut mesh_data = MeshDataJs::new(
                                        id,
                                        ifc_type_name.clone(),
                                        mesh,
                                        color,
                                    );
                                    mesh_data.set_shading_color(shading);
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
                                    let shading = pre_pass
                                        .geometry_shading_styles
                                        .get(&sub.geometry_id)
                                        .copied();

                                    total_vertices += mesh.positions.len() / 3;
                                    total_triangles += mesh.indices.len() / 3;

                                    let mut mesh_data =
                                        MeshDataJs::new(id, ifc_type_name.clone(), mesh, color);
                                    mesh_data.set_shading_color(shading);
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

                // Drain & surface the opening / CSG diagnostics BEFORE
                // dropping the router. The helper logs to the browser
                // console at debug/warn levels and returns a JS object the
                // completion callback exposes via `stats.csgDiagnostics`.
                let csg_diagnostics = super::drain_and_log_csg_diagnostics(&router);

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
                    super::set_js_prop(&stats, "csgDiagnostics", &csg_diagnostics);
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
                // Check if entity has representation. IfcAlignment exception
                // — see the equivalent guard in `parse_meshes`.
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
                if !has_representation && !is_alignment {
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

        // Build entity index — wrap in Arc so processGeometryBatch can
        // share it across many calls without cloning the HashMap.
        let entity_index = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
        // Cache for reuse by processGeometryBatch.
        // Mutex held only briefly to install the Arc; rayon helpers
        // pick up clones below without re-locking. Panic on poison —
        // an earlier panic with the lock held would mean the cached
        // index is in an inconsistent state.
        let mut slot = self
            .cached_entity_index
            .lock()
            .expect("ifc-lite cached_entity_index Mutex poisoned");
        *slot = Some(entity_index.clone());
        drop(slot);
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index);

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
        use super::styling::extract_building_rotation_from_site;
        use ifc_lite_core::{is_simple_geometry_type, EntityDecoder, EntityScanner, IfcType};
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

        // Resolve unit scale + RTC offset (needs entity index for decoder).
        // Wrap in Arc so subsequent processGeometryBatch calls share by ref.
        let entity_index = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
        // Mutex held only briefly to install the Arc; rayon helpers
        // pick up clones below without re-locking. Panic on poison —
        // an earlier panic with the lock held would mean the cached
        // index is in an inconsistent state.
        let mut slot = self
            .cached_entity_index
            .lock()
            .expect("ifc-lite cached_entity_index Mutex poisoned");
        *slot = Some(entity_index.clone());
        drop(slot);
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index);

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

    /// Streaming pre-pass: emits geometry jobs in chunks via a JS callback
    /// instead of waiting for the full file scan to complete.
    ///
    /// Single linear walk over the file:
    ///   1. Builds the entity index incrementally from the same scan that
    ///      collects geometry jobs (the old `build_pre_pass_fast` did two
    ///      full-file scans — one for entities, one for the index — which
    ///      doubled wall-clock).
    ///   2. As soon as `IFCPROJECT` has been seen, the unit scale and the
    ///      first ~50 geometry jobs have been collected, resolves
    ///      `unitScale` + `rtcOffset` and emits a `meta` callback so the
    ///      JS host can spin up geometry process workers.
    ///   3. Emits `jobs` callbacks every `chunk_size` jobs (or fewer if
    ///      the meta phase already buffered some).
    ///   4. Emits `complete` with the total job count at end of scan.
    ///
    /// On a 986 MB / 14 M-entity file this drops time-to-first-geometry
    /// from ~17 s (full pre-pass + worker spawn + first batch) to ~3 s
    /// (first 100 K bytes scanned + meta + first chunk).
    ///
    /// The callback receives a single `JsValue` argument shaped as one of:
    ///   `{ type: "meta", unitScale, rtcOffset: [x,y,z], needsShift, buildingRotation? }`
    ///   `{ type: "jobs", jobs: Uint32Array }`     // [id, start, end] triples
    ///   `{ type: "complete", totalJobs }`
    #[wasm_bindgen(js_name = buildPrePassStreaming)]
    pub fn build_pre_pass_streaming(
        &self,
        data: &[u8],
        on_event: &Function,
        chunk_size: u32,
    ) -> Result<JsValue, JsValue> {
        use super::styling::extract_building_rotation_from_site;
        use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner, IfcType};
        use ifc_lite_geometry::GeometryRouter;

        let chunk_size = chunk_size.max(1024) as usize;
        let content = decode_ifc_bytes(data);

        // Single-pass scan: gather (id, start, end, type) for everything,
        // tag geometry-bearing rows so we can emit jobs incrementally.
        // Entity index is built from the same pass — no second walk.
        let mut scanner = EntityScanner::new(content);
        let estimated = content.len() / 50;
        let mut entity_index: rustc_hash::FxHashMap<u32, (usize, usize)> =
            rustc_hash::FxHashMap::with_capacity_and_hasher(estimated, Default::default());

        let mut buffered_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(chunk_size);
        let mut total_jobs: u32 = 0;
        let mut project_id: Option<u32> = None;
        let mut site_position: Option<(u32, usize, usize)> = None;
        let mut meta_emitted = false;

        // Style/void/material data collected during the scan — same shape as
        // `combined_pre_pass` collects for `buildPrePassOnce`. Emitted as a
        // `styles` event after the scan completes so workers can switch from
        // default colors to resolved colors mid-stream and the host can fire a
        // `colorUpdate` to retroactively fix already-emitted meshes.
        let mut geometry_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
        let mut faceted_brep_ids: Vec<u32> = Vec::new();
        let mut orphan_styled_items: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        let mut material_def_reprs: rustc_hash::FxHashMap<u32, Vec<u32>> =
            rustc_hash::FxHashMap::default();
        let mut element_to_material: rustc_hash::FxHashMap<u32, u32> =
            rustc_hash::FxHashMap::default();
        // Hold a chunk buffer that we drain to JS — these are the last
        // `chunk_size` jobs awaiting flush. After `meta` the buffer is
        // drained as the first jobs event; subsequent flushes happen at
        // every `chunk_size` boundary.
        const RTC_SAMPLE_THRESHOLD: usize = 50;

        // Emit a chunk of jobs to JS as a Uint32Array of [id, start, end] triples.
        // Internal helper, returns total emitted so far.
        fn emit_jobs_chunk(
            on_event: &Function,
            jobs: &[(u32, usize, usize, IfcType)],
        ) -> Result<(), JsValue> {
            if jobs.is_empty() {
                return Ok(());
            }
            let arr = js_sys::Uint32Array::new_with_length((jobs.len() * 3) as u32);
            let mut idx = 0u32;
            for &(id, start, end, _) in jobs {
                arr.set_index(idx, id);
                arr.set_index(idx + 1, start as u32);
                arr.set_index(idx + 2, end as u32);
                idx += 3;
            }
            let event = js_sys::Object::new();
            super::set_js_prop(&event, "type", &"jobs".into());
            super::set_js_prop(&event, "jobs", &arr);
            on_event.call1(&JsValue::NULL, &event.into())?;
            Ok(())
        }

        // Spans of entities that need decoding for style collection — we
        // can't decode mid-scan because the decoder borrows `content` and
        // would need `entity_index` populated for any references it follows.
        // Stash the spans here and process them after the scan in one pass.
        let mut styled_item_spans: Vec<(u32, usize, usize)> = Vec::new();
        // IfcIndexedColourMap entries — the second IFC4 colouring mechanism
        // used by CATIA / 3DEXPERIENCE exports (#663). Resolved in the same
        // post-scan pass as IfcStyledItem.
        let mut indexed_colour_map_spans: Vec<(u32, usize, usize)> = Vec::new();
        let mut material_entity_spans: Vec<(u32, &'static str, usize, usize)> = Vec::new();
        let mut void_rel_spans: Vec<(u32, usize, usize)> = Vec::new();

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Build entity index inline (same data we'd otherwise re-scan for).
            entity_index.insert(id, (start, end));

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
                    buffered_jobs.push((id, start, end, ifc_type));
                    total_jobs += 1;
                }
                "IFCSTYLEDITEM" => {
                    styled_item_spans.push((id, start, end));
                }
                "IFCINDEXEDCOLOURMAP" => {
                    indexed_colour_map_spans.push((id, start, end));
                }
                "IFCMATERIALDEFINITIONREPRESENTATION" => {
                    material_entity_spans.push((id, "IFCMATERIALDEFINITIONREPRESENTATION", start, end));
                }
                "IFCRELASSOCIATESMATERIAL" => {
                    material_entity_spans.push((id, "IFCRELASSOCIATESMATERIAL", start, end));
                }
                "IFCRELVOIDSELEMENT" => {
                    void_rel_spans.push((id, start, end));
                }
                "IFCFACETEDBREP" => {
                    faceted_brep_ids.push(id);
                }
                _ => {
                    if has_geometry_by_name(type_name) {
                        let ifc_type = IfcType::from_str(type_name);
                        // We don't bucket by simple/complex here — the host
                        // distributes work across N geometry workers anyway,
                        // and the simple/complex split was a heuristic for
                        // RTC sampling that we now resolve once after
                        // RTC_SAMPLE_THRESHOLD jobs have been collected.
                        buffered_jobs.push((id, start, end, ifc_type));
                        total_jobs += 1;
                    }
                }
            }

            // Once we have project + enough sample jobs, resolve the meta
            // (unit scale + RTC offset + building rotation) and emit it
            // along with the buffered first chunk so workers can start.
            if !meta_emitted
                && project_id.is_some()
                && buffered_jobs.len() >= RTC_SAMPLE_THRESHOLD
            {
                // Build a decoder over the partial entity index. The unit
                // assignment + IFCSIUNIT entities live near the top of every
                // STEP file — with RTC_SAMPLE_THRESHOLD geometry jobs already
                // scanned we are well past them.
                let mut decoder = EntityDecoder::with_index(content, entity_index.clone());

                let unit_scale = ifc_lite_core::extract_length_unit_scale(
                    &mut decoder,
                    project_id.expect("project_id checked"),
                )
                .unwrap_or(1.0);

                let router = GeometryRouter::with_scale(unit_scale);
                let rtc_offset = router
                    .detect_rtc_offset_from_jobs(&buffered_jobs, &mut decoder)
                    .unwrap_or((0.0, 0.0, 0.0));
                let needs_shift = rtc_offset.0.abs() > 10000.0
                    || rtc_offset.1.abs() > 10000.0
                    || rtc_offset.2.abs() > 10000.0;

                let building_rotation = site_position
                    .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

                // Emit meta event.
                let meta = js_sys::Object::new();
                super::set_js_prop(&meta, "type", &"meta".into());
                super::set_js_prop(&meta, "unitScale", &unit_scale.into());
                let rtc_arr = js_sys::Float64Array::new_with_length(3);
                rtc_arr.set_index(0, rtc_offset.0);
                rtc_arr.set_index(1, rtc_offset.1);
                rtc_arr.set_index(2, rtc_offset.2);
                super::set_js_prop(&meta, "rtcOffset", &rtc_arr);
                super::set_js_prop(&meta, "needsShift", &needs_shift.into());
                match building_rotation {
                    Some(rot) => super::set_js_prop(&meta, "buildingRotation", &rot.into()),
                    None => super::set_js_prop(&meta, "buildingRotation", &JsValue::NULL),
                };
                on_event.call1(&JsValue::NULL, &meta.into())?;

                // Drain the buffered jobs as the first jobs event so workers
                // start immediately on whatever we already collected.
                emit_jobs_chunk(on_event, &buffered_jobs)?;
                buffered_jobs.clear();
                meta_emitted = true;
                continue;
            }

            // Steady state: flush every chunk_size jobs.
            if meta_emitted && buffered_jobs.len() >= chunk_size {
                emit_jobs_chunk(on_event, &buffered_jobs)?;
                buffered_jobs.clear();
            }
        }

        // Tail: if we never hit the meta threshold (very small file with
        // <50 geometry jobs), emit meta now with whatever data we have so
        // workers can still process the trailing buffer.
        if !meta_emitted {
            // Build a decoder lazily for unit/RTC/site lookups. With a
            // sub-50-job file the scan is essentially instant anyway, so
            // buying a second pass here is irrelevant.
            let mut decoder = EntityDecoder::with_index(content, entity_index.clone());
            let unit_scale = project_id
                .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
                .unwrap_or(1.0);
            let router = GeometryRouter::with_scale(unit_scale);
            let rtc_offset = router
                .detect_rtc_offset_from_jobs(&buffered_jobs, &mut decoder)
                .unwrap_or((0.0, 0.0, 0.0));
            let needs_shift = rtc_offset.0.abs() > 10000.0
                || rtc_offset.1.abs() > 10000.0
                || rtc_offset.2.abs() > 10000.0;
            let building_rotation = site_position
                .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

            let meta = js_sys::Object::new();
            super::set_js_prop(&meta, "type", &"meta".into());
            super::set_js_prop(&meta, "unitScale", &unit_scale.into());
            let rtc_arr = js_sys::Float64Array::new_with_length(3);
            rtc_arr.set_index(0, rtc_offset.0);
            rtc_arr.set_index(1, rtc_offset.1);
            rtc_arr.set_index(2, rtc_offset.2);
            super::set_js_prop(&meta, "rtcOffset", &rtc_arr);
            super::set_js_prop(&meta, "needsShift", &needs_shift.into());
            match building_rotation {
                Some(rot) => super::set_js_prop(&meta, "buildingRotation", &rot.into()),
                None => super::set_js_prop(&meta, "buildingRotation", &JsValue::NULL),
            };
            on_event.call1(&JsValue::NULL, &meta.into())?;
        }

        // Final tail chunk.
        emit_jobs_chunk(on_event, &buffered_jobs)?;
        buffered_jobs.clear();

        // Cache the entity index for processGeometryBatch reuse — same
        // contract as buildPrePassFast / buildPrePassOnce. Wrapped in Arc
        // so process workers reuse the same index by reference instead of
        // cloning the 14 M-entry HashMap on every batch call.
        let entity_index_arc = std::sync::Arc::new(entity_index);
        // Mutex held only briefly to install the Arc.
        {
            let mut slot = self
                .cached_entity_index
                .lock()
                .expect("ifc-lite cached_entity_index Mutex poisoned");
            *slot = Some(entity_index_arc.clone());
        }
        // Hold a second clone for the post-scan entity-index export below;
        // `with_arc_index` consumes the Arc so we'd lose the reference
        // after the decoder is created.
        let index_for_export = entity_index_arc.clone();

        // ── Style + void resolution (post-scan) ──
        // The streaming scan stashed entity spans for IfcStyledItem,
        // material entities, and void rels. Now that the entity index is
        // complete we decode them in one pass — the same logic
        // `combined_pre_pass` runs inline, but split into a post-phase so
        // we don't block streaming jobs on style decoding.
        //
        // We deliberately SKIP `MaterialLayerIndex::from_content` and
        // `propagate_voids_to_parts` here — both do their own full file
        // scans and would add ~7 s to the streaming pre-pass for visual
        // refinements (multilayer wall cuts, layered material rendering).
        // Primary surface colors come through correctly without them, and
        // the missing detail can be added later without changing the
        // protocol shape.
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index_arc);

        for &(id, start, end) in &styled_item_spans {
            if let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) {
                if let Some(geometry_id) = styled_item.get_ref(0) {
                    if !geometry_styles.contains_key(&geometry_id) {
                        if let Some(styles_attr) = styled_item.get(1) {
                            if let Some(color) =
                                super::styling::extract_color_from_styles(styles_attr, &mut decoder)
                            {
                                geometry_styles.insert(geometry_id, color);
                            }
                        }
                    }
                } else {
                    // Orphan IfcStyledItem (null Item) — material-based color.
                    if let Some(styles_attr) = styled_item.get(1) {
                        if let Some(color) =
                            super::styling::extract_color_from_styles(styles_attr, &mut decoder)
                        {
                            orphan_styled_items.insert(id, color);
                        }
                    }
                }
            }
        }

        // Resolve IfcIndexedColourMap entries — IFC4's per-tessellated-face-set
        // colouring mechanism used by CATIA / 3DEXPERIENCE exports (#663).
        // IfcStyledItem entries above win when both target the same geometry,
        // so `entry().or_insert` preserves the authored-intent path.
        for &(id, start, end) in &indexed_colour_map_spans {
            if let Some((geometry_id, color)) =
                super::styling::extract_color_from_indexed_colour_map_span(id, start, end, &mut decoder)
            {
                geometry_styles.entry(geometry_id).or_insert(color);
            }
        }

        for &(id, type_name, start, end) in &material_entity_spans {
            super::styling::collect_material_entity(
                id,
                type_name,
                start,
                end,
                &mut decoder,
                &mut orphan_styled_items,
                &mut material_def_reprs,
                &mut element_to_material,
            );
        }

        for &(id, start, end) in &void_rel_spans {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) =
                    (entity.get_ref(4), entity.get_ref(5))
                {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }

        // Resolve material chains → element colors.
        let material_styles = super::styling::build_material_style_index(
            &material_def_reprs,
            &orphan_styled_items,
            &mut decoder,
        );
        let element_material_styles = super::styling::build_element_material_styles(
            &element_to_material,
            &material_styles,
            &mut decoder,
        );
        // Flat material_id → color, merge into geometry_styles for layered
        // resolution per `combined_pre_pass`.
        for (&mat_id, &color) in
            super::styling::flatten_material_color_index(&material_styles).iter()
        {
            geometry_styles.entry(mat_id).or_insert(color);
        }
        // For elements that have a single resolved material color, register
        // it so processGeometryBatch's per-type fallback picks it up.
        for (&element_id, colors) in &element_material_styles {
            if let Some(&color) = colors.first() {
                geometry_styles.entry(element_id).or_insert(color);
            }
        }

        // Serialise styles + voids + faceted_brep_ids and post a `styles`
        // event before `complete` so the host can dispatch them to all
        // process workers and emit a colorUpdate for already-rendered meshes.
        let styles_len = geometry_styles.len();
        let style_ids = js_sys::Uint32Array::new_with_length(styles_len as u32);
        let style_colors = js_sys::Uint8Array::new_with_length((styles_len * 4) as u32);
        let mut si = 0u32;
        for (&id, &color) in &geometry_styles {
            style_ids.set_index(si, id);
            let ci = si * 4;
            style_colors.set_index(ci, (color[0] * 255.0).clamp(0.0, 255.0) as u8);
            style_colors.set_index(ci + 1, (color[1] * 255.0).clamp(0.0, 255.0) as u8);
            style_colors.set_index(ci + 2, (color[2] * 255.0).clamp(0.0, 255.0) as u8);
            style_colors.set_index(ci + 3, (color[3] * 255.0).clamp(0.0, 255.0) as u8);
            si += 1;
        }

        // void_index → flat (keys, counts, values) arrays in the same shape
        // processGeometryBatch already accepts.
        let mut void_keys_vec: Vec<u32> = Vec::with_capacity(void_index.len());
        let mut void_counts_vec: Vec<u32> = Vec::with_capacity(void_index.len());
        let mut void_values_vec: Vec<u32> = Vec::new();
        for (&host_id, openings) in &void_index {
            void_keys_vec.push(host_id);
            void_counts_vec.push(openings.len() as u32);
            void_values_vec.extend(openings.iter().copied());
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
        let faceted_brep_arr = js_sys::Uint32Array::new_with_length(faceted_brep_ids.len() as u32);
        for (i, &id) in faceted_brep_ids.iter().enumerate() {
            faceted_brep_arr.set_index(i as u32, id);
        }

        let styles_event = js_sys::Object::new();
        super::set_js_prop(&styles_event, "type", &"styles".into());
        super::set_js_prop(&styles_event, "styleIds", &style_ids);
        super::set_js_prop(&styles_event, "styleColors", &style_colors);
        super::set_js_prop(&styles_event, "voidKeys", &void_keys);
        super::set_js_prop(&styles_event, "voidCounts", &void_counts);
        super::set_js_prop(&styles_event, "voidValues", &void_values);
        super::set_js_prop(&styles_event, "facetedBrepIds", &faceted_brep_arr);
        on_event.call1(&JsValue::NULL, &styles_event.into())?;

        // Export the entity_index as 3 column arrays so process workers
        // can install it via `setEntityIndex` (skipping the ~5 s file
        // re-scan they'd otherwise pay on the first processGeometryBatch
        // call). The arrays are filled directly from the Arc'd HashMap;
        // the Arc shares with `cached_entity_index` so we don't clone the
        // map data — only walk it once to fill the output arrays.
        //
        // Output shape mirrors `setEntityIndex`'s input contract:
        //   ids[i]     → entity ID (u32)
        //   starts[i]  → byte offset of entity start
        //   lengths[i] → byte length of entity (NOT end offset)
        let n = index_for_export.len();
        let ids_arr = js_sys::Uint32Array::new_with_length(n as u32);
        let starts_arr = js_sys::Uint32Array::new_with_length(n as u32);
        let lengths_arr = js_sys::Uint32Array::new_with_length(n as u32);
        let mut i = 0u32;
        for (&id, &(start, end)) in index_for_export.iter() {
            ids_arr.set_index(i, id);
            starts_arr.set_index(i, start as u32);
            lengths_arr.set_index(i, (end - start) as u32);
            i += 1;
        }
        let index_event = js_sys::Object::new();
        super::set_js_prop(&index_event, "type", &"entity-index".into());
        super::set_js_prop(&index_event, "ids", &ids_arr);
        super::set_js_prop(&index_event, "starts", &starts_arr);
        super::set_js_prop(&index_event, "lengths", &lengths_arr);
        on_event.call1(&JsValue::NULL, &index_event.into())?;

        // Complete event.
        let done = js_sys::Object::new();
        super::set_js_prop(&done, "type", &"complete".into());
        super::set_js_prop(&done, "totalJobs", &(total_jobs as f64).into());
        on_event.call1(&JsValue::NULL, &done.into())?;

        Ok(JsValue::UNDEFINED)
    }

    /// Phase 1 of Path C — sharded entity-index scan.
    ///
    /// Walks the bytes in `[range_start, range_end)` once and emits
    /// `(express_id, byte_offset, byte_length)` triples for every entity
    /// whose `#N=` opener falls in that range. Byte offsets are GLOBAL
    /// (relative to file start), so multiple shards' outputs concatenate
    /// without rewriting.
    ///
    /// Cross-boundary handling: the scanner rewinds `range_start` to the
    /// byte after the previous `\n` so we don't mis-parse a half entity.
    /// The previous shard owns any entity whose opener is BEFORE its own
    /// range_end (its terminator may extend past it; that's fine — the
    /// scanner walks STEP entities to their terminating `;`, even if that
    /// terminator is past the shard's nominal range_end).
    ///
    /// Returns nothing through the JS callback for performance signals;
    /// emits exactly one `index-shard` event with three Uint32Arrays:
    ///   `{ type: "index-shard", ids: Uint32Array, starts: Uint32Array,
    ///      lengths: Uint32Array, shardStart: u32, shardEnd: u32 }`
    ///
    /// Used by the JS-side shard coordinator to merge N shards' indices
    /// into a single entity-index without paying the 3 s single-threaded
    /// scan cost. Style and job emission are NOT done here — they remain
    /// the job of the existing `build_pre_pass_streaming` (which can be
    /// called on shard 0 in parallel with the other shards' index-only
    /// scans).
    #[wasm_bindgen(js_name = scanEntityIndexShard)]
    pub fn scan_entity_index_shard(
        &self,
        data: &[u8],
        on_event: &Function,
        range_start: u32,
        range_end: u32,
    ) -> Result<JsValue, JsValue> {
        use ifc_lite_core::EntityScanner;

        let content = decode_ifc_bytes(data);
        let bytes = content.as_bytes();
        let total_len = bytes.len();

        let nominal_start = (range_start as usize).min(total_len);
        let nominal_end = (range_end as usize).min(total_len);

        // Rewind to the byte after the previous `\n`. Entities can span
        // multiple lines but every entity is preceded by some line break
        // in valid STEP files, so the byte right after a `\n` is always
        // a safe scanner restart point. If the rewind hits position 0
        // we just start from there.
        let mut actual_start = nominal_start;
        while actual_start > 0 && bytes[actual_start - 1] != b'\n' {
            actual_start -= 1;
        }

        // Estimate capacity from byte range / 70 (avg entity size).
        let estimated = (nominal_end.saturating_sub(actual_start)) / 70;
        let mut ids: Vec<u32> = Vec::with_capacity(estimated);
        let mut starts: Vec<u32> = Vec::with_capacity(estimated);
        let mut lengths: Vec<u32> = Vec::with_capacity(estimated);

        let mut scanner = EntityScanner::new_at(content, actual_start);
        while let Some((id, _type_name, byte_start, byte_end)) = scanner.next_entity() {
            // Skip entities whose opener is BEFORE our range — they belong
            // to the previous shard, which rewound past the boundary too.
            // (Only happens at non-zero range starts.)
            if byte_start < nominal_start {
                continue;
            }
            // Stop once an entity's opener is past our range_end. The
            // entity itself might extend past range_end (its terminator
            // could be in the next shard's range), but we still own it
            // here because its OPENER is in our range. Correction: we
            // own only entities whose opener is in [nominal_start,
            // nominal_end). The next shard's scanner will skip this same
            // entity because its opener is before that shard's start.
            if byte_start >= nominal_end {
                break;
            }
            ids.push(id);
            starts.push(byte_start as u32);
            lengths.push((byte_end - byte_start) as u32);
        }

        // Emit one event with the columns. Receiver allocates SAB-backed
        // typed arrays from these on the JS side and merges with peers.
        let n = ids.len() as u32;
        let ids_arr = js_sys::Uint32Array::new_with_length(n);
        let starts_arr = js_sys::Uint32Array::new_with_length(n);
        let lengths_arr = js_sys::Uint32Array::new_with_length(n);
        for (i, ((&id, &start), &length)) in ids.iter().zip(starts.iter()).zip(lengths.iter()).enumerate() {
            let i = i as u32;
            ids_arr.set_index(i, id);
            starts_arr.set_index(i, start);
            lengths_arr.set_index(i, length);
        }

        let event = js_sys::Object::new();
        super::set_js_prop(&event, "type", &"index-shard".into());
        super::set_js_prop(&event, "ids", &ids_arr);
        super::set_js_prop(&event, "starts", &starts_arr);
        super::set_js_prop(&event, "lengths", &lengths_arr);
        super::set_js_prop(&event, "shardStart", &(nominal_start as f64).into());
        super::set_js_prop(&event, "shardEnd", &(nominal_end as f64).into());
        on_event.call1(&JsValue::NULL, &event.into())?;

        Ok(JsValue::UNDEFINED)
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

        // Reuse the cached Arc<EntityIndex> across calls so we don't
        // re-clone the 14 M-entry HashMap on every batch. On streaming
        // paths this turns ~36 calls/worker into 1 build + 35 Arc::clone()
        // (a single refcount bump) instead of 36 full HashMap clones.
        //
        // If the cache is empty (which happens on every process worker
        // because they're separate WASM realms from the pre-pass worker),
        // build once here and store under Arc so subsequent calls hit
        // the fast path.
        let entity_index_arc: std::sync::Arc<ifc_lite_core::EntityIndex> = {
            // Mutex briefly held: peek at cache, build-if-empty, clone Arc.
            // The clone is what gets handed to rayon — no lock contention
            // on the per-job hot path that follows. Poison panics here
            // (an earlier panic-with-lock-held has corrupted the cache).
            let mut slot = self
                .cached_entity_index
                .lock()
                .expect("ifc-lite cached_entity_index Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                std::sync::Arc::clone(existing)
            } else {
                let built = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
                *slot = Some(std::sync::Arc::clone(&built));
                built
            }
        };
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index_arc);

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

        // When merge-layers is on, fetch (or lazily build) the set of
        // IfcBuildingElementPart express IDs to skip. Built once per worker
        // and reused across every subsequent batch on the same content via
        // the cached_parts_to_skip slot on IfcAPI.
        let parts_to_skip: std::sync::Arc<rustc_hash::FxHashSet<u32>> = if self.merge_layers() {
            self.get_or_build_parts_to_skip(content, &mut decoder)
        } else {
            std::sync::Arc::new(rustc_hash::FxHashSet::default())
        };

        // Process only the entities specified in jobs_flat
        for chunk in jobs_flat.chunks(3) {
            if chunk.len() < 3 {
                break;
            }
            let id = chunk[0];
            let start = chunk[1] as usize;
            let end = chunk[2] as usize;

            if parts_to_skip.contains(&id) {
                continue;
            }

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcAlignment exception — see `parse_meshes`.
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
                if !has_representation && !is_alignment {
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

        // Drain & surface the opening / CSG diagnostics. The viewer's
        // streaming path (>2 MB files) goes processAdaptive ->
        // processParallel -> Web Workers -> `processGeometryBatch`,
        // bypassing `parseMeshesAsync` entirely. Without this drain
        // here the diagnostic helper never fires for any real-world
        // file the viewer loads.
        let _ = super::drain_and_log_csg_diagnostics(&router);

        mesh_collection
    }

    /// Microbenchmark — pure CPU work (no SAB, no allocations) to
    /// measure rayon parallelism IN ISOLATION from the rest of the
    /// pipeline. If this scales near-linearly with thread count, the
    /// runtime's fundamentally healthy and any per-entity slowdown is
    /// an algorithmic / memory-access problem we can fix. If THIS
    /// doesn't scale, no amount of code rearrangement will help and
    /// Path B is dead for our use case.
    ///
    /// Workload: integer math on local stack memory, deliberately
    /// chosen to have ZERO shared-memory access AND zero allocations
    /// inside the parallel section. Each task spends ~50 ms of pure
    /// CPU compute.
    ///
    /// Returns: `[serial_ms, parallel_ms, observed_threads]` so JS can
    /// compute the speedup ratio.
    #[cfg(feature = "threading")]
    #[wasm_bindgen(js_name = benchmarkPureCpuParallelism)]
    pub fn benchmark_pure_cpu_parallelism(&self, num_tasks: u32) -> Vec<f64> {
        use rayon::prelude::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        // Pure-compute workload: nested integer math chosen to take
        // ~50ms per task on a single thread. Returns a checksum so the
        // optimizer can't dead-code-eliminate it.
        fn pure_compute_task(seed: u64) -> u64 {
            let mut x: u64 = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
            // ~50ms of work — tuned by trial; pure local arithmetic,
            // no allocations, no memory access beyond the register.
            for _ in 0..5_000_000u32 {
                x = x.wrapping_mul(0xD2B7_4407_B1CE_6E93).wrapping_add(0x1234_5678_9ABC_DEF0);
                x ^= x >> 17;
                x = x.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
                x ^= x >> 31;
            }
            x
        }

        let num_tasks = num_tasks.max(1) as usize;

        // SERIAL baseline: all tasks on one thread.
        let t_serial_start = web_sys::js_sys::Date::now();
        let mut serial_sum: u64 = 0;
        for i in 0..num_tasks {
            serial_sum = serial_sum.wrapping_add(pure_compute_task(i as u64));
        }
        let serial_ms = web_sys::js_sys::Date::now() - t_serial_start;
        std::hint::black_box(serial_sum);

        // PARALLEL: rayon par_iter on the same workload.
        let unique_threads = std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashSet::<usize>::new(),
        ));
        let unique_for_closure = std::sync::Arc::clone(&unique_threads);
        let task_count = std::sync::Arc::new(AtomicUsize::new(0));
        let task_count_for_closure = std::sync::Arc::clone(&task_count);

        let t_parallel_start = web_sys::js_sys::Date::now();
        let parallel_sum: u64 = (0..num_tasks)
            .into_par_iter()
            .map(|i| {
                task_count_for_closure.fetch_add(1, Ordering::Relaxed);
                if let Some(idx) = rayon::current_thread_index() {
                    if let Ok(mut s) = unique_for_closure.lock() {
                        s.insert(idx);
                    }
                }
                pure_compute_task(i as u64)
            })
            .sum();
        let parallel_ms = web_sys::js_sys::Date::now() - t_parallel_start;
        std::hint::black_box(parallel_sum);

        let observed_threads = unique_threads.lock().map(|s| s.len()).unwrap_or(0) as f64;
        let observed_tasks = task_count.load(Ordering::Relaxed) as f64;

        web_sys::console::log_1(
            &format!(
                "[bench] tasks={} threads_observed={} pool={} serial={:.0}ms parallel={:.0}ms speedup={:.2}x",
                observed_tasks,
                observed_threads,
                rayon::current_num_threads(),
                serial_ms,
                parallel_ms,
                serial_ms / parallel_ms,
            )
            .into(),
        );

        vec![serial_ms, parallel_ms, observed_threads]
    }

    /// Phase 1.5 — parallel variant of `processGeometryBatch`.
    ///
    /// Same input/output contract as `processGeometryBatch`, but the
    /// per-entity mesh-generation loop runs through rayon `par_chunks`
    /// instead of a serial `for chunk in jobs_flat.chunks(3)`. Available
    /// only in the `threading`-feature build (the threaded WASM bundle).
    ///
    /// Phase 2's controller worker calls this. The serial
    /// `processGeometryBatch` stays for the single-thread bundle and as
    /// a behavioral oracle for cross-bundle parity tests.
    ///
    /// Per-task design:
    ///   - `par_chunks(PER_TASK_ENTITIES * 3)` so each rayon task gets
    ///     enough work (~500 entities, ~60 ms) to amortize per-task
    ///     scheduling overhead. Per the research, tasks <10 µs are net
    ///     negative on rayon's scheduler.
    ///   - Each rayon task creates its OWN `EntityDecoder` and
    ///     `GeometryRouter`. The `Arc<EntityIndex>` is the only shared
    ///     state; everything else is per-task local. This is the
    ///     "thread_local!"-style pattern realised via per-task locals
    ///     instead of true thread-locals (simpler and equivalent for
    ///     our cache lifetime needs).
    ///   - Output `Vec<MeshDataJs>` collected lock-free via
    ///     `flat_map_iter` + `collect`, then funneled into a single
    ///     `MeshCollection` at the end. Per `MeshCollection::add`
    ///     internals, the final pour is just appending pre-built
    ///     `MeshDataJs` records — no per-mesh allocation.
    ///
    /// Pre-pass setup (entity-index lock, void/style index build,
    /// per-element color resolution) stays serial — it's already O(jobs)
    /// but with much smaller per-iteration work than the geometry path.
    /// Parallelising it would add coordination overhead for negligible
    /// gain on the typical 16K-job-per-batch workload.
    #[cfg(feature = "threading")]
    #[wasm_bindgen(js_name = processGeometryBatchParallel)]
    pub fn process_geometry_batch_parallel(
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
        style_ids: &[u32],
        style_colors: &[u8],
    ) -> MeshCollection {
        use super::styling::{
            get_default_color_for_type, resolve_element_color, resolve_submesh_color,
        };
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};
        use rayon::prelude::*;
        use std::sync::Arc;

        let content = decode_ifc_bytes(data);

        // Same Mutex-cached entity index pattern as the serial variant.
        let entity_index_arc: Arc<ifc_lite_core::EntityIndex> = {
            let mut slot = self
                .cached_entity_index
                .lock()
                .expect("ifc-lite cached_entity_index Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                Arc::clone(existing)
            } else {
                let built = Arc::new(ifc_lite_core::build_entity_index(content));
                *slot = Some(Arc::clone(&built));
                built
            }
        };

        // Reconstruct void_index from flat arrays (serial — small).
        let mut void_index_local: rustc_hash::FxHashMap<u32, Vec<u32>> =
            rustc_hash::FxHashMap::default();
        let mut value_offset = 0usize;
        for i in 0..void_keys.len() {
            let host_id = void_keys[i];
            let count = void_counts[i] as usize;
            let openings = void_values[value_offset..value_offset + count].to_vec();
            void_index_local.insert(host_id, openings);
            value_offset += count;
        }
        let void_index = Arc::new(void_index_local);

        // Reconstruct geometry_styles from flat arrays (serial — small).
        let mut geometry_styles_local: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        for i in 0..style_ids.len() {
            let base = i * 4;
            if base + 3 < style_colors.len() {
                geometry_styles_local.insert(
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
        let geometry_styles = Arc::new(geometry_styles_local);

        // Build element_styles serially using a single decoder (small
        // pass; only fires when there are styled items at all).
        let mut element_styles_local: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        if !geometry_styles.is_empty() {
            let mut prep_decoder = EntityDecoder::with_arc_index(content, Arc::clone(&entity_index_arc));
            for chunk in jobs_flat.chunks(3) {
                if chunk.len() < 3 {
                    break;
                }
                let id = chunk[0];
                let start = chunk[1] as usize;
                let end = chunk[2] as usize;
                if let Ok(entity) = prep_decoder.decode_at_with_id(id, start, end) {
                    if entity.get(6).map(|a| !a.is_null()).unwrap_or(false) {
                        if let Some(color) = resolve_element_color(
                            &entity,
                            &geometry_styles,
                            &mut prep_decoder,
                        ) {
                            element_styles_local.insert(id, color);
                        }
                    }
                }
            }
        }
        let element_styles = Arc::new(element_styles_local);

        // Per-task entity count tuned for DECODER CACHE LOCALITY first,
        // rayon scheduling second. Each rayon task creates its own
        // EntityDecoder with a fresh cache; sub-entities (CartesianPoint,
        // IfcAxis2Placement2D, etc.) shared across walls/slabs hit the
        // serial path's warm cache for ~50% of accesses but MISS in
        // every task here. Bigger tasks = fewer tasks = more cache
        // warming amortization.
        //
        // 5000 entities/task × 120 µs/entity ≈ 600 ms work. With
        // 9 rayon threads on the typical chunk (~47K jobs → 9-10
        // tasks), each thread gets ~1 task. If rayon is actually
        // parallelizing, wall-clock ≈ 600 ms per chunk × 4 chunks
        // = ~2.4 s. If rayon falls back to serial: 5.4 s per chunk
        // × 4 = 22 s — still better than the 500-task variant which
        // measured 60s due to cache thrashing.
        const PER_TASK_ENTITIES: usize = 5000;
        let stride = PER_TASK_ENTITIES * 3;

        // Diagnostic: confirm rayon is actually parallelizing. Each
        // task records the rayon thread index it ran on. If we see
        // only one unique index (or all None), helpers aren't doing
        // work and par_iter is serial-fallback. Logged to JS console
        // via web_sys at the end of the call.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let task_count = std::sync::Arc::new(AtomicUsize::new(0));
        let unique_threads = std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashSet::<usize>::new(),
        ));
        let task_count_for_closure = std::sync::Arc::clone(&task_count);
        let unique_threads_for_closure = std::sync::Arc::clone(&unique_threads);

        // Build the merge-layers skip set once, before rayon fans out.
        // The set is wrapped in Arc and cloned into every task — each
        // task only reads, never mutates. Empty when the toggle is off.
        let parts_to_skip: Arc<rustc_hash::FxHashSet<u32>> = if self.merge_layers() {
            let mut prep_decoder =
                EntityDecoder::with_arc_index(content, Arc::clone(&entity_index_arc));
            self.get_or_build_parts_to_skip(content, &mut prep_decoder)
        } else {
            Arc::new(rustc_hash::FxHashSet::default())
        };

        let collected: Vec<MeshDataJs> = jobs_flat
            .par_chunks(stride)
            .flat_map_iter(|big_chunk| {
                task_count_for_closure.fetch_add(1, Ordering::Relaxed);
                if let Some(idx) = rayon::current_thread_index() {
                    if let Ok(mut set) = unique_threads_for_closure.lock() {
                        set.insert(idx);
                    }
                }
                // Per-rayon-task locals. Each task spins up its own
                // decoder + router; the Arc'd entity index is shared
                // (read-only) across all tasks via Arc::clone (cheap
                // refcount bump).
                let mut decoder = EntityDecoder::with_arc_index(content, Arc::clone(&entity_index_arc));
                decoder.reserve_cache(big_chunk.len() / 3 * 2);
                let mut router = GeometryRouter::with_scale(unit_scale);
                if needs_shift {
                    router.set_rtc_offset((rtc_x, rtc_y, rtc_z));
                }
                let parts_to_skip = Arc::clone(&parts_to_skip);
                let mut local_meshes: Vec<MeshDataJs> =
                    Vec::with_capacity(big_chunk.len() / 3);
                let mut type_name_cache: rustc_hash::FxHashMap<
                    ifc_lite_core::IfcType,
                    String,
                > = rustc_hash::FxHashMap::default();

                for chunk in big_chunk.chunks(3) {
                    if chunk.len() < 3 {
                        break;
                    }
                    let id = chunk[0];
                    let start = chunk[1] as usize;
                    let end = chunk[2] as usize;

                    if parts_to_skip.contains(&id) {
                        continue;
                    }

                    let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
                        continue;
                    };
                    let has_representation =
                        entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                    if !has_representation {
                        continue;
                    }

                    let ifc_type = entity.ifc_type;
                    let has_openings = void_index.contains_key(&id);

                    if has_openings {
                        if let Ok(mut mesh) = router
                            .process_element_with_voids(&entity, &mut decoder, &void_index)
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
                                local_meshes.push(MeshDataJs::new(id, ifc_type_name, mesh, color));
                            }
                        }
                    } else {
                        // Same submesh-aware path as the serial variant.
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
                                    local_meshes.push(MeshDataJs::new(
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

                local_meshes.into_iter()
            })
            .collect();

        // Emit the diagnostic to JS console BEFORE building MeshCollection
        // so it shows up promptly in the dev tools.
        let total_tasks = task_count.load(Ordering::Relaxed);
        let unique_count = unique_threads.lock().map(|s| s.len()).unwrap_or(0);
        let pool_size = rayon::current_num_threads();
        web_sys::console::log_1(
            &format!(
                "[parallel] tasks={} unique_threads={} pool_size={} meshes={}",
                total_tasks, unique_count, pool_size, collected.len()
            )
            .into(),
        );

        let mut mesh_collection = MeshCollection::with_capacity(collected.len());
        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }
        for mesh in collected {
            mesh_collection.add(mesh);
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

        // Same Arc-cached entity index pattern as processGeometryBatch.
        let entity_index_arc: std::sync::Arc<ifc_lite_core::EntityIndex> = {
            // Mutex briefly held: peek at cache, build-if-empty, clone Arc.
            // The clone is what gets handed to rayon — no lock contention
            // on the per-job hot path that follows. Poison panics here
            // (an earlier panic-with-lock-held has corrupted the cache).
            let mut slot = self
                .cached_entity_index
                .lock()
                .expect("ifc-lite cached_entity_index Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                std::sync::Arc::clone(existing)
            } else {
                let built = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
                *slot = Some(std::sync::Arc::clone(&built));
                built
            }
        };
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index_arc);

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
                // IfcAlignment exception — see `parse_meshes`.
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
                if !has_representation && !is_alignment {
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
