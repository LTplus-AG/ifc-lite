// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `POST /api/v1/parse/parquet/optimized`: the ara3d BOS-optimized Parquet
//! parse endpoint, split out of `parquet.rs` when it gained a cache of its own
//! (issue #3889) so neither module crosses the 400-line ratchet.

use super::cache_keys::{
    cache_symbolic_data, has_cached_symbolic, parquet_optimized_cache_key,
    parquet_optimized_metadata_cache_key, request_cache_key,
};
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

/// The optimized route's wire response, built in ONE place.
///
/// The live parse and the cache replay must be indistinguishable to a client,
/// and two hand-copied builders are indistinguishable only for as long as
/// nobody edits one of them.
fn optimized_parquet_response(
    metadata_json: String,
    body: bytes::Bytes,
) -> Result<Response, ApiError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "application/x-parquet-geometry-optimized",
        )
        .header("X-IFC-Metadata", metadata_json)
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .map_err(|e| ApiError::Internal(e.to_string()))
}

/// Try to serve this request from the cache (issue #3889). `Ok(Some(_))` is a
/// usable hit the caller returns as-is without parsing; anything else falls
/// through to the live parse, which rewrites the entries.
///
/// Ordered cheapest-gate-first: the body is the only large read, so it comes
/// last, once the hit is otherwise known good.
///
/// The stored metadata is the response header VERBATIM, so nothing here
/// deserializes `OptimizedParquetMetadataHeader` and a replay reports the same
/// `optimization_stats` the live parse did. A header that is not valid UTF-8
/// (a corrupt entry) is a miss, not a 500.
///
/// The symbolic gate is not optional: this route's parse also writes the
/// symbolic sidecar, so replaying past a missing one leaves the client's
/// `GET /api/v1/parse/symbolic/{cache_key}` polling a key nobody writes.
async fn try_cached_optimized_parquet(
    state: &AppState,
    cache_key: &str,
) -> Result<Option<Response>, ApiError> {
    if !has_cached_symbolic(&state.cache, cache_key).await {
        return Ok(None);
    }

    let Some(cached_metadata_json) = state
        .cache
        .get_bytes(&parquet_optimized_metadata_cache_key(cache_key))
        .await?
    else {
        return Ok(None);
    };

    let Ok(metadata_json) = String::from_utf8(cached_metadata_json) else {
        tracing::warn!(
            cache_key = %cache_key,
            "Cached optimized metadata is not valid UTF-8; ignoring cache and re-parsing"
        );
        return Ok(None);
    };

    let Some(cached_body) = state
        .cache
        .get_bytes(&parquet_optimized_cache_key(cache_key))
        .await?
    else {
        return Ok(None);
    };

    tracing::info!(
        cache_key = %cache_key,
        payload_size = cached_body.len(),
        "Optimized Parquet cache HIT - returning cached response"
    );

    optimized_parquet_response(metadata_json, cached_body.into()).map(Some)
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
    // the flat route (issue #3889): a background write races the client's very
    // next request, which is the request the cache exists to serve, and this
    // payload is the small one so the write is cheap. Metadata is written only
    // after the body lands, so it can never sit under a key with no body behind
    // it. A write failure is logged and the response still goes out: the parse
    // succeeded, only the replay is lost.
    if let Err(e) = cache_optimized_response(&state, &cache_key, &parquet_data, &metadata_json).await
    {
        tracing::error!(error = %e, cache_key = %cache_key, "Failed to cache optimized Parquet response");
    } else {
        tracing::info!(
            cache_key = %cache_key,
            payload_size = parquet_data.len(),
            "Cached optimized Parquet response"
        );
    }

    optimized_parquet_response(metadata_json, parquet_data)
}

/// Write the optimized body and then its metadata, stopping at the first
/// failure so metadata never outlives a body that was never stored.
async fn cache_optimized_response(
    state: &AppState,
    cache_key: &str,
    body: &[u8],
    metadata_json: &str,
) -> Result<(), ApiError> {
    state
        .cache
        .set_bytes(&parquet_optimized_cache_key(cache_key), body)
        .await?;
    state
        .cache
        .set_bytes(
            &parquet_optimized_metadata_cache_key(cache_key),
            metadata_json.as_bytes(),
        )
        .await
}
