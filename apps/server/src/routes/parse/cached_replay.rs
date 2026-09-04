// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cached-replay fast path for the SSE Parquet streaming endpoint: when a
//! request's geometry + metadata are already cached, replay them without
//! re-parsing, in the same Start / (Batch + Progress)* / Complete shape a
//! live parse streams (issue #3895). The geometry is split back into its
//! original stream batches via `parquet_replay_batches::split_into_batches`
//! (recovered from the cached blob's Parquet row-group boundaries); a blob
//! with no recoverable boundary falls back to one oversized batch, same as
//! before.
//!
//! `progress` numbers come from the `stream_progress` sidecar the live parse
//! wrote, so a hit reports the same JOB counts a miss does (issue #3897).
//! Entries cached before that sidecar existed have no job counts to replay;
//! those fall back to counting emitted MESHES, which is the wrong unit but
//! still monotonic and still ends at its own stated total.

use super::cache_keys::{
    cache_key_from_parts, has_current_data_model, has_parquet_metadata, is_file_digest,
    load_cached_symbolic, parquet_geometry_key, parquet_metadata_key,
};
use super::ParseQuery;
use ifc_lite_processing::TessellationQuality;
use crate::services::ParquetLayout;
use super::parquet::ParquetMetadataHeader;
use super::stream_event::ParquetStreamEvent;
use super::stream_progress::load_stream_progress;
use crate::error::ApiError;
use crate::services::parquet_replay_batches::split_into_batches;
use crate::AppState;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::convert::Infallible;

/// Serve `POST /api/v1/parse/parquet-stream` from a client-supplied file hash,
/// with no request body at all (issue #3901).
///
/// The upload used to be unavoidable on a hit: the cache key is the SHA-256 of
/// the RECEIVED bytes, so `extract_file` had to finish before the cache could
/// be consulted, and on a 40 MB model over a real connection that upload was
/// the whole cost of the hit. A client that hashes locally can name the entry
/// instead.
///
/// The hash SELECTS; it never asserts. Everything the replay needs has to be on
/// disk under that key already, which is exactly what [`try_cached_replay`]
/// checks (geometry body, metadata header, a data model at the current payload
/// version, plus whatever it later adds). Delegating to it rather than
/// re-listing those entries here is what makes "a hash-only hit replays the
/// same events as an upload hit" true by construction instead of by two lists
/// agreeing. A miss answers `404`, the status
/// `GET /api/v1/cache/check/{hash}` already uses for "upload it", and the
/// client uploads.
///
/// A MISS costs no admission slot. The probe answers it from two small reads
/// (the metadata header and the data-model marker) before touching the gate,
/// because the common miss is a file the server has never seen and charging a
/// parse slot for a disk lookup would mean every cold-cache client wins
/// admission twice, probe then upload, and could be shed on the probe rather
/// than queueing for the upload that would have succeeded.
///
/// A HIT does take one, around the replay BUILD, dropped before the response is
/// returned. That is what the body-carrying hit path does, and for the same
/// reason: `try_cached_replay` reads the whole geometry blob into memory,
/// base64-encodes every batch, and materializes the full event vector before a
/// byte is sent, which is several times the model's geometry resident at once.
/// Leaving that window unbounded would make the cheapest request a client can
/// send the cheapest way to exhaust the server. Draining the finished stream
/// needs no slot.
pub(super) async fn replay_by_client_hash(
    state: &AppState,
    query: &ParseQuery,
    quality: TessellationQuality,
    sha256: &str,
) -> Result<axum::response::Response, ApiError> {
    if !is_file_digest(sha256) {
        return Err(ApiError::BadRequest(
            "sha256 must be a 64-character lowercase hex SHA-256 digest".to_string(),
        ));
    }
    let cache_key = cache_key_from_parts(sha256, query.opening_filter, quality);

    let replay = if has_parquet_metadata(&state.cache, &cache_key).await
        && has_current_data_model(&state.cache, &cache_key).await
    {
        let admission_guard = state
            .admission
            .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
            .await?;
        let replay = try_cached_replay(state, &cache_key, query.parquet_layout).await;
        drop(admission_guard);
        replay?
    } else {
        None
    };

    if let Some(response) = replay {
        tracing::info!(
            cache_key = %cache_key,
            "Streaming cache HIT by client-supplied hash - no upload"
        );
        return Ok(response);
    }
    tracing::debug!(
        cache_key = %cache_key,
        "Hash-only stream request has nothing cached; asking the client to upload"
    );
    Err(ApiError::NotFound(format!(
        "Nothing cached for sha256 {sha256} under this opening_filter / tessellation_quality / parquet_layout. Resend the request with the multipart file body."
    )))
}

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
    layout: ParquetLayout,
) -> Result<Option<axum::response::Response>, ApiError> {
    let parquet_cache_key = parquet_geometry_key(cache_key, layout);
    let metadata_cache_key = parquet_metadata_key(cache_key);

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

    // The job-unit progress the live parse reported for this file.
    let recorded_progress = load_stream_progress(&state.cache, cache_key).await;

    // Extract the geometry blob (framed `[geometry_len: u32-LE][geometry_data]
    // ...`, sliced WITHOUT `.unwrap()` panicking on a short/corrupt cached
    // blob) and split it back into its original stream batches, each
    // base64-encoded. Runs off the async worker via `block_in_place` (matching
    // the live path in `parse_parquet_stream`) so a large replay doesn't stall
    // other polls. (Guarded by runtime flavor: `block_in_place` panics on
    // current_thread, which the `#[tokio::test]` harness uses.)
    let total_meshes = metadata_header.stats.total_meshes;
    let build_batches = || -> Option<Vec<(String, usize)>> {
        let geometry = cached_geometry_slice(&cached_parquet)?;
        let Some(batches) = split_into_batches(geometry) else {
            // Not a multi-row-group blob: one batch's worth of geometry, a
            // pre-streaming cache entry, or a layout we can't align. Log it —
            // otherwise a replay that has silently stopped being progressive
            // is indistinguishable from one that never needed to be.
            tracing::debug!(
                geometry_bytes = geometry.len(),
                "Cached geometry has no recoverable batch boundaries; replaying as one batch"
            );
            return Some(vec![(STANDARD.encode(geometry), total_meshes)]);
        };
        Some(
            batches
                .into_iter()
                .map(|b| (STANDARD.encode(&b.data), b.mesh_count))
                .collect(),
        )
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
    //
    // The checkpoints only line up if there is one per batch. A sidecar from
    // a run whose batch count differs from what we recovered (a fallback to
    // one whole-geometry batch, say) describes a different segmentation, so
    // it is dropped rather than misapplied.
    let checkpoints = recorded_progress
        .filter(|p| p.after_batch.len() == batches.len())
        .map(|p| (p.total_jobs, p.after_batch));
    let (total, per_batch_processed) = match checkpoints {
        Some((total_jobs, after_batch)) => (total_jobs, Some(after_batch)),
        // No sidecar: pre-#3897 cache entry. Mesh units, as before.
        None => (total_meshes, None),
    };

    let sse = |event: &ParquetStreamEvent| -> Result<Event, Infallible> {
        Ok(Event::default().data(serde_json::to_string(event).unwrap()))
    };
    let mut events: Vec<Result<Event, Infallible>> = Vec::with_capacity(batches.len() * 2 + 3);
    events.push(sse(&ParquetStreamEvent::Start {
        total_estimate: total,
        cache_key: cache_key.to_string(),
    }));
    events.push(sse(&ParquetStreamEvent::Progress { processed: 0, total }));

    let mut processed = 0usize;
    for (batch_number, (data, mesh_count)) in batches.into_iter().enumerate() {
        processed = match &per_batch_processed {
            Some(checkpoints) => checkpoints[batch_number],
            None => processed + mesh_count,
        };
        events.push(sse(&ParquetStreamEvent::Batch {
            data,
            mesh_count,
            batch_number: batch_number + 1,
        }));
        events.push(sse(&ParquetStreamEvent::Progress { processed, total }));
    }

    events.push(sse(&ParquetStreamEvent::Complete {
        stats: metadata_header.stats,
        metadata: metadata_header.metadata,
        symbolic_data,
    }));

    let fast_stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>,
    > = Box::pin(futures::stream::iter(events));

    Ok(Some(
        Sse::new(fast_stream)
            .keep_alive(KeepAlive::default())
            .into_response(),
    ))
}
