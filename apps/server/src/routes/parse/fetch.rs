// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GET cache fetch / check endpoints.

use super::cache_keys::{
    cache_key_from_parts, data_model_cache_key, data_model_refusal_key, has_current_data_model, has_cached_symbolic, has_parquet_metadata,
    parquet_cache_key, parquet_metadata_cache_key, symbolic_cache_key,
};
use super::cache_read::{resident_body, sidecar_response};
use super::replay_header::mark_header_from_cache;
use super::ParseQuery;
use crate::error::ApiError;
use crate::services::DataModelEntities;
use crate::AppState;
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::Response,
};

/// Query of `GET /api/v1/parse/data-model/{cache_key}`.
///
/// Its own struct rather than [`ParseQuery`]: this route takes one parameter,
/// and it must be the SAME value the parse request sent, because it selects
/// which of the two data-model entries is read (#6034).
#[derive(serde::Deserialize, Default)]
pub struct DataModelQuery {
    /// "all" (default) or "rooted"; see [`DataModelEntities`].
    #[serde(default)]
    pub data_model_entities: DataModelEntities,
}

/// GET /api/v1/parse/data-model/:cache_key
///
/// Fetch the data model for a previously parsed file.
///
/// `?data_model_entities=rooted` (#6034) fetches the rooted-only variant,
/// which only a parse sent with the same parameter writes. Without it, the
/// full table. Neither ever answers for the other.
///
/// Response:
/// - 200: Data model Parquet binary
/// - 202: A fill IS running for this key right now (client should retry)
/// - 400: The fill refused the model (#7675: a table over its size budget);
///   the body carries the reason
/// - 404: Nothing cached for this key and nothing filling it (issue #5129:
///   `/parse/parquet/optimized` never triggers a data-model write, so before
///   this a client that called only that route polled 202 forever -- the
///   response read as "still processing" for a key nothing was processing)
pub async fn get_data_model(
    State(state): State<AppState>,
    Query(query): Query<DataModelQuery>,
    axum::extract::Path(cache_key): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    // The 200 / 202 / 404 decision, the in-flight check on both sides of the
    // read (#5134 review) and the read's admission (#7676) live in
    // `sidecar_response`, shared with the symbolic fetch below. In-flight
    // markers are keyed by the data-model ENTRY, not the request key
    // (#6034): a fill of the full table says nothing about the rooted one.
    let entry_key = data_model_cache_key(&cache_key, query.data_model_entities);
    match sidecar_response(&state, &cache_key, &entry_key, "application/x-parquet-datamodel", "Data model").await {
        // Nothing cached and nothing filling: a fill that refused the model
        // recorded why (#7675), and that reason answers 400 instead of 404.
        Err(ApiError::NotFound(not_found)) => {
            match state.cache.read_usable_utf8(&data_model_refusal_key(&entry_key)).await? {
                Some(reason) => Err(ApiError::BadRequest(reason)),
                None => Err(ApiError::NotFound(not_found)),
            }
        }
        other => other,
    }
}

/// GET /api/v1/parse/symbolic/:cache_key
///
/// Fetch the 2D symbol stream (`IfcAnnotation` + `IfcGrid`) for a previously
/// parsed file as JSON. This brings the binary-transport endpoints (Parquet,
/// optimized Parquet, cached geometry) to parity with the inline `symbolic_data`
/// field on `POST /api/v1/parse` (issue #900). Symbol data is cached separately
/// from geometry — exactly like the data model — so it's fetched the same way,
/// keyed by the `cache_key` carried in each response's metadata header.
///
/// `cache_key` is the full `{hash}-{opening_filter}` value (e.g. `<hash>-default`).
///
/// Response:
/// - 200: `SymbolicData` JSON (may have empty arrays when the model has no 2D symbols)
/// - 202: A parse that writes this sidecar is running right now (retry)
/// - 404: Nothing cached for this key and nothing writing it (#7676,
///   SERVER-21: this answered 202 for any absent key, so a client polled a
///   typo or an evicted entry until its own timeout, the trap #5129 removed
///   from the data-model fetch)
pub async fn get_symbolic(
    State(state): State<AppState>,
    axum::extract::Path(cache_key): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let entry_key = symbolic_cache_key(&cache_key);
    sidecar_response(&state, &cache_key, &entry_key, "application/json", "Symbolic data").await
}

/// GET /api/v1/cache/check/:hash
///
/// Check if a file hash is already cached.
/// Allows client to skip upload if file is already processed.
///
/// The optional `opening_filter` query parameter must match the value used when
/// the file was uploaded — different filter modes produce distinct cache entries.
///
/// An existence check: every entry is looked up and none is read (#7676,
/// SERVER-6), so it needs no admission slot. It used to read and
/// integrity-hash the geometry, data model, symbolic sidecar and metadata,
/// all to return an empty `200`, which made it the cheapest way to make the
/// server hold a model in memory. An entry that is present but damaged still
/// answers `200` here; the fetch it sends the client to refuses and evicts
/// it, and from then on this answers `404`.
///
/// Response:
/// - 200: File is cached (geometry available)
/// - 404: File not cached (needs upload), in the shared error envelope
///   (#5750; the body was empty before)
pub async fn check_cache(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let quality = query.resolved_tessellation_quality()?;
    // Answers for the LAYOUT the client asked about (#3888). A client that
    // does not send `parquet_layout` is asking about v5, and a v6 entry sitting
    // beside it must NOT report a hit: the client would skip the upload and
    // then fetch a blob it draws wrong.
    let parquet_cache_key =
        parquet_cache_key(&hash, query.opening_filter, quality, query.parquet_layout);
    // A geometry entry alone is not enough: the client skips the upload on a
    // hit, so a data model at the current payload version has to exist too, or
    // nothing will ever write one (issue #3869). The same holds for the
    // metadata header: a hit sends the client to `get_cached_geometry`, which
    // needs it at the current version, and a header version bump leaves the
    // geometry entry behind (#4675).
    let seed_cache_key = cache_key_from_parts(&hash, query.opening_filter, quality);
    let sidecars_are_current =
        has_current_data_model(&state.cache, &seed_cache_key, query.data_model_entities).await?
        && has_cached_symbolic(&state.cache, &seed_cache_key).await?
        && has_parquet_metadata(&state.cache, &seed_cache_key).await?;

    match state.cache.lookup(&parquet_cache_key).await? {
        Some(_) if sidecars_are_current => {
            tracing::debug!(hash = %hash, cache_key = %parquet_cache_key, "Cache check HIT");
            let response = Response::builder()
                .status(StatusCode::OK)
                .body(Body::empty())
                .map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(response)
        }
        cached => {
            tracing::debug!(
                hash = %hash,
                cache_key = %parquet_cache_key,
                geometry_cached = cached.is_some(),
                "Cache check MISS"
            );
            // The hash is caller-supplied and unvalidated here, so it is not
            // echoed back (as `not_a_file_digest` does not echo it either).
            Err(ApiError::NotFound(
                "Nothing cached for this hash under this opening_filter / tessellation_quality / parquet_layout"
                    .to_owned(),
            ))
        }
    }
}

/// GET /api/v1/cache/geometry/:hash
///
/// Fetch cached Parquet geometry directly without uploading the file.
/// Used when client-side hash check confirms file is already cached.
///
/// The optional `opening_filter` query parameter must match the value used when
/// the file was uploaded — different filter modes produce distinct cache entries.
///
/// Response:
/// - 200: Cached Parquet geometry with metadata header
/// - 404: Cache entry not found
pub async fn get_cached_geometry(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    // Same layout signal as the cache check and the parse routes, so this can
    // only ever hand back the layout the caller declared it understands.
    let parquet_cache_key = parquet_cache_key(
        &hash,
        query.opening_filter,
        query.resolved_tessellation_quality()?,
        query.parquet_layout,
    );
    let metadata_cache_key = parquet_metadata_cache_key(
        &hash,
        query.opening_filter,
        query.resolved_tessellation_quality()?,
    );

    // Admitted for the two entries' stored size before either is read
    // (#7676, SERVER-6); the reservation rides the body. A damaged entry is
    // a miss (SERVER-12), not the 500 it was.
    let read = match (
        state.cache.lookup(&parquet_cache_key).await?,
        state.cache.lookup(&metadata_cache_key).await?,
    ) {
        (Some(parquet), Some(metadata_entry)) => {
            let resident = state.admission.acquire_resident(parquet.size() + metadata_entry.size()).await?;
            let metadata = match state.cache.read_entry(&metadata_cache_key, &metadata_entry).await {
                Some(bytes) => {
                    state.cache.usable(&metadata_cache_key, &metadata_entry, String::from_utf8(bytes)).await
                }
                None => None,
            };
            match metadata {
                Some(metadata) => state
                    .cache
                    .read_entry(&parquet_cache_key, &parquet)
                    .await
                    .map(|parquet| (parquet, metadata, resident)),
                None => None,
            }
        }
        _ => None,
    };

    match read {
        Some((parquet, metadata, resident)) => {
            tracing::info!(
                hash = %hash,
                parquet_size = parquet.len(),
                "Returning cached geometry (no upload needed)"
            );

            let response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/x-parquet-geometry")
                // Stored as the live parse wrote it, `from_cache: false`
                // included; this is the warm path of `parseParquet()` (#5542).
                .header("X-IFC-Metadata", mark_header_from_cache(metadata))
                .header(header::CONTENT_LENGTH, parquet.len())
                .body(resident_body(parquet, resident))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        None => {
            tracing::debug!(hash = %hash, "Cached geometry not found");
            // Caller-supplied and unvalidated: logged, not echoed (as in
            // `check_cache` above).
            Err(ApiError::NotFound(
                "No cached geometry for this hash".to_owned(),
            ))
        }
    }
}
