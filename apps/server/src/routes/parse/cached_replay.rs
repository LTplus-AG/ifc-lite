// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cached-replay fast path for the SSE Parquet streaming endpoint: when a
//! request's geometry + metadata are already cached, replay them as a
//! three-event stream (Start / one Batch / Complete) without re-parsing.

use super::cache_keys::{
    has_cached_symbolic, has_current_data_model, load_cached_symbolic,
    parquet_optimized_cache_key, parquet_optimized_metadata_cache_key,
};
use super::parquet::ParquetMetadataHeader;
use super::parquet_stream::ParquetStreamEvent;
use crate::error::ApiError;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::convert::Infallible;

/// Return the geometry slice from a cached combined-Parquet blob, framed as
/// `[geometry_len: u32-LE][geometry_data][data_model_len: u32]...`. Returns
/// `None` (rather than panicking) when the blob is too short to hold the length
/// header or declares a geometry length that runs past the buffer — the caller
/// treats that as a cache miss and re-parses.
pub(super) fn cached_geometry_slice(cached: &[u8]) -> Option<&[u8]> {
    let header = cached.get(0..4)?;
    let geometry_len = u32::from_le_bytes(header.try_into().ok()?) as usize;
    let end = 4usize.checked_add(geometry_len)?;
    cached.get(4..end)
}

/// Try to serve a `parse_parquet_stream` request from the cache. Returns
/// `Ok(Some(response))` on a usable cache hit (the caller drops its admission
/// guard and returns the response as-is), `Ok(None)` on a miss or a
/// short/corrupt cached blob (the caller falls through to the live parse,
/// which overwrites the bad entry).
pub(super) async fn try_cached_replay(
    state: &AppState,
    cache_key: &str,
) -> Result<Option<axum::response::Response>, ApiError> {
    let parquet_cache_key = format!("{}-parquet-v5", cache_key);
    let metadata_cache_key = format!("{}-parquet-metadata-v4", cache_key);

    let (Some(cached_parquet), Some(cached_metadata_json)) = (
        state.cache.get_bytes(&parquet_cache_key).await?,
        state.cache.get_bytes(&metadata_cache_key).await?,
    ) else {
        return Ok(None);
    };

    // Replaying skips the parse, and the parse is what writes the data model.
    // A geometry entry that outlived a data-model version bump must therefore
    // re-parse rather than replay (issue #3869).
    if !has_current_data_model(&state.cache, cache_key).await {
        tracing::info!(
            cache_key = %cache_key,
            "Geometry cached but the data model predates the current payload; re-parsing"
        );
        return Ok(None);
    }

    tracing::info!(
        cache_key = %cache_key,
        parquet_size = cached_parquet.len(),
        "Streaming cache HIT - returning cached data as fast stream"
    );

    // Parse cached metadata
    let metadata_header: ParquetMetadataHeader = serde_json::from_slice(&cached_metadata_json)
        .map_err(|e| ApiError::Internal(format!("Failed to parse cached metadata: {}", e)))?;

    // Load the cached symbolic stream so the Complete event reaches parity
    // even on the cache fast-path (issue #900).
    let symbolic_data = load_cached_symbolic(&state.cache, cache_key).await;

    // Extract + base64-encode the geometry blob from the cached buffer.
    // The blob is framed `[geometry_len: u32-LE][geometry_data]...`. Slice
    // WITHOUT `.unwrap()` panicking on a short/corrupt cached blob, and run
    // the copy/encode off the async worker via `block_in_place` (matching
    // the live path in `parse_parquet_stream`) so a large replay doesn't
    // stall other polls. (Guarded by runtime flavor: `block_in_place` panics
    // on current_thread, which the `#[tokio::test]` harness uses.)
    let encode_geometry = || -> Option<String> {
        let geometry = cached_geometry_slice(&cached_parquet)?;
        Some(STANDARD.encode(geometry))
    };
    let base64_data = if tokio::runtime::Handle::current().runtime_flavor()
        == tokio::runtime::RuntimeFlavor::MultiThread
    {
        tokio::task::block_in_place(encode_geometry)
    } else {
        encode_geometry()
    };

    let Some(base64_data) = base64_data else {
        // Short/corrupt cached blob: don't panic, don't serve garbage.
        // Fall through to the normal parse path (treat as a cache miss);
        // the re-parse overwrites the bad cache entry.
        tracing::warn!(
            cache_key = %cache_key,
            parquet_size = cached_parquet.len(),
            "Cached parquet blob is short/corrupt; ignoring cache and re-parsing"
        );
        return Ok(None);
    };

    // Create fast stream with cached data
    let cache_key_for_stream = cache_key.to_string();
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
                data: base64_data,
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
                symbolic_data,
            })
            .unwrap(),
        )),
    ]));

    Ok(Some(
        Sse::new(fast_stream)
            .keep_alive(KeepAlive::default())
            .into_response(),
    ))
}

/// Try to serve a `parse_parquet_optimized` request from the cache (issue
/// #3889). Returns `Ok(Some(response))` on a usable hit (the caller returns it
/// as-is and never parses), `Ok(None)` on anything else, which falls through to
/// the live parse and rewrites the entries.
///
/// The stored metadata is the response header VERBATIM, so nothing here has to
/// deserialize `OptimizedParquetMetadataHeader` -- a replay reports the same
/// `optimization_stats` and `cache_key` the live parse did. A header that is
/// not valid UTF-8 (a corrupt entry) is a miss, not a 500.
///
/// The symbolic gate is not optional: the optimized parse also writes the
/// symbolic sidecar, and replaying past a missing one leaves the client's
/// `GET /api/v1/parse/symbolic/{cache_key}` polling a key nobody writes.
pub(super) async fn try_cached_optimized_parquet(
    state: &AppState,
    cache_key: &str,
) -> Result<Option<axum::response::Response>, ApiError> {
    let (Some(cached_body), Some(cached_metadata_json)) = (
        state
            .cache
            .get_bytes(&parquet_optimized_cache_key(cache_key))
            .await?,
        state
            .cache
            .get_bytes(&parquet_optimized_metadata_cache_key(cache_key))
            .await?,
    ) else {
        return Ok(None);
    };

    if !has_cached_symbolic(&state.cache, cache_key).await {
        tracing::info!(
            cache_key = %cache_key,
            "Optimized Parquet cached but the symbolic sidecar is missing; re-parsing"
        );
        return Ok(None);
    }

    let Ok(metadata_json) = String::from_utf8(cached_metadata_json) else {
        tracing::warn!(
            cache_key = %cache_key,
            "Cached optimized metadata is not valid UTF-8; ignoring cache and re-parsing"
        );
        return Ok(None);
    };

    tracing::info!(
        cache_key = %cache_key,
        payload_size = cached_body.len(),
        "Optimized Parquet cache HIT - returning cached response"
    );

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "application/x-parquet-geometry-optimized",
        )
        .header("X-IFC-Metadata", metadata_json)
        .header(header::CONTENT_LENGTH, cached_body.len())
        .body(Body::from(cached_body))
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Some(response))
}
