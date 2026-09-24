// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache retrieval and deletion endpoints.

use crate::error::ApiError;
use crate::routes::parse::cache_keys::{is_file_digest, json_response_cache_key, not_a_file_digest};
use crate::types::SymbolicParseResponse;
use crate::AppState;
use axum::{
    body::Body,
    extract::{Path, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

/// GET /api/v1/cache/:key - Retrieve a cached `POST /api/v1/parse` result.
///
/// `key` is the `cache_key` that route returned, which is the value the
/// client's `getCached(result.cache_key)` passes. The response itself is
/// stored under [`json_response_cache_key`] (`{cache_key}-json-v5`), versioned
/// separately so the JSON wire format can move without retiring the Parquet
/// entries that share the same seed. Before #5542 this route looked `key` up
/// unchanged, so the documented call could never hit: it answered `404` for
/// every file the JSON route had cached. It resolves the key the writer used
/// now, from the one definition of that suffix.
///
/// Only JSON response entries are reachable here. Before #5128 a binary
/// Parquet key passed in (e.g. from an `X-IFC-Metadata` `cache_key` with a
/// suffix guessed onto it) was decoded as JSON and answered `500`; it now
/// names no JSON entry and answers `404`, and an entry that exists but does
/// not decode still answers `404` rather than `500`. Reading the bytes
/// directly (rather than through `DiskCache::get`, whose `?` cannot tell that
/// failure apart from a real I/O error) keeps an actual cache-store error a
/// `500`.
///
/// Decoded as [`SymbolicParseResponse`], the type the writer stored, so the
/// symbol stream keeps its fill provenance; the entry is the whole model, so
/// the decode and re-encode run on the blocking pool as the parse route's own
/// hit does (#4696).
pub async fn get_cached(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Response, ApiError> {
    let response_key = json_response_cache_key(&key);
    tracing::debug!(key = %key, response_key = %response_key, "Cache lookup");

    let bytes = match state.cache.get_bytes(&response_key).await? {
        Some(bytes) => bytes,
        None => {
            tracing::debug!(key = %key, "Cache MISS");
            return Err(ApiError::NotFound(format!("Cache key not found: {}", key)));
        }
    };

    let encoded = tokio::task::spawn_blocking(move || {
        let mut response = serde_json::from_slice::<SymbolicParseResponse>(&bytes)?;
        response.mark_from_cache();
        serde_json::to_vec(&response)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?;

    match encoded {
        Ok(body) => {
            tracing::info!(key = %key, "Cache HIT");
            Ok(([(header::CONTENT_TYPE, "application/json")], Body::from(body)).into_response())
        }
        Err(e) => {
            tracing::warn!(error = %e, key = %key, "Cache entry is not a ParseResponse; answering 404");
            Err(ApiError::NotFound(format!("Cache key not found: {}", key)))
        }
    }
}

/// Response body for `DELETE /api/v1/cache/:hash`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CacheDeleteResponse {
    /// The file `sha256` whose entries were targeted.
    pub key: String,
    /// Number of index entries removed. `0` for a prefix nothing was cached
    /// under, or whose entries were already gone -- see `remove_by_key_prefix`.
    pub deleted: usize,
}

/// DELETE /api/v1/cache/:hash - Invalidate every cache entry for one source
/// file (issue #3636).
///
/// `hash` is the file's `sha256` content hash, i.e. the same value
/// `DiskCache::generate_key` produces and every parse/cache route is keyed
/// from. One source file fans out into several cache entries under that hash
/// (request, JSON, Parquet geometry, Parquet metadata, symbolic sidecar,
/// crossed with opening-filter and tessellation-quality suffixes); this
/// removes all of them, and reclaims any content blob none of them (or any
/// unrelated entry) references any more.
///
/// Idempotent: deleting a hash with no matching entries is a `200` with
/// `deleted: 0`, not a `404`, so a client can call this unconditionally
/// (e.g. "the model behind this hash was removed, drop whatever is cached
/// for it, if anything") and retry safely without checking existence first.
///
/// Two bounds stand in front of that work, because it is expensive and, in
/// the shipped default configuration (`config.api_token` unset, so
/// `middleware::auth` is a pass-through), reachable by anyone:
///
///  - the path segment must be a file digest. `remove_by_key_prefix` walks
///    the whole cache index twice whatever it is handed, and a miss costs
///    exactly as much as a hit, so without this an arbitrary string buys a
///    full index walk. Everything this route can legitimately be called with
///    is a `DiskCache::generate_key` output.
///  - one such walk runs at a time, enforced by `DiskCache` itself so the
///    permit travels with the blocking work rather than with this request
///    future (a client that hangs up mid-walk must not release the bound
///    while the walk runs on). A concurrent one is shed with 503 +
///    `Retry-After` rather than queued; this route is retry-safe by
///    construction.
pub async fn delete_cached(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<CacheDeleteResponse>, ApiError> {
    if !is_file_digest(&hash) {
        return Err(not_a_file_digest(&hash));
    }
    let deleted = state.cache.remove_by_key_prefix(&hash).await?;
    tracing::info!(hash = %hash, deleted, "Cache invalidation");
    Ok(Json(CacheDeleteResponse { key: hash, deleted }))
}

#[cfg(test)]
#[path = "cache_delete_tests.rs"]
mod cache_delete_tests;

#[cfg(test)]
#[path = "cache_get_tests.rs"]
mod cache_get_tests;
