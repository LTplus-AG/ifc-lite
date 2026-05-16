// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parse endpoints for IFC file processing.

use crate::error::ApiError;
use crate::services::{
    cache::DiskCache, extract_data_model, process_geometry_filtered, process_streaming,
    serialize_data_model_to_parquet, serialize_to_parquet,
    serialize_to_parquet_optimized_with_stats, OpeningFilterMode, OptimizedStats,
    VERTEX_MULTIPLIER,
};
use crate::types::{MetadataResponse, ModelMetadata, ParseResponse, ProcessingStats, StreamEvent};
use crate::AppState;
use axum::{
    body::Body,
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Response,
    },
    Json,
};
use flate2::read::GzDecoder;
use futures::stream::StreamExt;
use ifc_lite_core::EntityScanner;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::io::Read;

/// Query parameters shared by all parse endpoints.
#[derive(serde::Deserialize, Default)]
pub struct ParseQuery {
    /// Opening filter mode: "default", "ignore_all", or "ignore_opaque".
    #[serde(default)]
    pub opening_filter: OpeningFilterMode,
}

fn reject_unsupported_streaming_opening_filter(query: &ParseQuery) -> Result<(), ApiError> {
    if query.opening_filter == OpeningFilterMode::Default {
        return Ok(());
    }

    Err(ApiError::BadRequest(
        "opening_filter is not yet supported for streaming endpoints; use /api/v1/parse or /api/v1/parse/parquet instead".into(),
    ))
}

/// Build the parquet geometry cache key for a given file hash and opening filter.
///
/// Must stay in sync with the writer in `parse_parquet` / `parse_parquet_stream`,
/// which derives the same suffix from `OpeningFilterMode::cache_key_suffix()`.
fn parquet_cache_key(hash: &str, opening_filter: OpeningFilterMode) -> String {
    format!("{}-{}-parquet-v2", hash, opening_filter.cache_key_suffix())
}

/// Build the parquet metadata cache key for a given file hash and opening filter.
fn parquet_metadata_cache_key(hash: &str, opening_filter: OpeningFilterMode) -> String {
    format!(
        "{}-{}-parquet-metadata-v2",
        hash,
        opening_filter.cache_key_suffix()
    )
}

/// Extract file data from multipart request.
/// Automatically decompresses gzip-compressed files, refusing inputs whose
/// decompressed size would exceed `max_file_size_mb`.
async fn extract_file(
    multipart: &mut Multipart,
    max_file_size_mb: usize,
) -> Result<Vec<u8>, ApiError> {
    let max_bytes = max_file_size_mb.saturating_mul(1024 * 1024);

    while let Some(field) = multipart.next_field().await? {
        let field_name = field.name().unwrap_or_default();
        tracing::debug!(field_name = %field_name, "Processing multipart field");

        if field_name == "file" {
            let bytes = field.bytes().await?;
            let original_size = bytes.len();
            tracing::debug!(size = original_size, "Extracted file from multipart");

            // Check if file is gzip-compressed (magic bytes: 1f 8b)
            let is_gzipped = bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b;

            if is_gzipped {
                tracing::debug!("Detected gzip compression, decompressing...");
                // Bound the decompressed stream: read at most max_bytes + 1.
                // If the cap is hit, treat as oversized rather than allocating
                // unbounded output for a small compressed input.
                let mut decoder = GzDecoder::new(bytes.as_ref()).take(max_bytes as u64 + 1);
                let mut decompressed = Vec::new();
                decoder
                    .read_to_end(&mut decompressed)
                    .map_err(|e| ApiError::Internal(format!("Failed to decompress gzip: {}", e)))?;
                if decompressed.len() > max_bytes {
                    return Err(ApiError::FileTooLarge {
                        max_mb: max_file_size_mb,
                    });
                }
                tracing::info!(
                    original_size = original_size,
                    decompressed_size = decompressed.len(),
                    compression_ratio =
                        format!("{:.1}x", original_size as f64 / decompressed.len() as f64),
                    "File decompressed successfully"
                );
                return Ok(decompressed);
            } else {
                if bytes.len() > max_bytes {
                    return Err(ApiError::FileTooLarge {
                        max_mb: max_file_size_mb,
                    });
                }
                return Ok(bytes.to_vec());
            }
        }
    }

    tracing::warn!("No 'file' field found in multipart request");
    Err(ApiError::MissingFile)
}

/// POST /api/v1/parse - Full synchronous parse.
pub async fn parse_full(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Json<ParseResponse>, ApiError> {
    // Extract file from multipart
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let cache_key = format!(
        "{}-{}",
        DiskCache::generate_key(&data),
        query.opening_filter.cache_key_suffix()
    );

    // Check cache first
    if let Some(mut cached) = state.cache.get::<ParseResponse>(&cache_key).await? {
        tracing::info!(cache_key = %cache_key, "Cache HIT");
        cached.stats.from_cache = true;
        return Ok(Json(cached));
    }

    tracing::info!(cache_key = %cache_key, size = data.len(), "Cache MISS - processing");

    // Parse content
    let content = String::from_utf8(data)?;
    let opening_filter = query.opening_filter;

    // Process on blocking thread pool (CPU-intensive)
    let result =
        tokio::task::spawn_blocking(move || process_geometry_filtered(&content, opening_filter))
            .await?;

    let response = ParseResponse {
        cache_key: cache_key.clone(),
        meshes: result.meshes,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        metadata: result.metadata,
        stats: result.stats,
    };

    // Cache result (background)
    let cache = state.cache.clone();
    let response_clone = response.clone();
    tokio::spawn(async move {
        if let Err(e) = cache.set(&cache_key, &response_clone).await {
            tracing::error!(error = %e, "Failed to cache result");
        }
    });

    Ok(Json(response))
}

/// POST /api/v1/parse/stream - Streaming SSE parse.
pub async fn parse_stream(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    reject_unsupported_streaming_opening_filter(&query)?;

    // Extract file
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    let content = String::from_utf8(data)?;
    let initial_batch_size = state.config.initial_batch_size;
    let max_batch_size = state.config.max_batch_size;

    // Create streaming response with dynamic batch sizing
    let stream =
        process_streaming(content, initial_batch_size, max_batch_size).map(|event: StreamEvent| {
            let json = serde_json::to_string(&event).unwrap_or_else(|e| {
                serde_json::to_string(&StreamEvent::Error {
                    message: e.to_string(),
                })
                .unwrap()
            });
            Ok(Event::default().data(json))
        });

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// SSE event types for Parquet streaming.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ParquetStreamEvent {
    /// Initial event with estimated totals.
    Start {
        total_estimate: usize,
        cache_key: String,
    },
    /// Progress update.
    Progress { processed: usize, total: usize },
    /// Batch of geometry data as base64-encoded Parquet.
    Batch {
        /// Base64-encoded Parquet data containing this batch's meshes.
        data: String,
        /// Number of meshes in this batch.
        mesh_count: usize,
        /// Batch sequence number (1-indexed).
        batch_number: usize,
    },
    /// Processing complete.
    Complete {
        stats: ProcessingStats,
        metadata: ModelMetadata,
    },
    /// Error occurred.
    Error { message: String },
}

/// POST /api/v1/parse/parquet-stream - Streaming parse with Parquet batches.
///
/// Returns SSE events with Parquet-encoded geometry batches for progressive rendering.
/// Each batch can be decoded and rendered immediately without waiting for the full response.
///
/// Events:
/// - `start`: Initial event with `total_estimate` and `cache_key`
/// - `progress`: Progress updates with `processed` and `total` counts
/// - `batch`: Geometry batch with base64-encoded Parquet `data`, `mesh_count`, `batch_number`
/// - `complete`: Final event with `stats` and `metadata`
/// - `error`: Error event with `message`
///
/// After `complete`, client should fetch data model via `/api/v1/data-model/{cache_key}`.
pub async fn parse_parquet_stream(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<
    Sse<std::pin::Pin<Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>>>,
    ApiError,
> {
    use crate::services::serialize_to_parquet;
    use crate::types::MeshData;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use futures::StreamExt;
    use std::sync::{Arc, Mutex};

    reject_unsupported_streaming_opening_filter(&query)?;

    // Extract file
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key before processing (include opening filter)
    let cache_key = format!(
        "{}-{}",
        DiskCache::generate_key(&data),
        query.opening_filter.cache_key_suffix()
    );
    let cache_key_clone = cache_key.clone();

    // OPTIMIZATION: Check cache first and fast-path return if available
    // This avoids re-processing files that are already cached
    let parquet_cache_key = format!("{}-parquet-v2", cache_key);
    let metadata_cache_key = format!("{}-parquet-metadata-v2", cache_key);

    if let (Some(cached_parquet), Some(cached_metadata_json)) = (
        state.cache.get_bytes(&parquet_cache_key).await?,
        state.cache.get_bytes(&metadata_cache_key).await?,
    ) {
        tracing::info!(
            cache_key = %cache_key,
            parquet_size = cached_parquet.len(),
            "Streaming cache HIT - returning cached data as fast stream"
        );

        // Parse cached metadata
        let metadata_header: ParquetMetadataHeader = serde_json::from_slice(&cached_metadata_json)
            .map_err(|e| ApiError::Internal(format!("Failed to parse cached metadata: {}", e)))?;

        // Extract geometry length from combined parquet (first 4 bytes)
        let geometry_len = u32::from_le_bytes(cached_parquet[0..4].try_into().unwrap()) as usize;
        let geometry_data = cached_parquet[4..4 + geometry_len].to_vec();

        // Create fast stream with cached data
        let cache_key_for_stream = cache_key.clone();
        let fast_stream: std::pin::Pin<
            Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>,
        > = Box::pin(futures::stream::iter(vec![
            // Start event
            Ok::<_, Infallible>(
                Event::default().data(
                    serde_json::to_string(&ParquetStreamEvent::Start {
                        total_estimate: metadata_header.stats.total_meshes,
                        cache_key: cache_key_for_stream.clone(),
                    })
                    .unwrap(),
                ),
            ),
            // Single batch with all cached geometry
            Ok(Event::default().data(
                serde_json::to_string(&ParquetStreamEvent::Batch {
                    data: base64::engine::general_purpose::STANDARD.encode(&geometry_data),
                    mesh_count: metadata_header.stats.total_meshes,
                    batch_number: 1,
                })
                .unwrap(),
            )),
            // Complete event
            Ok(Event::default().data(
                serde_json::to_string(&ParquetStreamEvent::Complete {
                    stats: metadata_header.stats,
                    metadata: metadata_header.metadata,
                })
                .unwrap(),
            )),
        ]));

        return Ok(Sse::new(fast_stream).keep_alive(KeepAlive::default()));
    }

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Streaming cache MISS - processing file"
    );

    let content = String::from_utf8(data)?;
    let initial_batch_size = state.config.initial_batch_size;
    let max_batch_size = state.config.max_batch_size;
    let cache = state.cache.clone();

    // OPTIMIZATION: Accumulate meshes during streaming to avoid re-processing for cache
    // This shared container collects all streamed meshes for caching
    let accumulated_meshes: Arc<Mutex<Vec<MeshData>>> = Arc::new(Mutex::new(Vec::new()));
    let accumulated_meshes_for_stream = accumulated_meshes.clone();
    let cache_for_geometry = cache.clone();
    let cache_key_for_geometry = cache_key.clone();

    // Create streaming response that yields Parquet batches
    let stream = process_streaming(content.clone(), initial_batch_size, max_batch_size).map(move |event: StreamEvent| {
        let sse_event = match event {
            StreamEvent::Start { total_estimate } => {
                ParquetStreamEvent::Start {
                    total_estimate,
                    cache_key: cache_key_clone.clone(),
                }
            }
            StreamEvent::Progress { processed, total, .. } => {
                ParquetStreamEvent::Progress { processed, total }
            }
            StreamEvent::Batch { meshes, batch_number } => {
                // OPTIMIZATION: Accumulate meshes for caching (avoids re-processing)
                if let Ok(mut acc) = accumulated_meshes_for_stream.lock() {
                    acc.extend(meshes.iter().cloned());
                }

                // Serialize batch to Parquet and base64 encode
                match serialize_to_parquet(&meshes) {
                    Ok(parquet_bytes) => {
                        let base64_data = STANDARD.encode(&parquet_bytes);
                        ParquetStreamEvent::Batch {
                            data: base64_data,
                            mesh_count: meshes.len(),
                            batch_number,
                        }
                    }
                    Err(e) => {
                        ParquetStreamEvent::Error {
                            message: format!("Failed to serialize batch: {}", e),
                        }
                    }
                }
            }
            StreamEvent::Complete { stats, metadata, mesh_coordinate_space, site_transform, building_transform, .. } => {
                // OPTIMIZATION: Use accumulated meshes instead of re-processing
                // This eliminates duplicate geometry extraction (~1100ms savings for large files)
                let cache = cache_for_geometry.clone();
                let key = cache_key_for_geometry.clone();
                let stats_clone = stats.clone();
                let metadata_clone = metadata.clone();
                let meshes_for_cache = accumulated_meshes.clone();
                let coord_space = mesh_coordinate_space.clone();
                let site_tf = site_transform.clone();
                let building_tf = building_transform.clone();

                tokio::spawn(async move {
                    // Take accumulated meshes (moves out of Arc<Mutex>)
                    let all_meshes = {
                        match meshes_for_cache.lock() {
                            Ok(mut guard) => std::mem::take(&mut *guard),
                            Err(_) => {
                                tracing::error!("Failed to lock accumulated meshes for caching");
                                return;
                            }
                        }
                    };

                    if all_meshes.is_empty() {
                        tracing::warn!("No meshes accumulated for caching");
                        return;
                    }

                    tracing::info!(
                        mesh_count = all_meshes.len(),
                        "Caching accumulated meshes from stream (no re-processing)"
                    );

                    // Serialize accumulated meshes to Parquet (no re-processing needed!)
                    let serialize_result = tokio::task::spawn_blocking(move || {
                        serialize_to_parquet(&all_meshes)
                    }).await;

                    if let Ok(Ok(geometry_parquet)) = serialize_result {
                        // Build combined format (same as non-streaming endpoint)
                        // Format: [geometry_len: u32][geometry_data][data_model_len: u32]
                        let mut combined_parquet = Vec::new();
                        combined_parquet.extend_from_slice(&(geometry_parquet.len() as u32).to_le_bytes());
                        combined_parquet.extend_from_slice(&geometry_parquet);
                        combined_parquet.extend_from_slice(&0u32.to_le_bytes()); // data_model_len = 0

                        // Cache geometry (same format as non-streaming)
                        let parquet_cache_key = format!("{}-parquet-v2", key);
                        if let Err(e) = cache.set_bytes(&parquet_cache_key, &combined_parquet).await {
                            tracing::error!(error = %e, "Failed to cache geometry from stream");
                        } else {
                            tracing::info!(
                                cache_key = %parquet_cache_key,
                                size = combined_parquet.len(),
                                "Geometry cached from stream (optimized - no re-processing)"
                            );
                        }

                        // Cache metadata
                        let metadata_header = ParquetMetadataHeader {
                            cache_key: key.clone(),
                            metadata: metadata_clone,
                            stats: stats_clone,
                            mesh_coordinate_space: coord_space,
                            site_transform: site_tf,
                            building_transform: building_tf,
                            data_model_stats: None, // Data model cached separately via data model endpoint
                        };
                        if let Ok(metadata_json) = serde_json::to_vec(&metadata_header) {
                            let metadata_cache_key = format!("{}-parquet-metadata-v2", key);
                            if let Err(e) = cache.set_bytes(&metadata_cache_key, &metadata_json).await {
                                tracing::error!(error = %e, "Failed to cache metadata from stream");
                            } else {
                                tracing::debug!(cache_key = %metadata_cache_key, "Metadata cached from stream");
                            }
                        }
                    } else {
                        tracing::error!("Failed to serialize accumulated meshes for caching");
                    }
                });

                ParquetStreamEvent::Complete { stats, metadata }
            }
            StreamEvent::Error { message } => {
                ParquetStreamEvent::Error { message }
            }
        };

        let json = serde_json::to_string(&sse_event).unwrap_or_else(|e| {
            serde_json::to_string(&ParquetStreamEvent::Error {
                message: e.to_string(),
            })
            .unwrap()
        });
        Ok(Event::default().data(json))
    });

    // Spawn background task to extract and cache data model
    let content_for_cache = content.clone();
    let cache_key_for_dm = cache_key.clone();
    let cache_for_dm = cache.clone();
    tokio::spawn(async move {
        // Run data model extraction in blocking task
        let dm_result =
            tokio::task::spawn_blocking(move || extract_data_model(&content_for_cache)).await;

        if let Ok(data_model) = dm_result {
            // Serialize and cache
            let serialize_result =
                tokio::task::spawn_blocking(move || serialize_data_model_to_parquet(&data_model))
                    .await;

            if let Ok(Ok(parquet_data)) = serialize_result {
                let dm_key = format!("{}-datamodel-v2", cache_key_for_dm);
                if let Err(e) = cache_for_dm.set_bytes(&dm_key, &parquet_data).await {
                    tracing::error!(error = %e, "Failed to cache data model from stream");
                } else {
                    tracing::info!(cache_key = %dm_key, size = parquet_data.len(), "Data model cached from stream");
                }
            }
        }
    });

    let boxed_stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>,
    > = Box::pin(stream);
    Ok(Sse::new(boxed_stream).keep_alive(KeepAlive::default()))
}

/// POST /api/v1/parse/metadata - Quick metadata only (no geometry).
pub async fn parse_metadata(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<MetadataResponse>, ApiError> {
    // Extract file
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    let file_size = data.len();
    let content = String::from_utf8(data)?;

    // Fast path - just scan entities, no geometry processing
    let result = tokio::task::spawn_blocking(move || {
        let mut scanner = EntityScanner::new(&content);
        let mut entity_count = 0usize;
        let mut geometry_count = 0usize;

        while let Some((_, type_name, _, _)) = scanner.next_entity() {
            entity_count += 1;
            if ifc_lite_core::has_geometry_by_name(type_name) {
                geometry_count += 1;
            }
        }

        // Detect schema version
        let schema_version = if content.contains("IFC4X3") {
            "IFC4X3"
        } else if content.contains("IFC4") {
            "IFC4"
        } else {
            "IFC2X3"
        };

        MetadataResponse {
            entity_count,
            geometry_count,
            schema_version: schema_version.to_string(),
            file_size,
        }
    })
    .await?;

    Ok(Json(result))
}

/// Response header containing metadata for Parquet response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParquetMetadataHeader {
    pub cache_key: String,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_coordinate_space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_transform: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub building_transform: Option<Vec<f64>>,
    /// Data model statistics (if included).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_model_stats: Option<DataModelStats>,
}

/// Data model extraction statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataModelStats {
    pub entity_count: usize,
    pub property_set_count: usize,
    pub relationship_count: usize,
    pub spatial_node_count: usize,
}

/// POST /api/v1/parse/parquet - Full parse with Parquet-encoded geometry.
///
/// Returns binary Parquet data with ~15x smaller payload than JSON.
/// Response format:
/// - Content-Type: application/x-parquet-geometry
/// - X-IFC-Metadata: JSON-encoded ParquetMetadataHeader
/// - Body: Binary Parquet data (mesh_parquet + vertex_parquet + index_parquet)
pub async fn parse_parquet(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    // Extract file from multipart
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let cache_key = format!(
        "{}-{}",
        DiskCache::generate_key(&data),
        query.opening_filter.cache_key_suffix()
    );

    // Check cache first (before any processing)
    let parquet_cache_key = format!("{}-parquet-v2", cache_key);
    let metadata_cache_key = format!("{}-parquet-metadata-v2", cache_key);

    if let (Some(cached_parquet), Some(cached_metadata_json)) = (
        state.cache.get_bytes(&parquet_cache_key).await?,
        state.cache.get_bytes(&metadata_cache_key).await?,
    ) {
        tracing::info!(
            cache_key = %cache_key,
            parquet_size = cached_parquet.len(),
            "Parquet cache HIT - returning cached response"
        );

        // Build response from cached data
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-parquet-geometry")
            .header("X-IFC-Metadata", String::from_utf8(cached_metadata_json)?)
            .header(header::CONTENT_LENGTH, cached_parquet.len())
            .body(Body::from(cached_parquet))
            .map_err(|e| ApiError::Internal(e.to_string()))?;

        return Ok(response);
    }

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Parquet cache MISS - processing file"
    );

    // Parse content
    let content = String::from_utf8(data)?;

    // Process geometry and data model extraction + serialization ALL in parallel
    // rayon::join works correctly here because rayon has its own thread pool
    // that's independent of tokio's blocking thread pool
    let serialize_start = tokio::time::Instant::now();
    let opening_filter = query.opening_filter;
    let ((geometry_result, geometry_parquet), (data_model_stats, data_model_parquet)) =
        tokio::task::spawn_blocking(move || {
            // First: extract geometry and data model in parallel
            let (geometry_result, data_model) = rayon::join(
                || process_geometry_filtered(&content, opening_filter),
                || extract_data_model(&content),
            );

            // Capture stats before moving data_model
            let dm_stats = DataModelStats {
                entity_count: data_model.entities.len(),
                property_set_count: data_model.property_sets.len(),
                relationship_count: data_model.relationships.len(),
                spatial_node_count: data_model.spatial_hierarchy.nodes.len(),
            };

            // Second: serialize BOTH geometry and data model in parallel
            // This way data model is ready by the time client needs it
            let (geo_parquet, dm_parquet) = rayon::join(
                || serialize_to_parquet(&geometry_result.meshes),
                || serialize_data_model_to_parquet(&data_model),
            );

            ((geometry_result, geo_parquet), (dm_stats, dm_parquet))
        })
        .await?;

    // Unwrap serialization results
    let geometry_parquet = geometry_parquet?;
    let data_model_parquet = data_model_parquet?;

    let serialize_time = serialize_start.elapsed();
    tracing::info!(
        meshes = geometry_result.meshes.len(),
        geometry_parquet_size = geometry_parquet.len(),
        data_model_parquet_size = data_model_parquet.len(),
        total_serialize_time_ms = serialize_time.as_millis(),
        "Geometry and data model serialization complete (parallel)"
    );

    // Cache data model IMMEDIATELY (not in background) so it's ready when client polls
    let data_model_cache_key = format!("{}-datamodel-v2", cache_key);
    if let Err(e) = state
        .cache
        .set_bytes(&data_model_cache_key, &data_model_parquet)
        .await
    {
        tracing::error!(error = %e, "Failed to cache data model");
    } else {
        tracing::info!(
            cache_key = %data_model_cache_key,
            size = data_model_parquet.len(),
            "Data model cached (ready for client)"
        );
    }

    // Build geometry-only response (data model available via separate endpoint)
    let mut combined_parquet = Vec::new();
    combined_parquet.extend_from_slice(&(geometry_parquet.len() as u32).to_le_bytes());
    combined_parquet.extend_from_slice(&geometry_parquet);
    // No data model in immediate response - client fetches separately
    combined_parquet.extend_from_slice(&0u32.to_le_bytes()); // data_model_len = 0

    // Create metadata header with data model stats (captured before background task)
    let cache_key_clone = cache_key.clone();
    let metadata_header = ParquetMetadataHeader {
        cache_key: cache_key_clone.clone(),
        metadata: geometry_result.metadata,
        stats: geometry_result.stats,
        mesh_coordinate_space: geometry_result.mesh_coordinate_space,
        site_transform: geometry_result.site_transform,
        building_transform: geometry_result.building_transform,
        data_model_stats: Some(data_model_stats),
    };

    let metadata_json = serde_json::to_string(&metadata_header)?;

    // Cache the results for future requests
    let parquet_cache_key = format!("{}-parquet-v2", cache_key_clone);
    let metadata_cache_key = format!("{}-parquet-metadata-v2", cache_key_clone);
    let combined_parquet_clone = combined_parquet.clone();
    let metadata_json_clone = metadata_json.clone();
    let cache = state.cache.clone();

    // Cache in background (don't block response)
    tokio::spawn(async move {
        if let Err(e) = cache
            .set_bytes(&parquet_cache_key, &combined_parquet_clone)
            .await
        {
            tracing::error!(error = %e, "Failed to cache Parquet bytes");
        }
        if let Err(e) = cache
            .set_bytes(&metadata_cache_key, metadata_json_clone.as_bytes())
            .await
        {
            tracing::error!(error = %e, "Failed to cache metadata");
        }
        tracing::info!(
            cache_key = %cache_key_clone,
            parquet_size = combined_parquet_clone.len(),
            "Cached Parquet response"
        );
    });

    // Build response with binary body and metadata header
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-parquet-geometry")
        .header("X-IFC-Metadata", metadata_json)
        .header(header::CONTENT_LENGTH, combined_parquet.len())
        .body(Body::from(combined_parquet))
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(response)
}

/// Response header containing metadata for optimized Parquet response.
#[derive(Debug, Clone, Serialize)]
pub struct OptimizedParquetMetadataHeader {
    pub cache_key: String,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_coordinate_space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_transform: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub building_transform: Option<Vec<f64>>,
    pub optimization_stats: OptimizedStats,
    /// Vertex multiplier for dequantization (10,000 = 0.1mm precision)
    pub vertex_multiplier: f32,
}

/// POST /api/v1/parse/parquet/optimized - Full parse with ara3d BOS-optimized Parquet format.
///
/// Returns highly optimized binary Parquet data with:
/// - Integer quantized vertices (0.1mm precision)
/// - Mesh deduplication (instancing)
/// - Byte colors instead of floats
/// - Optional normals
///
/// Query params:
/// - `normals=true` - Include normals (default: false, compute on client)
///
/// Typical compression: 3-5x smaller than basic Parquet, 50-75x smaller than JSON.
pub async fn parse_parquet_optimized(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    // Extract file from multipart
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let cache_key = format!(
        "{}-{}",
        DiskCache::generate_key(&data),
        query.opening_filter.cache_key_suffix()
    );

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Processing with optimized Parquet output (ara3d BOS format)"
    );

    // Parse content
    let content = String::from_utf8(data)?;
    let opening_filter = query.opening_filter;

    // Process on blocking thread pool (CPU-intensive)
    let result =
        tokio::task::spawn_blocking(move || process_geometry_filtered(&content, opening_filter))
            .await?;

    // Serialize to optimized Parquet (with deduplication, quantization, etc.)
    // Don't include normals by default - client can compute them
    let (parquet_data, opt_stats) =
        serialize_to_parquet_optimized_with_stats(&result.meshes, false)?;

    tracing::info!(
        input_meshes = opt_stats.input_meshes,
        unique_meshes = opt_stats.unique_meshes,
        unique_materials = opt_stats.unique_materials,
        mesh_reuse_ratio = opt_stats.mesh_reuse_ratio,
        payload_size = parquet_data.len(),
        "Optimized Parquet serialization complete"
    );

    // Create metadata header
    let metadata_header = OptimizedParquetMetadataHeader {
        cache_key,
        metadata: result.metadata,
        stats: result.stats,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        optimization_stats: opt_stats,
        vertex_multiplier: VERTEX_MULTIPLIER,
    };

    let metadata_json = serde_json::to_string(&metadata_header)?;

    // Build response with binary body and metadata header
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "application/x-parquet-geometry-optimized",
        )
        .header("X-IFC-Metadata", metadata_json)
        .header(header::CONTENT_LENGTH, parquet_data.len())
        .body(Body::from(parquet_data))
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(response)
}

/// GET /api/v1/parse/data-model/:cache_key
///
/// Fetch the data model for a previously parsed file.
/// Returns the data model Parquet data if available (may still be processing).
///
/// Response:
/// - 200: Data model Parquet binary
/// - 202: Data model still processing (client should retry)
/// - 404: Cache key not found
pub async fn get_data_model(
    State(state): State<AppState>,
    axum::extract::Path(cache_key): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let data_model_cache_key = format!("{}-datamodel-v2", cache_key);

    match state.cache.get_bytes(&data_model_cache_key).await? {
        Some(data_model_parquet) => {
            tracing::info!(
                cache_key = %cache_key,
                size = data_model_parquet.len(),
                "Data model cache HIT"
            );

            let response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/x-parquet-datamodel")
                .header(header::CONTENT_LENGTH, data_model_parquet.len())
                .body(Body::from(data_model_parquet))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        None => {
            tracing::debug!(cache_key = %cache_key, "Data model not yet available");

            // Return 202 Accepted to indicate processing
            let response = Response::builder()
                .status(StatusCode::ACCEPTED)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"status":"processing","message":"Data model is still being processed. Retry in a moment."}"#))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
    }
}

/// GET /api/v1/cache/check/:hash
///
/// Check if a file hash is already cached.
/// Allows client to skip upload if file is already processed.
///
/// The optional `opening_filter` query parameter must match the value used when
/// the file was uploaded — different filter modes produce distinct cache entries.
///
/// Response:
/// - 200: File is cached (geometry available)
/// - 404: File not cached (needs upload)
pub async fn check_cache(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let parquet_cache_key = parquet_cache_key(&hash, query.opening_filter);

    match state.cache.get_bytes(&parquet_cache_key).await? {
        Some(_) => {
            tracing::debug!(hash = %hash, cache_key = %parquet_cache_key, "Cache check HIT");
            let response = Response::builder()
                .status(StatusCode::OK)
                .body(Body::empty())
                .map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(response)
        }
        None => {
            tracing::debug!(hash = %hash, cache_key = %parquet_cache_key, "Cache check MISS");
            let response = Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(response)
        }
    }
}

/// GET /api/v1/cache/geometry/:hash
///
/// Fetch cached Parquet geometry directly without uploading the file.
/// Used when client-side hash check confirms file is already cached.
///
/// The optional `opening_filter` query parameter must match the value used when
/// the file was uploaded — different filter modes produce distinct cache entries.
///
/// Response:
/// - 200: Cached Parquet geometry with metadata header
/// - 404: Cache entry not found
pub async fn get_cached_geometry(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let parquet_cache_key = parquet_cache_key(&hash, query.opening_filter);
    let metadata_cache_key = parquet_metadata_cache_key(&hash, query.opening_filter);

    match (
        state.cache.get_bytes(&parquet_cache_key).await?,
        state.cache.get_bytes(&metadata_cache_key).await?,
    ) {
        (Some(parquet), Some(metadata)) => {
            tracing::info!(
                hash = %hash,
                parquet_size = parquet.len(),
                "Returning cached geometry (no upload needed)"
            );

            let response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/x-parquet-geometry")
                .header("X-IFC-Metadata", String::from_utf8(metadata)?)
                .header(header::CONTENT_LENGTH, parquet.len())
                .body(Body::from(parquet))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        _ => {
            tracing::debug!(hash = %hash, "Cached geometry not found");
            Err(ApiError::NotFound(format!(
                "Cache entry not found for hash: {}",
                hash
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for #587: the reader (`check_cache`) used to look up
    /// `{hash}-parquet-v2`, while the writer (`parse_parquet`) stored
    /// `{hash}-{opening_filter}-parquet-v2`, so the check always returned 404.
    /// The shared helper must produce the same key the writer stores under.
    #[test]
    fn parquet_cache_key_matches_writer_format() {
        let hash = "0ab20f4e4014";

        // The writer composes `cache_key = format!("{hash}-{suffix}")` and then
        // `format!("{cache_key}-parquet-v2")`. The helper must produce the same string.
        for mode in [
            OpeningFilterMode::Default,
            OpeningFilterMode::IgnoreAll,
            OpeningFilterMode::IgnoreOpaque,
        ] {
            let writer_cache_key = format!("{}-{}", hash, mode.cache_key_suffix());
            let writer_parquet_key = format!("{}-parquet-v2", writer_cache_key);
            let writer_metadata_key = format!("{}-parquet-metadata-v2", writer_cache_key);

            assert_eq!(parquet_cache_key(hash, mode), writer_parquet_key);
            assert_eq!(parquet_metadata_cache_key(hash, mode), writer_metadata_key);
        }
    }

    #[test]
    fn parquet_cache_key_default_filter_uses_default_suffix() {
        let key = parquet_cache_key("abc", OpeningFilterMode::Default);
        assert_eq!(key, "abc-default-parquet-v2");
    }
}
