// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Streaming geometry processing with Server-Sent Events.

use crate::services::cache::DiskCache;
use crate::types::{CoordinateInfo, MeshData, ModelMetadata, ProcessingStats, StreamEvent};
use async_stream::stream;
use futures::Stream;
use ifc_lite_core::{
    build_entity_index, scan_placement_bounds, DecodedEntity, EntityDecoder, EntityIndex,
    EntityScanner, IfcType,
};
use ifc_lite_geometry::{calculate_normals, GeometryRouter};
use ifc_lite_processing::convert_mesh_to_site_local;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Job for processing a single entity.
#[derive(Clone)]
struct EntityJob {
    id: u32,
    type_name: String,
    ifc_type: IfcType,
    start: usize,
    end: usize,
}

/// Pre-computed data for streaming (all Send-safe).
struct PreparedData {
    content: Arc<String>,
    entity_index: Arc<EntityIndex>,
    style_index: Arc<FxHashMap<u32, [f32; 4]>>,
    void_index: Arc<FxHashMap<u32, Vec<u32>>>,
    jobs: Vec<EntityJob>,
    schema_version: String,
    total_entities: usize,
    parse_time_ms: u64,
    /// OPTIMIZATION: Precomputed unit scale to avoid parsing content per mesh
    unit_scale: f64,
    /// RTC offset for large-coordinate models (preserves precision in f32 output)
    rtc_offset: (f64, f64, f64),
    /// Coordinate space of serialized mesh vertices: `site_local`, `model_rtc`, or `raw_ifc`.
    mesh_coordinate_space: &'static str,
    /// IfcSite placement, already cheaply cloneable for the worker pool, and
    /// only populated when the selected coordinate space is `site_local`.
    /// Lets `process_batch` rotate mesh vertices into the site axis frame.
    site_local_rotation: Option<Arc<Vec<f64>>>,
    /// IfcSite ObjectPlacement as a column-major 4×4 matrix (metres).
    site_transform: Option<Vec<f64>>,
    /// IfcBuilding ObjectPlacement as a column-major 4×4 matrix (metres).
    building_transform: Option<Vec<f64>>,
}

/// Extract entity references from a list attribute.
fn get_refs_from_list(entity: &DecodedEntity, index: usize) -> Option<Vec<u32>> {
    let list = entity.get_list(index)?;
    let refs: Vec<u32> = list.iter().filter_map(|v| v.as_entity_ref()).collect();
    if refs.is_empty() {
        None
    } else {
        Some(refs)
    }
}

/// Prepare all data needed for streaming (runs synchronously).
fn prepare_streaming_data(content: String) -> PreparedData {
    let parse_start = std::time::Instant::now();

    // Build entity index
    let entity_index = Arc::new(build_entity_index(&content));
    let mut decoder = EntityDecoder::with_arc_index(&content, entity_index.clone());

    // OPTIMIZATION: Build style indices in a single pass (previously two separate scans)
    let style_index = build_style_indices(&content, &mut decoder);

    // Collect jobs and build void index
    let mut scanner = EntityScanner::new(&content);
    let mut faceted_brep_ids: Vec<u32> = Vec::new();
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut jobs: Vec<EntityJob> = Vec::with_capacity(2000);
    let mut schema_version = "IFC2X3".to_string();
    let mut total_entities = 0usize;
    let mut site_entity_pos: Option<(usize, usize)> = None;
    let mut building_entity_pos: Option<(usize, usize)> = None;

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        total_entities += 1;

        if type_name == "IFCFACETEDBREP" {
            faceted_brep_ids.push(id);
        } else if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at(start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host).or_default().push(opening);
                }
            }
        } else if type_name == "IFCSITE" && site_entity_pos.is_none() {
            site_entity_pos = Some((start, end));
        } else if type_name == "IFCBUILDING" && building_entity_pos.is_none() {
            building_entity_pos = Some((start, end));
        }

        if ifc_lite_core::has_geometry_by_name(type_name) {
            if let Ok(entity) = decoder.decode_at(start, end) {
                jobs.push(EntityJob {
                    id,
                    type_name: type_name.to_string(),
                    ifc_type: entity.ifc_type,
                    start,
                    end,
                });
            }
        }
    }

    // Detect schema
    if content.contains("IFC4X3") {
        schema_version = "IFC4X3".into();
    } else if content.contains("IFC4") {
        schema_version = "IFC4".into();
    }

    // Preprocess FacetedBreps and extract unit_scale + rtc_offset
    let mut router = GeometryRouter::with_units(&content, &mut decoder);
    // Resolve site/building placement transforms for cache consistency.
    let site_transform: Option<Vec<f64>> = site_entity_pos.and_then(|(start, end)| {
        let entity = decoder.decode_at(start, end).ok()?;
        let matrix = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok()?;
        Some(matrix.to_vec())
    });
    let building_transform: Option<Vec<f64>> = building_entity_pos.and_then(|(start, end)| {
        let entity = decoder.decode_at(start, end).ok()?;
        let matrix = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok()?;
        Some(matrix.to_vec())
    });

    let rtc_jobs: Vec<(u32, usize, usize, IfcType)> = jobs
        .iter()
        .map(|j| (j.id, j.start, j.end, j.ifc_type))
        .collect();
    let detected_rtc_offset = match router.detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder) {
        Some(offset) => offset,
        None => {
            // No usable translation samples — fall back to full-file coordinate scan
            // for files where large real-world coordinates are encoded in points
            // rather than in placement transforms.
            scan_placement_bounds(&content).rtc_offset()
        }
    };

    // Three-tier coordinate-space selection, mirroring the non-streaming path:
    //   1. site_local: IfcSite placement has a non-identity translation.
    //   2. model_rtc:  fall back to the detected anchor for large-coordinate files.
    //   3. raw_ifc:    neither anchor applies.
    const PLACEMENT_IDENTITY_EPSILON: f64 = 1e-9;
    let site_rtc = site_transform
        .as_ref()
        .map(|st| (st[12], st[13], st[14]))
        .filter(|t| {
            t.0.abs() > PLACEMENT_IDENTITY_EPSILON
                || t.1.abs() > PLACEMENT_IDENTITY_EPSILON
                || t.2.abs() > PLACEMENT_IDENTITY_EPSILON
        });
    let detected_has_offset = detected_rtc_offset.0.abs() > PLACEMENT_IDENTITY_EPSILON
        || detected_rtc_offset.1.abs() > PLACEMENT_IDENTITY_EPSILON
        || detected_rtc_offset.2.abs() > PLACEMENT_IDENTITY_EPSILON;
    let (rtc_offset, mesh_coordinate_space): ((f64, f64, f64), &'static str) =
        if let Some(site) = site_rtc {
            (site, "site_local")
        } else if detected_has_offset {
            (detected_rtc_offset, "model_rtc")
        } else {
            ((0.0, 0.0, 0.0), "raw_ifc")
        };
    router.set_rtc_offset(rtc_offset);
    if !faceted_brep_ids.is_empty() {
        router.preprocess_faceted_breps(&faceted_brep_ids, &mut decoder);
    }

    // OPTIMIZATION: Extract unit_scale before dropping router
    // This allows process_batch to use with_scale() instead of with_units() per mesh
    let unit_scale = router.unit_scale();
    drop(router); // Explicitly drop non-Send router

    let parse_time_ms = parse_start.elapsed().as_millis() as u64;

    let site_local_rotation = if mesh_coordinate_space == "site_local" {
        site_transform.clone().map(Arc::new)
    } else {
        None
    };

    PreparedData {
        content: Arc::new(content),
        entity_index, // Already Arc
        style_index: Arc::new(style_index),
        void_index: Arc::new(void_index),
        jobs,
        schema_version,
        total_entities,
        parse_time_ms,
        unit_scale,
        rtc_offset,
        mesh_coordinate_space,
        site_local_rotation,
        site_transform,
        building_transform,
    }
}

/// Process a batch of jobs (runs in blocking thread).
fn process_batch(
    jobs: Vec<EntityJob>,
    content: Arc<String>,
    entity_index: Arc<EntityIndex>,
    style_index: Arc<FxHashMap<u32, [f32; 4]>>,
    void_index: Arc<FxHashMap<u32, Vec<u32>>>,
    unit_scale: f64,
    rtc_offset: (f64, f64, f64),
    site_local_rotation: Option<Arc<Vec<f64>>>,
) -> Vec<MeshData> {
    jobs.par_iter()
        .filter_map(|job| {
            let mut local_decoder = EntityDecoder::with_arc_index(&content, entity_index.clone());

            if let Ok(entity) = local_decoder.decode_at(job.start, job.end) {
                let has_representation = entity.get(6).is_some_and(|a| !a.is_null());
                if !has_representation {
                    return None;
                }

                // OPTIMIZATION: Use with_scale() instead of with_units()
                // unit_scale is precomputed once, avoiding content parsing per mesh
                let local_router = GeometryRouter::with_scale_and_rtc(unit_scale, rtc_offset);

                if let Ok(mut mesh) = local_router.process_element_with_voids(
                    &entity,
                    &mut local_decoder,
                    void_index.as_ref(),
                ) {
                    if !mesh.is_empty() {
                        if mesh.normals.is_empty() {
                            calculate_normals(&mut mesh);
                        }

                        let color = style_index
                            .get(&job.id)
                            .copied()
                            .unwrap_or_else(|| get_default_color(&job.ifc_type));

                        let mut mesh_data = MeshData::new(
                            job.id,
                            job.ifc_type.name().to_string(),
                            mesh.positions,
                            mesh.normals,
                            mesh.indices,
                            color,
                        );
                        convert_mesh_to_site_local(
                            &mut mesh_data,
                            site_local_rotation.as_deref(),
                        );
                        return Some(mesh_data);
                    }
                }
            }
            None
        })
        .collect()
}

/// Calculate dynamic batch size based on batch number and total job count.
/// For large files, use MUCH larger batches to maximize parallel throughput and reduce overhead.
fn calculate_batch_size(
    batch_number: usize,
    initial_batch_size: usize,
    max_batch_size: usize,
    total_jobs: usize,
) -> usize {
    // For huge files (>50k jobs), use VERY aggressive batching to minimize batch count
    let adjusted_max = if total_jobs > 50_000 {
        // Very large files: 10k-20k entities per batch (minimize batch overhead)
        (max_batch_size * 20).min(20_000)
    } else if total_jobs > 10_000 {
        // Large files: 5k-10k entities per batch
        (max_batch_size * 10).min(10_000)
    } else if total_jobs > 1_000 {
        // Medium files: 2k-5k entities per batch
        (max_batch_size * 5).min(5_000)
    } else {
        max_batch_size
    };

    match batch_number {
        1..=2 => initial_batch_size, // Fast first frame (2 batches for quick start)
        3..=5 => (initial_batch_size + adjusted_max) / 2, // Ramp up quickly
        _ => adjusted_max,           // Full throughput (much larger batches)
    }
}

/// Generate streaming geometry events with dynamic batch sizing.
pub fn process_streaming(
    content: String,
    initial_batch_size: usize,
    max_batch_size: usize,
) -> Pin<Box<dyn Stream<Item = StreamEvent> + Send>> {
    Box::pin(stream! {
        let total_start = std::time::Instant::now();

        // Prepare data in blocking task (all CPU-intensive work)
        let prepared = tokio::task::spawn_blocking(move || {
            prepare_streaming_data(content)
        }).await;

        let prepared = match prepared {
            Ok(p) => p,
            Err(e) => {
                yield StreamEvent::Error {
                    message: format!("Failed to prepare data: {}", e),
                };
                return;
            }
        };

        let total_jobs = prepared.jobs.len();
        let geometry_entity_count = total_jobs;

        yield StreamEvent::Start {
            total_estimate: total_jobs,
        };

        yield StreamEvent::Progress {
            processed: 0,
            total: total_jobs,
            current_type: "indexing".into(),
        };

        let mut total_processed = 0;
        let mut all_meshes: Vec<MeshData> = Vec::new();
        let mut total_vertices = 0usize;
        let mut total_triangles = 0usize;

        // PIPELINED BATCH PROCESSING: Process multiple batches concurrently
        // Pipeline depth: more batches in flight = better CPU utilization
        let pipeline_depth = if total_jobs > 50_000 { 4 } else if total_jobs > 10_000 { 3 } else { 2 };
        let mut job_index = 0;
        let mut next_batch_num = 1;
        let mut next_expected_batch = 1;
        let mut completed_batches: std::collections::BTreeMap<usize, (usize, String, Vec<MeshData>)> = std::collections::BTreeMap::new();

        // Use a channel to receive completed batches
        let (tx, mut rx) = mpsc::unbounded_channel::<(usize, Result<(usize, String, Vec<MeshData>), String>)>();
        let mut in_flight = 0;

        loop {
            // Start new batches up to pipeline depth
            while in_flight < pipeline_depth && job_index < prepared.jobs.len() {
                let batch_num = next_batch_num;
                next_batch_num += 1;
                in_flight += 1;

                let current_batch_size = calculate_batch_size(
                    batch_num,
                    initial_batch_size,
                    max_batch_size,
                    total_jobs,
                );
                let end_index = (job_index + current_batch_size).min(prepared.jobs.len());
                let chunk: Vec<EntityJob> = prepared.jobs[job_index..end_index].to_vec();
                job_index = end_index;

                let chunk_len = chunk.len();
                let last_type_name = chunk.last().map(|j| j.type_name.clone()).unwrap_or_default();

                let chunk_vec = chunk;
                let content_bg = prepared.content.clone();
                let index_bg = prepared.entity_index.clone();
                let void_bg = prepared.void_index.clone();
                let style_bg = prepared.style_index.clone();
                let unit_scale = prepared.unit_scale;
                let rtc_offset = prepared.rtc_offset;
                let site_local_rotation = prepared.site_local_rotation.clone();
                let tx_clone = tx.clone();

                // Spawn batch processing task
                tokio::spawn(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        process_batch(
                            chunk_vec,
                            content_bg,
                            index_bg,
                            style_bg,
                            void_bg,
                            unit_scale,
                            rtc_offset,
                            site_local_rotation,
                        )
                    }).await;

                    let batch_result = match result {
                        Ok(meshes) => Ok((chunk_len, last_type_name, meshes)),
                        Err(e) => Err(format!("Batch processing failed: {}", e)),
                    };

                    let _ = tx_clone.send((batch_num, batch_result));
                });
            }

            // Receive completed batches (non-blocking)
            while let Ok((batch_num, result)) = rx.try_recv() {
                in_flight -= 1;
                match result {
                    Ok(data) => {
                        completed_batches.insert(batch_num, data);
                    }
                    Err(e) => {
                        yield StreamEvent::Error {
                            message: format!("Batch {}: {}", batch_num, e),
                        };
                    }
                }
            }

            // Yield completed batches in order
            while let Some((chunk_len, last_type_name, meshes)) = completed_batches.remove(&next_expected_batch) {
                total_processed += chunk_len;
                let batch_number = next_expected_batch;

                // Update stats
                for mesh in &meshes {
                    total_vertices += mesh.vertex_count();
                    total_triangles += mesh.triangle_count();
                }

                if !meshes.is_empty() {
                    all_meshes.extend(meshes.iter().cloned());
                    yield StreamEvent::Batch {
                        meshes,
                        batch_number,
                    };
                }

                yield StreamEvent::Progress {
                    processed: total_processed,
                    total: total_jobs,
                    current_type: last_type_name,
                };

                next_expected_batch += 1;
            }

            // Check if we're done
            if job_index >= prepared.jobs.len() && in_flight == 0 && completed_batches.is_empty() {
                break;
            }

            // Yield control to allow other tasks to run
            tokio::task::yield_now().await;
        }

        let total_time = total_start.elapsed();

        // Generate cache key for the complete result
        let cache_key = DiskCache::generate_key(prepared.content.as_bytes());

        yield StreamEvent::Complete {
            stats: ProcessingStats {
                total_meshes: all_meshes.len(),
                total_vertices,
                total_triangles,
                parse_time_ms: prepared.parse_time_ms,
                entity_scan_time_ms: 0,
                lookup_time_ms: 0,
                preprocess_time_ms: 0,
                geometry_time_ms: total_time.as_millis() as u64 - prepared.parse_time_ms,
                total_time_ms: total_time.as_millis() as u64,
                from_cache: false,
            },
            metadata: ModelMetadata {
                schema_version: prepared.schema_version,
                entity_count: prepared.total_entities,
                geometry_entity_count,
                coordinate_info: CoordinateInfo {
                    origin_shift: [
                        prepared.rtc_offset.0,
                        prepared.rtc_offset.1,
                        prepared.rtc_offset.2,
                    ],
                    is_geo_referenced: prepared.rtc_offset.0 != 0.0
                        || prepared.rtc_offset.1 != 0.0
                        || prepared.rtc_offset.2 != 0.0,
                },
            },
            cache_key,
            mesh_coordinate_space: Some(prepared.mesh_coordinate_space.to_string()),
            site_transform: prepared.site_transform,
            building_transform: prepared.building_transform,
        };
    })
}

// Helper functions for style extraction

/// OPTIMIZATION: Build both style indices in a single pass through entities.
/// Previously, build_geometry_style_index and build_element_style_index each scanned all entities.
/// This combined function scans once and builds both maps together, reducing I/O overhead.
fn build_style_indices(content: &str, decoder: &mut EntityDecoder) -> FxHashMap<u32, [f32; 4]> {
    // Phase 1: Single scan to collect styled items and geometry-bearing elements
    let mut geometry_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut element_repr_ids: Vec<(u32, u32)> = Vec::with_capacity(2000); // (element_id, repr_id)
    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        // Collect IfcStyledItem data
        if type_name == "IFCSTYLEDITEM" {
            if let Ok(styled_item) = decoder.decode_at(start, end) {
                if let Some(geometry_id) = styled_item.get_ref(0) {
                    if !geometry_styles.contains_key(&geometry_id) {
                        if let Some(color) = extract_color_from_styled_item(&styled_item, decoder) {
                            geometry_styles.insert(geometry_id, color);
                        }
                    }
                }
            }
        }
        // Collect geometry-bearing element representation IDs
        else if ifc_lite_core::has_geometry_by_name(type_name) {
            if let Ok(element) = decoder.decode_at(start, end) {
                if let Some(repr_id) = element.get_ref(6) {
                    element_repr_ids.push((id, repr_id));
                }
            }
        }
    }

    // Phase 2: Build element style index using collected data (no re-scan needed)
    let mut element_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    for (element_id, repr_id) in element_repr_ids {
        if let Some(color) = find_color_in_representation(repr_id, &geometry_styles, decoder) {
            element_styles.insert(element_id, color);
        }
    }

    element_styles
}

fn find_color_in_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let repr = decoder.decode_by_id(repr_id).ok()?;
    let repr_list = get_refs_from_list(&repr, 2)?;

    for shape_repr_id in repr_list {
        if let Ok(shape_repr) = decoder.decode_by_id(shape_repr_id) {
            if let Some(items) = get_refs_from_list(&shape_repr, 3) {
                for item_id in items {
                    if let Some(color) = geometry_styles.get(&item_id) {
                        return Some(*color);
                    }

                    if let Ok(item) = decoder.decode_by_id(item_id) {
                        if item.ifc_type == IfcType::IfcMappedItem {
                            if let Some(source_id) = item.get_ref(0) {
                                if let Ok(source) = decoder.decode_by_id(source_id) {
                                    if let Some(mapped_repr_id) = source.get_ref(1) {
                                        if let Some(color) = find_color_in_shape_representation(
                                            mapped_repr_id,
                                            geometry_styles,
                                            decoder,
                                        ) {
                                            return Some(color);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

fn find_color_in_shape_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let repr = decoder.decode_by_id(repr_id).ok()?;
    let items = get_refs_from_list(&repr, 3)?;

    for item_id in items {
        if let Some(color) = geometry_styles.get(&item_id) {
            return Some(*color);
        }
    }

    None
}

fn extract_color_from_styled_item(
    styled_item: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let style_refs = get_refs_from_list(styled_item, 1)?;

    for style_id in style_refs {
        if let Ok(style) = decoder.decode_by_id(style_id) {
            if let Some(inner_refs) = get_refs_from_list(&style, 0) {
                for inner_id in inner_refs {
                    if let Some(color) = extract_surface_style_color(inner_id, decoder) {
                        return Some(color);
                    }
                }
            }
            if let Some(color) = extract_surface_style_color(style_id, decoder) {
                return Some(color);
            }
        }
    }

    None
}

fn extract_surface_style_color(style_id: u32, decoder: &mut EntityDecoder) -> Option<[f32; 4]> {
    let style = decoder.decode_by_id(style_id).ok()?;
    let rendering_refs = get_refs_from_list(&style, 2)?;

    for rendering_id in rendering_refs {
        if let Ok(rendering) = decoder.decode_by_id(rendering_id) {
            if let Some(color_id) = rendering.get_ref(0) {
                if let Ok(color) = decoder.decode_by_id(color_id) {
                    let r = color.get_float(1).unwrap_or(0.8) as f32;
                    let g = color.get_float(2).unwrap_or(0.8) as f32;
                    let b = color.get_float(3).unwrap_or(0.8) as f32;
                    let alpha: f32 = 1.0 - rendering.get_float(8).unwrap_or(0.0) as f32;

                    return Some([r, g, b, alpha.max(0.0).min(1.0)]);
                }
            }
        }
    }

    None
}

fn get_default_color(ifc_type: &IfcType) -> [f32; 4] {
    match ifc_type {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],
        IfcType::IfcStair | IfcType::IfcStairFlight => [0.75, 0.75, 0.75, 1.0],
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],
        IfcType::IfcFurnishingElement => [0.5, 0.35, 0.2, 1.0],
        // Space - cyan transparent (matches MainToolbar)
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],
        // Opening elements - red-orange transparent
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],
        // Site - green
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],
        IfcType::IfcBuildingElementProxy => [0.6, 0.6, 0.6, 1.0],
        _ => [0.8, 0.8, 0.8, 1.0],
    }
}
