// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JSON / SSE-JSON parse endpoints.

use super::cache_keys::{cache_symbolic_data, request_cache_key};
use super::{extract_file, ParseQuery};
use crate::error::ApiError;
use crate::services::streaming::detect_schema_version;
use crate::services::process_streaming;
use crate::types::{MetadataResponse, ParseResponse, StreamEvent};
use crate::AppState;
use axum::{
    extract::{Multipart, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::StreamExt;
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::process_geometry_filtered_with_quality;
use std::convert::Infallible;

/// POST /api/v1/parse - Full synchronous parse.
pub async fn parse_full(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Json<ParseResponse>, ApiError> {
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

    // Check cache first
    if let Some(mut cached) = state.cache.get::<ParseResponse>(&cache_key).await? {
        tracing::info!(cache_key = %cache_key, "Cache HIT");
        cached.stats.from_cache = true;
        return Ok(Json(cached));
    }

    tracing::info!(cache_key = %cache_key, size = data.len(), "Cache MISS - processing");

    // Parse content
    let content = data;
    let opening_filter = query.opening_filter;

    // Process on blocking thread pool (CPU-intensive). Bundle the 3D
    // geometry with the 2D symbolic-data extraction (issue #843) so
    // callers can render IfcGrid axes and IfcAnnotation polylines from
    // the same response without re-uploading the file.
    // The guard moves INTO the blocking task and comes back with the result:
    // if the TimeoutLayer (or a disconnect) cancels this handler future, the
    // detached blocking work keeps running - and keeps its admission slot -
    // until it actually exits, so a replacement cannot be admitted on top.
    let ((result, symbolic_data), _admission) = tokio::task::spawn_blocking(move || {
        let result =
            process_geometry_filtered_with_quality(&content, opening_filter, tessellation_quality);
        let symbolic = ifc_lite_processing::extract_symbolic_data(&content);
        ((result, symbolic), admission_guard)
    })
    .await?;

    let response = ParseResponse {
        cache_key: cache_key.clone(),
        meshes: result.meshes,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        metadata: result.metadata,
        stats: result.stats,
        symbolic_data,
    };

    // Cache result (background). Also mirror the symbolic stream into the
    // dedicated `{cache_key}-symbolic-v1` entry so it's reachable through
    // `GET /api/v1/parse/symbolic/{cache_key}` regardless of which endpoint
    // first processed the file (issue #900).
    let cache = state.cache.clone();
    let response_clone = response.clone();
    tokio::spawn(async move {
        cache_symbolic_data(&cache, &cache_key, &response_clone.symbolic_data).await;
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
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let tessellation_quality = query.resolved_tessellation_quality()?;

    // Extract file
    // Admission gate (bounded concurrency + byte budget): acquired BEFORE the
    // upload is buffered, reserving the max upload size since multipart rarely
    // declares a length up front. Held for the request's whole lifetime so a
    // disconnected-but-still-running job keeps its memory slot.
    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    let content = data;
    let initial_batch_size = state.config.initial_batch_size;
    let max_batch_size = state.config.max_batch_size;

    // Create streaming response with dynamic batch sizing
    let stream = process_streaming(
        content,
        initial_batch_size,
        max_batch_size,
        query.opening_filter,
        tessellation_quality,
        Some(admission_guard),
    )
    .map(|event: StreamEvent| {
            let json = serde_json::to_string(&event).unwrap_or_else(|e| {
                serde_json::to_string(&StreamEvent::Error {
                    message: e.to_string(),
                })
                .unwrap()
            });
            Ok::<_, Infallible>(Event::default().data(json))
        });

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// POST /api/v1/parse/metadata - Quick metadata only (no geometry).
pub async fn parse_metadata(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<MetadataResponse>, ApiError> {
    // Extract file
    // Admission gate (bounded concurrency + byte budget): acquired BEFORE the
    // upload is buffered, reserving the max upload size since multipart rarely
    // declares a length up front. Held for the request's whole lifetime so a
    // disconnected-but-still-running job keeps its memory slot.
    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    let file_size = data.len();
    let content = data;

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

        let schema_version = detect_schema_version(&content);

        (
            MetadataResponse {
                entity_count,
                geometry_count,
                schema_version: schema_version.to_string(),
                file_size,
            },
            admission_guard,
        )
    })
    .await?;
    let (result, _admission) = result;

    Ok(Json(result))
}
