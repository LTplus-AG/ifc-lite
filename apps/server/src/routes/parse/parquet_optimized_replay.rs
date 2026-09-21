// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache-replay plumbing for `POST /api/v1/parse/parquet/optimized`, split out
//! of `parquet_optimized.rs` (issue #5128) so the route stays under the
//! module-size ratchet once it gains a `?sha256=` probe of its own — the same
//! reason the flat route's replay lives in `cached_replay.rs` rather than in
//! `parquet_stream.rs`. [`replay_optimized_by_client_hash`] IS that probe.
//!
//! Everything here is `pub(super)`: only `parquet_optimized.rs` and its
//! siblings under `routes::parse` need it.

use super::cache_keys::{
    cache_key_from_parts, data_model_cache_key, has_cached_symbolic, has_current_data_model,
    has_optimized_metadata, is_file_digest, not_a_file_digest, parquet_optimized_cache_key,
    parquet_optimized_metadata_cache_key,
};
use super::parquet::DataModelStats;
use super::ParseQuery;
use crate::error::ApiError;
use crate::services::OptimizedStats;
use crate::types::{ModelMetadata, ProcessingStats};
use crate::AppState;
use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use ifc_lite_processing::{MeshCoordinateSpace, TessellationQuality};
use serde::Serialize;

/// Response header containing metadata for optimized Parquet response.
#[derive(Debug, Clone, Serialize)]
pub(super) struct OptimizedParquetMetadataHeader {
    pub cache_key: String,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_coordinate_space: Option<MeshCoordinateSpace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_transform: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub building_transform: Option<Vec<f64>>,
    pub optimization_stats: OptimizedStats,
    /// Vertex multiplier for dequantization (10,000 = 0.1mm precision)
    pub vertex_multiplier: f32,
    /// Data model statistics (issue #5129: this route now produces the data
    /// model too, so its own header can report the same stats
    /// `ParquetMetadataHeader` does).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_model_stats: Option<DataModelStats>,
}

/// Read a cache entry, treating an unreadable one as absent.
///
/// A corrupt entry must look like a miss to every caller on the replay path,
/// or the route answers 500 forever for that file.
pub(super) async fn readable_entry(state: &AppState, key: &str) -> Option<Vec<u8>> {
    match state.cache.get_bytes(key).await {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::warn!(error = %e, cache_key = %key, "Unreadable cache entry; re-parsing");
            None
        }
    }
}

/// The optimized route's wire response, built in ONE place.
///
/// The live parse and the cache replay must be indistinguishable to a client,
/// and two hand-copied builders are indistinguishable only for as long as
/// nobody edits one of them.
pub(super) fn optimized_parquet_response(
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
/// `optimization_stats` the live parse did.
///
/// EVERY way an entry can be unusable is a miss, never an error: a read that
/// fails, and a header that is not valid UTF-8. cacache verifies content on
/// read, so a truncated or orphaned blob (interrupted write, partial GC) comes
/// back as an error -- and propagating it would 500 this file's every future
/// request, because the parse that would overwrite the bad entry is the thing
/// the error skips. A miss re-parses and rewrites it.
///
/// The symbolic gate is not optional: this route's parse also writes the
/// symbolic sidecar, so replaying past a missing one leaves the client's
/// `GET /api/v1/parse/symbolic/{cache_key}` polling a key nobody writes.
///
/// The data-model gate (#5129) is the same #3869 rule the flat route already
/// applies: this route now writes a data model beside the geometry, so a hit
/// warmed BEFORE that change (or one whose data-model entry has since been
/// bumped) must re-parse, or nothing ever writes a current one and
/// `get_data_model` polls a key nobody writes forever.
pub(super) async fn try_cached_optimized_parquet(
    state: &AppState,
    cache_key: &str,
) -> Result<Option<Response>, ApiError> {
    if !has_cached_symbolic(&state.cache, cache_key).await {
        return Ok(None);
    }

    if !has_current_data_model(&state.cache, cache_key).await {
        return Ok(None);
    }

    let Some(cached_metadata_json) =
        readable_entry(state, &parquet_optimized_metadata_cache_key(cache_key)).await
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

    let Some(cached_body) = readable_entry(state, &parquet_optimized_cache_key(cache_key)).await
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

/// Cache the data model produced alongside this route's geometry (#5129).
///
/// Log-and-continue like `parse_parquet`'s data-model write: a write failure
/// here must not fail the response, which already has a valid geometry
/// payload in hand. The caller writes this BEFORE the geometry body and
/// metadata, so a data model is never missing behind an entry the replay gate
/// above would otherwise treat as current.
pub(super) async fn cache_data_model(state: &AppState, cache_key: &str, bytes: &[u8]) {
    let key = data_model_cache_key(cache_key);
    if let Err(e) = state.cache.set_bytes(&key, bytes).await {
        tracing::error!(error = %e, cache_key = %key, "Failed to cache data model from optimized route");
    } else {
        tracing::info!(cache_key = %key, size = bytes.len(), "Data model cached from optimized route");
    }
}

/// Serve `POST /api/v1/parse/parquet/optimized` from a client-supplied file
/// hash, with no request body at all (issue #5128), the same contract the
/// flat route's `?sha256=` probe has (issue #3901):
/// [`cached_replay::replay_by_client_hash`].
///
/// The optimized key ignores `parquet_layout` -- unlike the flat route, this
/// route has only ever emitted one payload shape, so there is no second
/// namespace to select between.
///
/// The hash SELECTS; it never asserts. A miss answers `404` and runs no
/// parse, so a probe cannot become a way to make the server do work for a
/// body it never received.
///
/// A MISS costs no admission slot: the gates below are three small reads
/// (symbolic sidecar, optimized metadata, and the data model, #5129), cheaper
/// than queueing for a slot only to fail the actual lookup. Without the
/// data-model gate here, a probe for an entry warmed before #5129 (geometry
/// and symbolic present, no data model) would still take an admission slot,
/// only to be refused anyway by the same gate inside
/// `try_cached_optimized_parquet` -- charging a slot for a lookup already
/// known to fail. A HIT takes a slot around the cache read
/// (`try_cached_optimized_parquet` reads the whole body into memory), dropped
/// before the response goes out.
///
/// [`cached_replay::replay_by_client_hash`]: super::cached_replay::replay_by_client_hash
pub(super) async fn replay_optimized_by_client_hash(
    state: &AppState,
    query: &ParseQuery,
    quality: TessellationQuality,
    sha256: &str,
) -> Result<Response, ApiError> {
    if !is_file_digest(sha256) {
        return Err(not_a_file_digest(sha256));
    }
    let cache_key = cache_key_from_parts(sha256, query.opening_filter, quality);

    let hit = if has_optimized_metadata(&state.cache, &cache_key).await
        && has_cached_symbolic(&state.cache, &cache_key).await
        && has_current_data_model(&state.cache, &cache_key).await
    {
        let admission_guard = state
            .admission
            .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
            .await?;
        let hit = try_cached_optimized_parquet(state, &cache_key).await;
        drop(admission_guard);
        hit?
    } else {
        None
    };

    if let Some(response) = hit {
        tracing::info!(
            cache_key = %cache_key,
            "Optimized Parquet cache HIT by client-supplied hash - no upload"
        );
        return Ok(response);
    }

    tracing::debug!(
        cache_key = %cache_key,
        "Hash-only optimized-Parquet request has nothing cached; asking the client to upload"
    );
    Err(ApiError::NotFound(format!(
        "Nothing cached for sha256 {sha256} under this opening_filter / tessellation_quality. Resend the request with the multipart file body."
    )))
}

/// Write the optimized body and then its metadata, stopping at the first
/// failure so metadata never outlives a body that was never stored.
pub(super) async fn cache_optimized_response(
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
