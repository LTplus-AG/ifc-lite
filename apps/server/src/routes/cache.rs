// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache retrieval and deletion endpoints.

use crate::error::ApiError;
use crate::types::ParseResponse;
use crate::AppState;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;

/// GET /api/v1/cache/:key - Retrieve cached result.
pub async fn get_cached(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<ParseResponse>, ApiError> {
    tracing::debug!(key = %key, "Cache lookup");

    match state.cache.get::<ParseResponse>(&key).await? {
        Some(mut response) => {
            response.stats.from_cache = true;
            tracing::info!(key = %key, "Cache HIT");
            Ok(Json(response))
        }
        None => {
            tracing::debug!(key = %key, "Cache MISS");
            Err(ApiError::NotFound(format!("Cache key not found: {}", key)))
        }
    }
}

/// Response body for `DELETE /api/v1/cache/:hash`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CacheDeleteResponse {
    /// The `sha256` (or full cache-key) prefix that was targeted.
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
pub async fn delete_cached(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<CacheDeleteResponse>, ApiError> {
    let deleted = state.cache.remove_by_key_prefix(&hash).await?;
    tracing::info!(hash = %hash, deleted, "Cache invalidation");
    Ok(Json(CacheDeleteResponse { key: hash, deleted }))
}

#[cfg(test)]
#[path = "cache_delete_tests.rs"]
mod cache_delete_tests;
