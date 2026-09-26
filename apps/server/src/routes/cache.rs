// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache retrieval and deletion endpoints.
//!
//! `GET` and `DELETE /api/v1/cache/{key}` take ONE key space: the request
//! `cache_key` a parse route returns (`result.cache_key` on `POST /parse`,
//! the `cache_key` in every Parquet response's `X-IFC-Metadata` header). Both
//! resolve it through [`resolve_request_cache_key`], so a key one of them
//! accepts the other accepts too, and a key one of them refuses the other
//! refuses with the same `400` (#5750).

use crate::error::ApiError;
use crate::routes::parse::cache_keys::{cache_key_from_parts, is_file_digest, json_response_cache_key};
use crate::services::OpeningFilterMode;
use crate::types::SymbolicParseResponse;
use crate::AppState;
use axum::{
    body::Body,
    extract::{Path, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use ifc_lite_processing::TessellationQuality;
use serde::Serialize;

/// A request `cache_key` checked against the writer's own key builder: the
/// file's sha256 plus the opening-filter and tessellation-quality suffixes,
/// exactly as [`cache_key_from_parts`] spells them. Borrowed from the path
/// segment it was resolved from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RequestCacheKey<'a> {
    key: &'a str,
    digest: &'a str,
}

impl<'a> RequestCacheKey<'a> {
    /// The entry `POST /api/v1/parse` stored its response under.
    pub(crate) fn json_response_key(&self) -> String {
        json_response_cache_key(self.key)
    }

    /// The source file this key was derived from. Every cache entry for that
    /// file, whatever its variant or transport, starts with it.
    pub(crate) fn file_digest(&self) -> &'a str {
        self.digest
    }
}

/// Every opening filter a request key can carry. The `match` makes a new
/// variant a compile error here rather than a key both cache routes refuse.
fn opening_filters() -> [OpeningFilterMode; 3] {
    let every = |mode: OpeningFilterMode| match mode {
        OpeningFilterMode::Default | OpeningFilterMode::IgnoreAll | OpeningFilterMode::IgnoreOpaque => mode,
    };
    [
        every(OpeningFilterMode::Default),
        every(OpeningFilterMode::IgnoreAll),
        every(OpeningFilterMode::IgnoreOpaque),
    ]
}

/// Every tessellation level a request key can carry, for the same reason.
fn tessellation_qualities() -> [TessellationQuality; 5] {
    let every = |quality: TessellationQuality| match quality {
        TessellationQuality::Lowest
        | TessellationQuality::Low
        | TessellationQuality::Medium
        | TessellationQuality::High
        | TessellationQuality::Highest => quality,
    };
    [
        every(TessellationQuality::Lowest),
        every(TessellationQuality::Low),
        every(TessellationQuality::Medium),
        every(TessellationQuality::High),
        every(TessellationQuality::Highest),
    ]
}

/// THE resolver for the `{key}` of `GET` and `DELETE /api/v1/cache/{key}`.
///
/// Accepts exactly the strings [`cache_key_from_parts`] can produce, by
/// rebuilding each candidate with it rather than parsing the suffixes a second
/// way: the writer and this reader cannot disagree about what a key looks
/// like. Anything else -- a bare digest, an internal storage key with its
/// `-json-v5` / `-parquet-v5` suffix, arbitrary text -- is a `400`, which
/// also keeps `DELETE`'s index walk out of reach of a caller-shaped string
/// (#4582).
pub(crate) fn resolve_request_cache_key(key: &str) -> Result<RequestCacheKey<'_>, ApiError> {
    let digest = key.get(..64).filter(|digest| is_file_digest(digest));
    let resolved = digest.filter(|digest| {
        opening_filters().into_iter().any(|filter| {
            tessellation_qualities()
                .into_iter()
                .any(|quality| cache_key_from_parts(digest, filter, quality) == key)
        })
    });
    match resolved {
        Some(digest) => Ok(RequestCacheKey { key, digest }),
        None => Err(not_a_request_cache_key(key)),
    }
}

/// The rejection for a `{key}` that is not a request `cache_key`. Like
/// `not_a_file_digest`, the value is caller-controlled text and is not echoed.
fn not_a_request_cache_key(value: &str) -> ApiError {
    ApiError::BadRequest(format!(
        "expected the `cache_key` a parse response returned ({{sha256}}-{{opening_filter}}, plus -q{{quality}} for a non-default tessellation quality); got {} character(s)",
        value.chars().count()
    ))
}

/// GET /api/v1/cache/:key - Retrieve a cached `POST /api/v1/parse` result.
///
/// `key` is the `cache_key` that route returned, which is the value the
/// client's `getCached(result.cache_key)` passes, resolved by
/// [`resolve_request_cache_key`]. The response itself is stored under
/// [`json_response_cache_key`] (`{cache_key}-json-v5`), versioned separately
/// so the JSON wire format can move without retiring the Parquet entries that
/// share the same seed (#5542).
///
/// Only JSON response entries are reachable here: an entry that exists but
/// does not decode answers `404`, not `500` (#5128). Reading the bytes
/// directly (rather than through `DiskCache::get`, whose `?` cannot tell that
/// failure apart from a real I/O error) keeps an actual cache-store error a
/// `500`.
///
/// Decoded as [`SymbolicParseResponse`], the type the writer stored. The entry
/// is the whole model, so the read, decode and re-encode hold a parse
/// admission slot, reserved exactly as the parse route reserves one, and run
/// on the blocking pool (#4696, #5750): without the slot, concurrent GETs of
/// a large model were an unbounded number of whole-model working sets. The
/// slot travels with the blocking decode, not with this handler, so a client
/// that hangs up mid-decode does not free it while the decode runs on. A miss
/// is answered from the index before any slot is taken, so a key nobody wrote
/// costs one metadata lookup, like the hash-only probes (#3901).
pub async fn get_cached(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Response, ApiError> {
    let resolved = resolve_request_cache_key(&key)?;
    let response_key = resolved.json_response_key();
    tracing::debug!(key = %key, response_key = %response_key, "Cache lookup");

    let not_found = || ApiError::NotFound(format!("Cache key not found: {}", key));
    if !state.cache.has(&response_key).await? {
        tracing::debug!(key = %key, "Cache MISS");
        return Err(not_found());
    }

    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let bytes = match state.cache.get_bytes(&response_key).await? {
        Some(bytes) => bytes,
        None => {
            tracing::debug!(key = %key, "Cache MISS");
            return Err(not_found());
        }
    };

    // The guard moves INTO the blocking task and comes back with the result,
    // as in `parse_full`: if a disconnect or the TimeoutLayer cancels this
    // handler future, the detached decode keeps running and keeps its slot
    // until it actually exits, so a replacement is not admitted on top of it.
    let gate_key = response_key.clone();
    let (encoded, _admission) = tokio::task::spawn_blocking(move || {
        decode_gate(&gate_key);
        let encoded = serde_json::from_slice::<SymbolicParseResponse>(&bytes).and_then(|mut response| {
            response.mark_from_cache();
            serde_json::to_vec(&response)
        });
        (encoded, admission_guard)
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
            Err(not_found())
        }
    }
}

/// Test seam: lets a test hold one entry's decode open to observe what the
/// handler does while it runs. Compiled out of every non-test build.
#[cfg(test)]
fn decode_gate(response_key: &str) {
    cache_get_tests::hold_decode_if_gated(response_key);
}

#[cfg(not(test))]
fn decode_gate(_response_key: &str) {}

/// Response body for `DELETE /api/v1/cache/:key`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CacheDeleteResponse {
    /// The request `cache_key` the call named, echoed back once it resolved.
    pub key: String,
    /// Number of index entries removed. `0` for a file nothing was cached
    /// under, or whose entries were already gone -- see `remove_by_key_prefix`.
    pub deleted: usize,
}

/// DELETE /api/v1/cache/:key - Invalidate every cache entry for the source
/// file a request `cache_key` names (issues #3636, #5750).
///
/// `key` is the same `cache_key` [`get_cached`] takes, resolved by the same
/// [`resolve_request_cache_key`]. One source file fans out into several cache
/// entries (request, JSON, Parquet geometry, Parquet metadata, symbolic
/// sidecar, crossed with opening-filter and tessellation-quality variants);
/// this removes all of them, not only the variant the key names, because they
/// are all derived from the one file and a client invalidating it cannot know
/// which variants other callers warmed. Any content blob none of them (or any
/// unrelated entry) references any more is reclaimed.
///
/// Idempotent: deleting a key with no matching entries is a `200` with
/// `deleted: 0`, not a `404`, so a client can call this unconditionally and
/// retry safely without checking existence first.
///
/// Two bounds stand in front of that work, because it is expensive and, in
/// the shipped default configuration (`config.api_token` unset, so
/// `middleware::auth` is a pass-through), reachable by anyone:
///
///  - the path segment must resolve. `remove_by_key_prefix` walks the whole
///    cache index twice whatever it is handed, and a miss costs exactly as
///    much as a hit, so without this an arbitrary string buys a full index
///    walk (#4582).
///  - one such walk runs at a time, enforced by `DiskCache` itself so the
///    permit travels with the blocking work rather than with this request
///    future (a client that hangs up mid-walk must not release the bound
///    while the walk runs on). A concurrent one is shed with 503 +
///    `Retry-After` rather than queued; this route is retry-safe by
///    construction.
pub async fn delete_cached(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<CacheDeleteResponse>, ApiError> {
    let resolved = resolve_request_cache_key(&key)?;
    let deleted = state.cache.remove_by_key_prefix(resolved.file_digest()).await?;
    tracing::info!(key = %key, deleted, "Cache invalidation");
    Ok(Json(CacheDeleteResponse { key, deleted }))
}

#[cfg(test)]
#[path = "cache_delete_tests.rs"]
mod cache_delete_tests;

#[cfg(test)]
#[path = "cache_get_tests.rs"]
mod cache_get_tests;

#[cfg(test)]
#[path = "cache_key_tests.rs"]
mod cache_key_tests;
