// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC parsing and geometry processing commands
//!
//! These commands mirror the WASM API but use native Rust processing
//! for maximum performance with parallel processing via rayon.

use super::types::{
    CoordinateInfo, GeometryBatch, GeometryProgress, GeometryResult, GeometryStats, MeshData,
};
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{calculate_normals, GeometryRouter};
use rayon::prelude::*;
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;


/// Process IFC buffer and return all geometry meshes
#[tauri::command]
pub async fn get_geometry(buffer: Vec<u8>) -> Result<GeometryResult, String> {
    let content = String::from_utf8(buffer).map_err(|e| format!("Invalid UTF-8: {}", e))?;

    let (meshes, _stats) = process_geometry(&content)?;

    let total_vertices: usize = meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_triangles: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();

    Ok(GeometryResult {
        meshes,
        total_vertices,
        total_triangles,
        coordinate_info: CoordinateInfo::default(),
    })
}

/// Process IFC buffer with streaming - emits batches via events
#[tauri::command]
pub async fn get_geometry_streaming(
    buffer: Vec<u8>,
    window: tauri::Window,
) -> Result<GeometryStats, String> {
    let content = String::from_utf8(buffer).map_err(|e| format!("Invalid UTF-8: {}", e))?;

    let start = Instant::now();
    let parse_start = Instant::now();

    // Build entity index
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index.clone());

    // Build style and void indices
    let geometry_styles = build_geometry_style_index(&content, &mut decoder);
    let style_index = build_element_style_index(&content, &geometry_styles, &mut decoder);

    // Collect FacetedBrep IDs and void relationships
    let mut scanner = EntityScanner::new(&content);
    let mut faceted_brep_ids: Vec<u32> = Vec::new();
    let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
    let mut geometry_entity_count = 0;

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCFACETEDBREP" {
            faceted_brep_ids.push(id);
        } else if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at(start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
        if ifc_lite_core::has_geometry_by_name(type_name) {
            geometry_entity_count += 1;
        }
    }

    // Create geometry router with unit scale
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Batch preprocess FacetedBrep
    if !faceted_brep_ids.is_empty() {
        router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
    }

    let parse_time = parse_start.elapsed();

    // Process entities and emit batches
    let geometry_start = Instant::now();
    scanner = EntityScanner::new(&content);

    let mut total_meshes = 0;
    let mut total_vertices = 0;
    let mut total_triangles = 0;
    let mut batch: Vec<MeshData> = Vec::with_capacity(50);
    let mut processed = 0;

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        processed += 1;

        if let Ok(entity) = decoder.decode_at(start, end) {
            let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
            if !has_representation {
                continue;
            }

            if let Ok(mut mesh) =
                router.process_element_with_voids(&entity, &mut decoder, &void_index)
            {
                if !mesh.is_empty() {
                    if mesh.normals.is_empty() {
                        calculate_normals(&mut mesh);
                    }

                    let color = style_index
                        .get(&id)
                        .copied()
                        .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                    let mesh_data = convert_mesh_to_data(id, mesh, color);
                    total_vertices += mesh_data.positions.len() / 3;
                    total_triangles += mesh_data.indices.len() / 3;
                    total_meshes += 1;
                    batch.push(mesh_data);

                    // Emit batch every 50 meshes
                    if batch.len() >= 50 {
                        if let Err(e) = window.emit(
                            "geometry-batch",
                            GeometryBatch {
                                meshes: std::mem::take(&mut batch),
                                progress: GeometryProgress {
                                    processed,
                                    total: geometry_entity_count,
                                    current_type: type_name.to_string(),
                                },
                            },
                        ) {
                            eprintln!("[Native] Failed to emit geometry batch: {}", e);
                        }
                        batch = Vec::with_capacity(50);
                    }
                }
            }
        }
    }

    // Emit final batch
    if !batch.is_empty() {
        if let Err(e) = window.emit(
            "geometry-batch",
            GeometryBatch {
                meshes: batch,
                progress: GeometryProgress {
                    processed,
                    total: geometry_entity_count,
                    current_type: "complete".to_string(),
                },
            },
        ) {
            eprintln!("[Native] Failed to emit final geometry batch: {}", e);
        }
    }

    let geometry_time = geometry_start.elapsed();

    Ok(GeometryStats {
        total_meshes,
        total_vertices,
        total_triangles,
        parse_time_ms: parse_time.as_millis() as u64,
        geometry_time_ms: geometry_time.as_millis() as u64,
    })
}

/// Entity data collected for parallel processing
struct EntityJob {
    id: u32,
    start: usize,
    end: usize,
}

/// Internal function to process geometry (shared by sync and streaming)
/// Uses PARALLEL processing via rayon for maximum performance
fn process_geometry(content: &str) -> Result<(Vec<MeshData>, GeometryStats), String> {
    let parse_start = Instant::now();

    // Build entity index (this is fast)
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index.clone());

    // Build style index
    let geometry_styles = build_geometry_style_index(content, &mut decoder);
    let style_index = Arc::new(build_element_style_index(
        content,
        &geometry_styles,
        &mut decoder,
    ));

    // PHASE 1: Collect all entities that need processing (sequential scan)
    let mut scanner = EntityScanner::new(content);
    let mut faceted_brep_ids: Vec<u32> = Vec::new();
    let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
    let mut entity_jobs: Vec<EntityJob> = Vec::new();

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCFACETEDBREP" {
            faceted_brep_ids.push(id);
        } else if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at(start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }

        // Collect geometry entities for parallel processing
        if ifc_lite_core::has_geometry_by_name(type_name) {
            entity_jobs.push(EntityJob {
                id,
                start,
                end,
            });
        }
    }

    // Create geometry router with unit scale
    let router = GeometryRouter::with_units(content, &mut decoder);

    // Batch preprocess FacetedBrep
    if !faceted_brep_ids.is_empty() {
        router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
    }

    let parse_time = parse_start.elapsed();

    // PHASE 2: Process all entities in PARALLEL using rayon
    let geometry_start = Instant::now();

    // Share immutable data across threads
    let content_arc = Arc::new(content.to_string());
    let entity_index_arc = Arc::new(entity_index);
    let void_index_arc = Arc::new(void_index);

    // Process entities in parallel
    let meshes: Vec<MeshData> = entity_jobs
        .into_par_iter()
        .filter_map(|job| {
            // Each thread creates its own decoder (they're cheap)
            let mut local_decoder =
                EntityDecoder::with_index(&content_arc, (*entity_index_arc).clone());

            if let Ok(entity) = local_decoder.decode_at(job.start, job.end) {
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                if !has_representation {
                    return None;
                }

                // Create local router for this thread
                let local_router = GeometryRouter::with_units(&content_arc, &mut local_decoder);

                if let Ok(mut mesh) = local_router.process_element_with_voids(
                    &entity,
                    &mut local_decoder,
                    &void_index_arc,
                ) {
                    if !mesh.is_empty() {
                        if mesh.normals.is_empty() {
                            calculate_normals(&mut mesh);
                        }

                        let color = style_index
                            .get(&job.id)
                            .copied()
                            .unwrap_or_else(|| get_default_color_for_type(&entity.ifc_type));

                        return Some(convert_mesh_to_data(job.id, mesh, color));
                    }
                }
            }
            None
        })
        .collect();

    let geometry_time = geometry_start.elapsed();

    // Calculate totals
    let total_vertices: usize = meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_triangles: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();

    let stats = GeometryStats {
        total_meshes: meshes.len(),
        total_vertices,
        total_triangles,
        parse_time_ms: parse_time.as_millis() as u64,
        geometry_time_ms: geometry_time.as_millis() as u64,
    };

    eprintln!(
        "[Native] Processed {} meshes in {}ms (parse: {}ms, geometry: {}ms) - PARALLEL",
        meshes.len(),
        (parse_time + geometry_time).as_millis(),
        parse_time.as_millis(),
        geometry_time.as_millis()
    );

    Ok((meshes, stats))
}

/// Convert ifc_lite_geometry::Mesh to MeshData (with Z-up to Y-up conversion)
fn convert_mesh_to_data(
    express_id: u32,
    mesh: ifc_lite_geometry::Mesh,
    color: [f32; 4],
) -> MeshData {
    // Convert Z-up (IFC) to Y-up (WebGL)
    // New Y = old Z, New Z = -old Y
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for chunk in mesh.positions.chunks(3) {
        if chunk.len() == 3 {
            positions.push(chunk[0]); // X unchanged
            positions.push(chunk[2]); // Y = old Z
            positions.push(-chunk[1]); // Z = -old Y
        }
    }

    let mut normals = Vec::with_capacity(mesh.normals.len());
    for chunk in mesh.normals.chunks(3) {
        if chunk.len() == 3 {
            normals.push(chunk[0]); // X unchanged
            normals.push(chunk[2]); // Y = old Z
            normals.push(-chunk[1]); // Z = -old Y
        }
    }

    MeshData {
        express_id,
        positions,
        normals,
        indices: mesh.indices,
        color,
    }
}

/// Build geometry style index from IfcStyledItem entities
fn build_geometry_style_index(
    content: &str,
    decoder: &mut EntityDecoder,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    use rustc_hash::FxHashMap;

    let mut geometry_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);

    while let Some((_, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCSTYLEDITEM" {
            if let Ok(entity) = decoder.decode_at(start, end) {
                // IfcStyledItem: Item (0), Styles (1), Name (2)
                if let Some(item_ref) = entity.get_ref(0) {
                    // Try to extract color from Styles
                    if let Some(color) = extract_color_from_styled_item(&entity, decoder) {
                        geometry_styles.insert(item_ref, color);
                    }
                }
            }
        }
    }

    geometry_styles
}

/// Build element style index by traversing from IfcProduct → Representation → Item
fn build_element_style_index(
    content: &str,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    use rustc_hash::FxHashMap;

    let mut element_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);

    // Map representation items to their colors
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        if let Ok(entity) = decoder.decode_at(start, end) {
            // IfcProduct has Representation at index 6
            if let Some(repr_ref) = entity.get_ref(6) {
                // Try to find color through representation
                if let Some(color) =
                    find_color_for_representation(repr_ref, geometry_styles, decoder)
                {
                    element_styles.insert(id, color);
                }
            }
        }
    }

    element_styles
}

/// Try to extract color from IfcStyledItem's Styles attribute
fn extract_color_from_styled_item(
    _entity: &ifc_lite_core::DecodedEntity,
    _decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    // Simplified: return None for now, will use default colors
    // Full implementation would traverse IfcPresentationStyleAssignment → IfcSurfaceStyle → IfcSurfaceStyleRendering
    None
}

/// Find color for a representation by checking its items against geometry styles
fn find_color_for_representation(
    _repr_ref: u32,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    _decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    // Simplified: return first available color
    geometry_styles.values().next().copied()
}

/// Get default color based on IFC type
fn get_default_color_for_type(ifc_type: &IfcType) -> [f32; 4] {
    match ifc_type {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.9, 0.9, 0.85, 1.0],
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcRoof => [0.6, 0.3, 0.2, 1.0],
        IfcType::IfcColumn => [0.8, 0.8, 0.8, 1.0],
        IfcType::IfcBeam => [0.75, 0.75, 0.75, 1.0],
        IfcType::IfcDoor => [0.55, 0.35, 0.2, 1.0],
        IfcType::IfcWindow => [0.6, 0.8, 0.95, 0.5],
        IfcType::IfcStair | IfcType::IfcStairFlight => [0.65, 0.65, 0.65, 1.0],
        IfcType::IfcRailing => [0.5, 0.5, 0.5, 1.0],
        IfcType::IfcFurniture | IfcType::IfcFurnishingElement => [0.6, 0.5, 0.4, 1.0],
        IfcType::IfcPlate => [0.7, 0.75, 0.8, 1.0],
        IfcType::IfcMember => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcCovering => [0.85, 0.85, 0.8, 1.0],
        IfcType::IfcSpace => [0.5, 0.5, 0.8, 0.3],
        IfcType::IfcOpeningElement => [0.9, 0.9, 0.9, 0.2],
        _ => [0.7, 0.7, 0.7, 1.0], // Default gray
    }
}
