// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JSON / SSE-JSON parse endpoints.

use super::cache_keys::json_response_cache_key;
use super::cache_read::resident_body;
use super::{
    admit_upload, begin_symbolic_fill, cache_symbolic_data_off_runtime, request_cache_key_off_runtime, ParseQuery,
};
use crate::admission::ResidentBytes;
use crate::error::ApiError;
use crate::services::axis::mesh_to_yup_in_place;
use crate::services::streaming::detect_schema_version;
use crate::services::process_streaming;
use crate::types::{finish_meshes, MetadataResponse, ParseResponse, SymbolicParseResponse, StreamEvent};
use ifc_lite_processing::style::ModelFinishes;
use crate::AppState;
use axum::{
    extract::{Multipart, Query, State},
    http::header,
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use futures::stream::StreamExt;
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::process_geometry_filtered_with_quality;
use std::convert::Infallible;

/// POST /api/v1/parse - Full synchronous parse.
pub async fn parse_full(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    // Extract file from multipart
    // Admission (bounded concurrency + byte budget) before the upload is
    // buffered; see `admit_upload`. Held for the
    // request's whole lifetime so a disconnected-but-still-running job keeps
    // its memory slot.
    let (admission_guard, data) = admit_upload(&state, &mut multipart).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let tessellation_quality = query.resolved_tessellation_quality()?;
    let (cache_key, mut admission_guard) =
        request_cache_key_off_runtime(&data, &query, tessellation_quality, admission_guard).await?;
    // The stored ParseResponse is versioned separately from the client-facing
    // cache_key so the Y-up switch (#1841) retires the old Z-up entries without
    // invalidating the parquet caches. See `json_response_cache_key`.
    let response_cache_key = json_response_cache_key(&cache_key);

    // Check cache first. The entry is the whole model as JSON, so a hit is
    // decoded and re-encoded on the blocking pool (#4696). The admission guard
    // rides that task, as it does the miss path's below. A stored response
    // that does not decode is a miss (#7676, SERVER-12): it used to answer
    // 500 on every request for the file, when the parse below rewrites it.
    if let Some(cached) = state.cache.read_usable(&response_cache_key).await? {
        tracing::info!(cache_key = %cache_key, "Cache HIT");
        let (decoded, admission) = tokio::task::spawn_blocking(move || {
            let decoded = serde_json::from_slice::<SymbolicParseResponse>(&cached).map(|mut cached| {
                cached.mark_from_cache();
                encode_response(&cached)
            });
            (decoded, admission_guard)
        })
        .await?;
        admission_guard = admission;
        match decoded {
            Ok(body) => return Ok(json_body(body?, admission_guard.into_resident())),
            Err(e) => {
                let why = format!("not a ParseResponse: {e}");
                state.cache.evict_unusable(&response_cache_key, why).await;
            }
        }
    }

    tracing::info!(cache_key = %cache_key, size = data.len(), "Cache MISS - processing");

    // Parse content
    let content = data;
    let opening_filter = query.opening_filter;
    let response_key = cache_key.clone();

    // Process on blocking thread pool (CPU-intensive). Bundle the 3D
    // geometry with the 2D symbolic-data extraction (issue #843) so
    // callers can render IfcGrid axes and IfcAnnotation polylines from
    // the same response without re-uploading the file. The Y-up swap and the
    // whole-model encode run in the same task, not on the async worker that
    // resumes this handler (#4696), and one encoded body serves both the
    // client and the cache.
    // The guard moves INTO the blocking task and comes back with the result:
    // if the TimeoutLayer (or a disconnect) cancels this handler future, the
    // detached blocking work keeps running - and keeps its admission slot -
    // until it actually exits, so a replacement cannot be admitted on top.
    let (body, symbolic_data, admission) = tokio::task::spawn_blocking(move || {
        let result =
            process_geometry_filtered_with_quality(&content, opening_filter, tessellation_quality);
        // In the frame the meshes above were baked in, not one this re-derives
        // for itself: the two travel in one response, so a site-local model's
        // symbols have to lose the same site translation and rotation its
        // meshes did (#4706).
        let symbolic = ifc_lite_processing::extract_symbolic_data_with_provenance_in_frame(
            &content,
            result.frame,
        );
        // #5984: each mesh's IFC-authored finish, joined before the bytes go.
        let mut meshes = finish_meshes(&mut ModelFinishes::from_content(&content), result.meshes);
        drop(content);

        // Emit the SAME Y-up wire frame as the parquet transports (issue #1841).
        // This route used to ship `result.meshes` verbatim — i.e. raw IFC Z-up —
        // while `/parse/parquet*` swapped to Y-up server-side, so a client that
        // (correctly) treats every transport alike rendered JSON-loaded models
        // rotated. The frame now comes from one place: services::axis.
        for mesh in &mut meshes {
            mesh_to_yup_in_place(mesh);
        }

        let response = SymbolicParseResponse::new(ParseResponse {
            cache_key: response_key,
            meshes: Vec::new(),
            mesh_coordinate_space: Some(result.mesh_coordinate_space),
            site_transform: result.site_transform,
            building_transform: result.building_transform,
            metadata: result.metadata,
            stats: result.stats,
            symbolic_data: Default::default(),
        }, symbolic)
        .with_meshes(meshes);
        let body = encode_response(&response)?;
        Ok::<_, ApiError>((body, response.symbolic_data, admission_guard))
    })
    .await??;

    // Cache result (background). Also mirror the symbolic stream into the
    // dedicated `{cache_key}-symbolic-v4` entry so it's reachable through
    // `GET /api/v1/parse/symbolic/{cache_key}` regardless of which endpoint
    // first processed the file (issue #900).
    let cache = state.cache.clone();
    let cached_body = body.clone();
    let symbolic_fill = begin_symbolic_fill(&state, &cache_key);
    tokio::spawn(async move {
        cache_symbolic_data_off_runtime(cache.clone(), symbolic_fill, cache_key, symbolic_data).await;
        if let Err(e) = cache.set_bytes(&response_cache_key, &cached_body).await {
            tracing::error!(error = %e, "Failed to cache result");
        }
    });

    Ok(json_body(body, admission.into_resident()))
}

/// Encode a `POST /api/v1/parse` body. It is the whole model, so call this
/// only on the blocking pool (#4696). The bytes are the ones `Json` would
/// write and `DiskCache::set` would store.
fn encode_response(response: &SymbolicParseResponse) -> Result<Bytes, ApiError> {
    let body = serde_json::to_vec(response)?;
    tracing::info!(cache_key = %response.cache_key, size = body.len(), "JSON parse response encoded");
    Ok(body.into())
}

/// An already-encoded JSON body, with the content type `Json` sets, keeping
/// the request's bytes charged until it is sent (#7676, SERVER-7).
fn json_body(body: Bytes, resident: ResidentBytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], resident_body(body, resident)).into_response()
}

/// POST /api/v1/parse/stream - Streaming SSE parse.
pub async fn parse_stream(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    let tessellation_quality = query.resolved_tessellation_quality()?;

    // Extract file
    // Admission (bounded concurrency + byte budget) before the upload is
    // buffered; see `admit_upload`. Held for the
    // request's whole lifetime so a disconnected-but-still-running job keeps
    // its memory slot.
    let (admission_guard, data) = admit_upload(&state, &mut multipart).await?;

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
        Some(std::sync::Arc::new(admission_guard)),
    )
    .map(|mut event: StreamEvent| {
            // Same Y-up wire frame as every other transport (issue #1841) —
            // `process_streaming` yields raw IFC Z-up meshes, and the parquet
            // stream route applies the swap inside its serializer, so the JSON
            // stream has to apply it here rather than in the shared producer.
            if let StreamEvent::Batch { meshes, .. } = &mut event {
                for mesh in meshes.iter_mut() {
                    mesh_to_yup_in_place(mesh);
                }
            }
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
    // Admission (bounded concurrency + byte budget) before the upload is
    // buffered; see `admit_upload`. Held for the
    // request's whole lifetime so a disconnected-but-still-running job keeps
    // its memory slot.
    let (admission_guard, data) = admit_upload(&state, &mut multipart).await?;

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

        // The walk above ends on `None`, which does not only mean "the file
        // ended": the scanner skips a record whose instance name does not fit
        // `u32` (#3395) and stops the whole scan at a record with no
        // terminator (#3695). Either way `entity_count` is computed over less
        // than the file declares, and a 200 carrying it reads exactly like a
        // complete answer. Report to the server's sink like every other
        // whole-file walk, AND carry both onto the response — a client cannot
        // read the server log (#3791).
        let oversized_id_count = scanner.skipped_oversized_ids();
        let malformed_record_found = scanner.malformed_record_start().is_some();
        ifc_lite_core::report_scan_diagnostics(oversized_id_count, malformed_record_found);

        let schema_version = detect_schema_version(&content);

        (
            MetadataResponse {
                entity_count,
                geometry_count,
                schema_version: schema_version.to_string(),
                file_size,
                oversized_id_count,
                malformed_record_found,
            },
            admission_guard,
        )
    })
    .await?;
    let (result, _admission) = result;

    Ok(Json(result))
}
