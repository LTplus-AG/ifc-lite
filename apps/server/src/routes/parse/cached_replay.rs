// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cached-replay fast path for the SSE Parquet streaming endpoint: when a
//! request's geometry + metadata are already cached, replay them without
//! re-parsing, in the same Start / (Batch + Progress)* / Complete shape a
//! live parse streams (issue #3895). The geometry is split back into its
//! original stream batches via `parquet_replay_batches::split_into_batches`
//! (recovered from the cached blob's Parquet row-group boundaries); a blob
//! that doesn't decode that way falls back to one oversized batch, same as
//! before.

use super::cache_keys::{has_current_data_model, load_cached_symbolic};
use super::parquet::ParquetMetadataHeader;
use super::parquet_stream::ParquetStreamEvent;
use crate::error::ApiError;
use crate::services::parquet_replay_batches::split_into_batches;
use crate::AppState;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
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

    // Extract the geometry blob (framed `[geometry_len: u32-LE][geometry_data]
    // ...`, sliced WITHOUT `.unwrap()` panicking on a short/corrupt cached
    // blob) and split it back into its original stream batches, each
    // base64-encoded; or fall back to one whole-geometry batch when the blob
    // doesn't decode into row-group-aligned Parquet sections. All of this
    // runs off the async worker via `block_in_place` (matching the live path
    // in `parse_parquet_stream`) so a large replay doesn't stall other
    // polls. (Guarded by runtime flavor: `block_in_place` panics on
    // current_thread, which the `#[tokio::test]` harness uses.)
    let total_meshes = metadata_header.stats.total_meshes;
    let build_batches = || -> Option<Vec<(String, usize)>> {
        let geometry = cached_geometry_slice(&cached_parquet)?;
        match split_into_batches(geometry) {
            Some(batches) => Some(
                batches
                    .into_iter()
                    .map(|b| (STANDARD.encode(&b.data), b.mesh_count))
                    .collect(),
            ),
            None => Some(vec![(STANDARD.encode(geometry), total_meshes)]),
        }
    };
    let batches = if tokio::runtime::Handle::current().runtime_flavor()
        == tokio::runtime::RuntimeFlavor::MultiThread
    {
        tokio::task::block_in_place(build_batches)
    } else {
        build_batches()
    };

    let Some(batches) = batches else {
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

    // Same Start / (Batch, Progress)* / Complete shape the live path streams
    // (`parquet_stream.rs`'s per-batch Progress callback), so a cache hit is
    // progressive too (issue #3895).
    let cache_key_for_stream = cache_key.to_string();
    let mut events: Vec<Result<Event, Infallible>> = Vec::with_capacity(batches.len() * 2 + 2);
    events.push(Ok(Event::default().data(
        serde_json::to_string(&ParquetStreamEvent::Start {
            total_estimate: total_meshes,
            cache_key: cache_key_for_stream,
        })
        .unwrap(),
    )));
    events.push(Ok(Event::default().data(
        serde_json::to_string(&ParquetStreamEvent::Progress {
            processed: 0,
            total: total_meshes,
        })
        .unwrap(),
    )));

    let mut processed = 0usize;
    for (batch_number, (data, mesh_count)) in batches.into_iter().enumerate() {
        processed += mesh_count;
        events.push(Ok(Event::default().data(
            serde_json::to_string(&ParquetStreamEvent::Batch {
                data,
                mesh_count,
                batch_number: batch_number + 1,
            })
            .unwrap(),
        )));
        events.push(Ok(Event::default().data(
            serde_json::to_string(&ParquetStreamEvent::Progress {
                processed,
                total: total_meshes,
            })
            .unwrap(),
        )));
    }

    events.push(Ok(Event::default().data(
        serde_json::to_string(&ParquetStreamEvent::Complete {
            stats: metadata_header.stats,
            metadata: metadata_header.metadata,
            symbolic_data,
        })
        .unwrap(),
    )));

    let fast_stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>,
    > = Box::pin(futures::stream::iter(events));

    Ok(Some(
        Sse::new(fast_stream)
            .keep_alive(KeepAlive::default())
            .into_response(),
    ))
}
