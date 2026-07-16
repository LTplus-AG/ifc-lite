// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GET cache fetch / check endpoints.

use super::cache_keys::{parquet_cache_key, parquet_metadata_cache_key, symbolic_cache_key};
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
/// Returns the data model Parquet data if available (may still be processing).
///
/// Response:
/// - 200: Data model Parquet binary
/// - 202: Data model still processing (client should retry)
/// - 404: Cache key not found
pub async fn get_data_model(
    State(state): State<AppState>,
    axum::extract::Path(cache_key): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let data_model_cache_key = format!("{}-datamodel-v3", cache_key);

    match state.cache.get_bytes(&data_model_cache_key).await? {
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
        None => {
            tracing::debug!(cache_key = %cache_key, "Data model not yet available");

            // Return 202 Accepted to indicate processing
            let response = Response::builder()
                .status(StatusCode::ACCEPTED)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"status":"processing","message":"Data model is still being processed. Retry in a moment."}"#))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
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
/// - 404: File not cached (needs upload)
pub async fn check_cache(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> Result<Response, ApiError> {
    let parquet_cache_key = parquet_cache_key(
        &hash,
        query.opening_filter,
        query.resolved_tessellation_quality()?,
    );

    match state.cache.get_bytes(&parquet_cache_key).await? {
        Some(_) => {
            tracing::debug!(hash = %hash, cache_key = %parquet_cache_key, "Cache check HIT");
            let response = Response::builder()
                .status(StatusCode::OK)
                .body(Body::empty())
                .map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(response)
        }
        None => {
            tracing::debug!(hash = %hash, cache_key = %parquet_cache_key, "Cache check MISS");
            let response = Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .map_err(|e| ApiError::Internal(e.to_string()))?;
            Ok(response)
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
    let parquet_cache_key = parquet_cache_key(
        &hash,
        query.opening_filter,
        query.resolved_tessellation_quality()?,
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
                .header(
                    "X-IFC-Metadata",
                    String::from_utf8(metadata)
                        .map_err(|error| ApiError::Internal(error.to_string()))?,
                )
                .header(header::CONTENT_LENGTH, parquet.len())
                .body(Body::from(parquet))
                .map_err(|e| ApiError::Internal(e.to_string()))?;

            Ok(response)
        }
        _ => {
            tracing::debug!(hash = %hash, "Cached geometry not found");
            Err(ApiError::NotFound(format!(
                "Cache entry not found for hash: {}",
                hash
            )))
        }
    }
}
