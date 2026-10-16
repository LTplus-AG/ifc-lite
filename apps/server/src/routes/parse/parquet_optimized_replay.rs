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
    parquet_optimized_metadata_cache_key, stored_size,
};
use super::cache_read::resident_body;
use crate::admission::{AdmissionGuard, ResidentBytes};
use super::parquet::DataModelStats;
use super::replay_header::mark_header_from_cache;
use super::ParseQuery;
use crate::error::ApiError;
use crate::services::{DataModelEntities, OptimizedStats};
use crate::types::{ModelMetadata, ProcessingStats};
use crate::AppState;
use axum::{
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

/// The optimized route's wire response, built in ONE place.
///
/// The live parse and the cache replay must be indistinguishable to a client,
/// and two hand-copied builders are indistinguishable only for as long as
/// nobody edits one of them.
///
/// The body keeps `resident` (the request's byte reservation) until it is
/// sent (#7676, SERVER-7).
pub(super) fn optimized_parquet_response(
    metadata_json: String,
    body: bytes::Bytes,
    resident: ResidentBytes,
) -> Result<Response, ApiError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "application/x-parquet-geometry-optimized",
        )
        .header("X-IFC-Metadata", metadata_json)
        .header(header::CONTENT_LENGTH, body.len())
        .body(resident_body(body, resident))
        .map_err(|e| ApiError::Internal(e.to_string()))
}

/// Read this request's replay from the cache (issue #3889): the stored
/// response header (already marked `from_cache`) and body. `Ok(Some(_))` is a
/// usable hit the caller answers as-is without parsing; `Ok(None)` falls
/// through to the live parse, which rewrites the entries. The caller holds
/// the admission the read is charged to, and hands it to the response.
///
/// Ordered cheapest-gate-first: the body is the only large read, so it comes
/// last, once the hit is otherwise known good.
///
/// The stored metadata is the response header VERBATIM, so nothing here
/// deserializes `OptimizedParquetMetadataHeader` and a replay reports the same
/// `optimization_stats` the live parse did.
///
/// EVERY way an entry can be unusable is a miss, never an error, by the one
/// policy every route reads through (`services::cache_entry`, #7676): a blob
/// that is gone or fails cacache's integrity check, and a header that is not
/// valid UTF-8. Propagating it would 500 this file's every future request,
/// because the parse that would overwrite the bad entry is the thing the
/// error skips.
///
/// The symbolic gate is not optional: this route's parse also writes the
/// symbolic sidecar, so replaying past a missing one leaves the client's
/// `GET /api/v1/parse/symbolic/{cache_key}` with a key nobody writes.
///
/// The data-model gate (#5129) is the same #3869 rule the flat route already
/// applies: this route now writes a data model beside the geometry, so a hit
/// warmed BEFORE that change (or one whose data-model entry has since been
/// bumped) must re-parse, or nothing ever writes a current one and
/// `get_data_model` polls a key nobody writes forever.
///
/// That gate asks about the entities VARIANT the request selected (#6034): a
/// body warmed by a default request has no rooted data model behind it, and
/// replaying it would leave a `?data_model_entities=rooted` client with a
/// data-model key nobody writes. A miss re-parses; the body and header it
/// rewrites are the same bytes, because the variant touches only the data
/// model.
///
/// `upload` is the upload route's admission, charged the header's and body's
/// stored size for the read (and put back to its upload's charge on a miss,
/// for the parse); the hash-only route passes `None` because it has already
/// admitted the body.
pub(super) async fn try_cached_optimized_parquet(
    state: &AppState,
    cache_key: &str,
    data_model_entities: DataModelEntities,
    upload: Option<&mut AdmissionGuard>,
) -> Result<Option<(String, bytes::Bytes)>, ApiError> {
    if !has_cached_symbolic(&state.cache, cache_key).await?
        || !has_current_data_model(&state.cache, cache_key, data_model_entities).await?
    {
        return Ok(None);
    }
    let Some(upload) = upload else {
        return read_optimized(state, cache_key).await;
    };
    let body = stored_size(&state.cache, &parquet_optimized_cache_key(cache_key)).await?;
    let header = stored_size(&state.cache, &parquet_optimized_metadata_cache_key(cache_key)).await?;
    if body == 0 || header == 0 {
        return Ok(None);
    }
    let held = upload.grow_to(body + header).await?;
    let hit = read_optimized(state, cache_key).await?;
    if hit.is_none() {
        upload.shrink_to(held);
    }
    Ok(hit)
}

/// The two entries' content, each read through the one cache-entry policy.
async fn read_optimized(state: &AppState, cache_key: &str) -> Result<Option<(String, bytes::Bytes)>, ApiError> {
    let Some(metadata_json) = state
        .cache
        .read_usable_utf8(&parquet_optimized_metadata_cache_key(cache_key))
        .await?
    else {
        return Ok(None);
    };
    let Some(cached_body) = state.cache.read_usable(&parquet_optimized_cache_key(cache_key)).await? else {
        return Ok(None);
    };

    tracing::info!(
        cache_key = %cache_key,
        payload_size = cached_body.len(),
        "Optimized Parquet cache HIT - returning cached response"
    );
    // Stored as the live parse wrote it, `from_cache: false` included (#5542).
    Ok(Some((mark_header_from_cache(metadata_json), cached_body.into())))
}

/// Cache the data model produced alongside this route's geometry (#5129).
///
/// Log-and-continue like `parse_parquet`'s data-model write: a write failure
/// here must not fail the response, which already has a valid geometry
/// payload in hand. The caller writes this BEFORE the geometry body and
/// metadata, so a data model is never missing behind an entry the replay gate
/// above would otherwise treat as current.
pub(super) async fn cache_data_model(
    state: &AppState,
    cache_key: &str,
    data_model_entities: DataModelEntities,
    bytes: &[u8],
) {
    let key = data_model_cache_key(cache_key, data_model_entities);
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
/// A MISS costs no admission: the gates below are index lookups that read
/// nothing (#7676, SERVER-6; the data-model gate used to read the whole data
/// model). A HIT is admitted for the stored header and body before either is
/// read, against the byte budget only, since it computes nothing; the
/// reservation rides the response body until the client has drained it
/// (SERVER-7), and is the entries' own size rather than `MAX_FILE_SIZE_MB`
/// (SERVER-24).
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

    let stored = if has_optimized_metadata(&state.cache, &cache_key).await?
        && has_cached_symbolic(&state.cache, &cache_key).await?
        && has_current_data_model(&state.cache, &cache_key, query.data_model_entities).await?
    {
        state.cache.lookup(&parquet_optimized_cache_key(&cache_key)).await?
    } else {
        None
    };
    if let Some(body) = stored {
        // The header is a few hundred bytes; a permit covers it.
        let resident = state.admission.acquire_resident(body.size()).await?;
        if let Some((metadata_json, body)) =
            try_cached_optimized_parquet(state, &cache_key, query.data_model_entities, None).await?
        {
            tracing::info!(
                cache_key = %cache_key,
                "Optimized Parquet cache HIT by client-supplied hash - no upload"
            );
            return optimized_parquet_response(metadata_json, body, resident);
        }
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
