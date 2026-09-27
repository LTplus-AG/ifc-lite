// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GET cache fetch / check endpoints.

use super::cache_keys::{
    cache_key_from_parts, data_model_cache_key, has_current_data_model, has_cached_symbolic, has_parquet_metadata,
    parquet_cache_key, parquet_metadata_cache_key, symbolic_cache_key,
};
use super::replay_header::mark_header_from_cache;
use super::ParseQuery;
use crate::error::ApiError;
use crate::AppState;
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::Response,
};

/// GET /api/v1/parse/data-model/:cache_key
///
/// Fetch the data model for a previously parsed file.
///
/// Response:
/// - 200: Data model Parquet binary
/// - 202: A fill IS running for this key right now (client should retry)
/// - 404: Nothing cached for this key and nothing filling it (issue #5129:
///   `/parse/parquet/optimized` never triggers a data-model write, so before
///   this a client that called only that route polled 202 forever -- the
///   response read as "still processing" for a key nothing was processing)
pub async fn get_data_model(
    State(state): State<AppState>,
    axum::extract::Path(cache_key): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    // Checked on BOTH sides of the (awaited, disk-I/O) cache read, not once,
    // and answering 202 if EITHER saw it (issue #5134 review): a single
    // check before the read leaves the read's whole await window open for a
    // fill to begin and go unnoticed, and a single check after leaves the
    // window before the read open the same way in the other direction --
    // either alone can land on a 404 for a fill that is (or was, moments
    // ago) genuinely in progress. `fetchDataModel` treats 404 as terminal, so
    // that false negative does not just cost a retry, it stops the client
    // from ever asking again. A real background fill's begin-to-drop span is
    // milliseconds to seconds of real parse/serialize/write work, so the
    // residual window -- a fill starting AND finishing its own drop entirely
    // between these two checks -- is negligible; closing it fully would need
    // a lock spanning both the in-memory marker and the disk read, which is
    // disproportionate here.
    let in_flight_before = state.data_model_in_flight.contains(&cache_key);
    let data_model_cache_key = data_model_cache_key(&cache_key);
    let cached = state.cache.get_bytes(&data_model_cache_key).await?;
    let in_flight = in_flight_before || state.data_model_in_flight.contains(&cache_key);

    match cached {
        Some(data_model_parquet) => {
            tracing::info!(
                cache_key = %cache_key,
                size = data_model_parquet.len(),
                "Data model cache HIT"
            );

            let response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/x-parquet-datamodel")
                .header(header::CONTENT_LENGTH, data_model_parquet.len())
                .body(Body::from(data_model_parquet))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        None if in_flight => {
            tracing::debug!(cache_key = %cache_key, "Data model fill in flight");

            let response = Response::builder()
                .status(StatusCode::ACCEPTED)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"status":"processing","message":"Data model is still being processed. Retry in a moment."}"#))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        None => {
            tracing::debug!(cache_key = %cache_key, "No data model cached and none in flight for this key");
            Err(ApiError::NotFound(format!(
                "No data model cached for key: {cache_key}"
            )))
        }
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
/// - 202: Not yet available — streaming caches symbolic data in the background; retry
pub async fn get_symbolic(
    State(state): State<AppState>,
    axum::extract::Path(cache_key): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let key = symbolic_cache_key(&cache_key);

    match state.cache.get_bytes(&key).await? {
        Some(symbolic_json) => {
            tracing::info!(
                cache_key = %cache_key,
                size = symbolic_json.len(),
                "Symbolic data cache HIT"
            );

            let response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CONTENT_LENGTH, symbolic_json.len())
                .body(Body::from(symbolic_json))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        None => {
            tracing::debug!(cache_key = %cache_key, "Symbolic data not yet available");

            // Return 202 Accepted to indicate processing (mirrors get_data_model);
            // the streaming endpoints cache symbolic data in a background task.
            let response = Response::builder()
                .status(StatusCode::ACCEPTED)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"status":"processing","message":"Symbolic data is still being processed. Retry in a moment."}"#))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
    }
}

/// GET /api/v1/cache/check/:hash
///
/// Check if a file hash is already cached.
/// Allows client to skip upload if file is already processed.
///
/// The optional `opening_filter` query parameter must match the value used when
/// the file was uploaded — different filter modes produce distinct cache entries.
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
    let sidecars_are_current = has_current_data_model(&state.cache, &seed_cache_key).await
        && has_cached_symbolic(&state.cache, &seed_cache_key).await
        && has_parquet_metadata(&state.cache, &seed_cache_key).await;

    match state.cache.get_bytes(&parquet_cache_key).await? {
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

    match (
        state.cache.get_bytes(&parquet_cache_key).await?,
        state.cache.get_bytes(&metadata_cache_key).await?,
    ) {
        (Some(parquet), Some(metadata)) => {
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
                .header(
                    "X-IFC-Metadata",
                    mark_header_from_cache(
                        String::from_utf8(metadata)
                            .map_err(|error| ApiError::Internal(error.to_string()))?,
                    ),
                )
                .header(header::CONTENT_LENGTH, parquet.len())
                .body(Body::from(parquet))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        _ => {
            tracing::debug!(hash = %hash, "Cached geometry not found");
            // Caller-supplied and unvalidated: logged, not echoed (as in
            // `check_cache` above).
            Err(ApiError::NotFound(
                "No cached geometry for this hash".to_owned(),
            ))
        }
    }
}
