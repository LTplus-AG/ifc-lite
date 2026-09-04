// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `POST /api/v1/parse/parquet/optimized`: the ara3d BOS-optimized Parquet
//! parse endpoint, split out of `parquet.rs` when it gained a cache of its own
//! (issue #3889) so neither module crosses the 400-line ratchet.

use super::cache_keys::{
    cache_symbolic_data, parquet_optimized_cache_key, parquet_optimized_metadata_cache_key,
    request_cache_key,
};
use super::cached_replay::try_cached_optimized_parquet;
use super::{extract_file, ParseQuery};
use crate::error::ApiError;
use crate::services::{
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
use serde::Serialize;

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

    // Cache first, before any processing (issue #3889). The optimized route is
    // the SMALL payload and the one a viewer opens repeatedly, so re-parsing it
    // on every request was the worst of both shapes.
    if let Some(response) = try_cached_optimized_parquet(&state, &cache_key).await? {
        return Ok(response);
    }

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Optimized Parquet cache MISS - processing file (ara3d BOS format)"
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
        cache_key: cache_key.clone(),
        metadata: result.metadata,
        stats: result.stats,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        optimization_stats: opt_stats,
        vertex_multiplier: VERTEX_MULTIPLIER,
    };

    let metadata_json = serde_json::to_string(&metadata_header)?;

    // Store body and metadata BEFORE responding, not in a background task like
    // the flat route (issue #3889). This payload is the small one -- that is the
    // whole point of the route -- so the write is cheap, and a background write
    // races the client's very next request, which is exactly the request the
    // cache exists to serve. A write failure is logged and the response still
    // goes out: the parse succeeded, only the replay is lost.
    if let Err(e) = state
        .cache
        .set_bytes(&parquet_optimized_cache_key(&cache_key), &parquet_data)
        .await
    {
        tracing::error!(error = %e, "Failed to cache optimized Parquet bytes");
    } else if let Err(e) = state
        .cache
        .set_bytes(
            &parquet_optimized_metadata_cache_key(&cache_key),
            metadata_json.as_bytes(),
        )
        .await
    {
        // Reached only when the body landed, so a failure here cannot leave
        // metadata sitting alone under a key with no body behind it.
        tracing::error!(error = %e, "Failed to cache optimized Parquet metadata");
    } else {
        tracing::info!(
            cache_key = %cache_key,
            payload_size = parquet_data.len(),
            "Cached optimized Parquet response"
        );
    }

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
