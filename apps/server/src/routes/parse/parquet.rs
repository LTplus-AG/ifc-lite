// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Binary Parquet parse endpoints.

use super::cache_keys::{cache_symbolic_data, request_cache_key};
use super::{extract_file, ParseQuery};
use crate::error::ApiError;
use crate::services::{
    extract_data_model, serialize_data_model_to_parquet, serialize_to_parquet,
    serialize_to_parquet_optimized_with_stats, OptimizedStats, VERTEX_MULTIPLIER,
};
use crate::types::{ModelMetadata, ProcessingStats};
use crate::AppState;
use axum::{
    body::Body,
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::Response,
};
use ifc_lite_processing::{extract_symbolic_data, process_geometry_filtered_with_quality};
use serde::{Deserialize, Serialize};

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
    // Admission gate (bounded concurrency + byte budget): acquired BEFORE the
    // upload is buffered, reserving the max upload size since multipart rarely
    // declares a length up front. Held for the request's whole lifetime so a
    // disconnected-but-still-running job keeps its memory slot.
    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let tessellation_quality = query.resolved_tessellation_quality()?;
    let cache_key = request_cache_key(&data, &query, tessellation_quality);

    // Check cache first (before any processing)
    let parquet_cache_key = format!("{}-parquet-v4", cache_key);
    let metadata_cache_key = format!("{}-parquet-metadata-v4", cache_key);

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
            .header(
                "X-IFC-Metadata",
                String::from_utf8(cached_metadata_json)
                    .map_err(|error| ApiError::Internal(error.to_string()))?,
            )
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
    let content = data;

    // Process geometry and data model extraction + serialization ALL in parallel
    // rayon::join works correctly here because rayon has its own thread pool
    // that's independent of tokio's blocking thread pool
    let serialize_start = tokio::time::Instant::now();
    let opening_filter = query.opening_filter;
    // Guard rides the blocking task (see parse_full): a cancelled handler
    // future must not release the admission slot while the work runs on.
    let (
        (
            (geometry_result, geometry_parquet),
            (data_model_stats, data_model_parquet),
            symbolic_data,
        ),
        _admission,
    ) = tokio::task::spawn_blocking(move || {
            // First: extract geometry, data model, and the 2D symbol stream
            // (IfcAnnotation + IfcGrid) all in parallel. Symbolic extraction is
            // added here for endpoint parity (issue #900).
            let ((geometry_result, data_model), symbolic_data) = rayon::join(
                || {
                    rayon::join(
                        || process_geometry_filtered_with_quality(&content, opening_filter, tessellation_quality),
                        || extract_data_model(&content),
                    )
                },
                || extract_symbolic_data(&content),
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

            (
                (
                    (geometry_result, geo_parquet),
                    (dm_stats, dm_parquet),
                    symbolic_data,
                ),
                admission_guard,
            )
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
    let data_model_cache_key = format!("{}-datamodel-v3", cache_key);
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

    // Cache the symbolic stream immediately so it's ready when the client
    // fetches `GET /api/v1/parse/symbolic/{cache_key}` (issue #900).
    cache_symbolic_data(&state.cache, &cache_key, &symbolic_data).await;

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

    // Cache the results for future requests. `Bytes` makes the cache task's
    // copy an O(1) refcount bump instead of duplicating the whole payload.
    let combined_parquet = bytes::Bytes::from(combined_parquet);
    let parquet_cache_key = format!("{}-parquet-v4", cache_key_clone);
    let metadata_cache_key = format!("{}-parquet-metadata-v4", cache_key_clone);
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
    // Admission gate (bounded concurrency + byte budget): acquired BEFORE the
    // upload is buffered, reserving the max upload size since multipart rarely
    // declares a length up front. Held for the request's whole lifetime so a
    // disconnected-but-still-running job keeps its memory slot.
    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let tessellation_quality = query.resolved_tessellation_quality()?;
    let cache_key = request_cache_key(&data, &query, tessellation_quality);

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Processing with optimized Parquet output (ara3d BOS format)"
    );

    // Parse content
    let content = data;
    let opening_filter = query.opening_filter;

    // Process on blocking thread pool (CPU-intensive). Extract the 2D symbol
    // stream (IfcAnnotation + IfcGrid) alongside geometry for endpoint parity
    // (issue #900) — it's cached and served via the symbolic fetch endpoint.
    // Guard rides the blocking task (see parse_full).
    let ((result, symbolic_data), _admission) = tokio::task::spawn_blocking(move || {
        (
            rayon::join(
                || process_geometry_filtered_with_quality(&content, opening_filter, tessellation_quality),
                || extract_symbolic_data(&content),
            ),
            admission_guard,
        )
    })
    .await?;

    // Cache the symbolic stream so the client can fetch it via
    // `GET /api/v1/parse/symbolic/{cache_key}`.
    cache_symbolic_data(&state.cache, &cache_key, &symbolic_data).await;

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
