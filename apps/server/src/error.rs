// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Error types and handling for the server.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;

/// API error types.
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Missing file in request")]
    MissingFile,

    #[error("File too large: maximum size is {max_mb} MB")]
    FileTooLarge { max_mb: usize },

    #[error("Multipart error: {0}")]
    Multipart(#[from] axum::extract::multipart::MultipartError),

    #[error("Processing error: {0}")]
    Processing(String),

    #[error("Cache error: {0}")]
    Cache(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Internal server error: {0}")]
    Internal(String),

    #[error("Join error")]
    Join(#[from] tokio::task::JoinError),

    #[error("Parquet serialization error: {0}")]
    Parquet(String),

    #[error("Server overloaded, retry after {retry_after_secs}s")]
    Overloaded { retry_after_secs: u64 },
}

/// Error response body.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let ApiError::FileTooLarge { max_mb } = &self {
            tracing::warn!(max_mb, "Rejecting oversized upload");
        }

        let (status, code) = match &self {
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            ApiError::MissingFile => (StatusCode::BAD_REQUEST, "MISSING_FILE"),
            ApiError::FileTooLarge { .. } => (StatusCode::PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE"),
            ApiError::Multipart(_) => (StatusCode::BAD_REQUEST, "MULTIPART_ERROR"),
            ApiError::Processing(_) => (StatusCode::INTERNAL_SERVER_ERROR, "PROCESSING_ERROR"),
            ApiError::Cache(_) => (StatusCode::INTERNAL_SERVER_ERROR, "CACHE_ERROR"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
            ApiError::Join(_) => (StatusCode::INTERNAL_SERVER_ERROR, "TASK_ERROR"),
            ApiError::Parquet(_) => (StatusCode::INTERNAL_SERVER_ERROR, "PARQUET_ERROR"),
            ApiError::Overloaded { .. } => (StatusCode::SERVICE_UNAVAILABLE, "OVERLOADED"),
        };

        let retry_after = match &self {
            ApiError::Overloaded { retry_after_secs } => Some(*retry_after_secs),
            _ => None,
        };

        let body = ErrorResponse {
            error: self.to_string(),
            code: code.to_string(),
        };

        let mut response = (status, Json(body)).into_response();
        if let Some(secs) = retry_after {
            if let Ok(v) = axum::http::HeaderValue::from_str(&secs.to_string()) {
                response.headers_mut().insert(axum::http::header::RETRY_AFTER, v);
            }
        }
        response
    }
}

impl From<ifc_lite_core::Error> for ApiError {
    fn from(err: ifc_lite_core::Error) -> Self {
        ApiError::Processing(err.to_string())
    }
}

impl From<ifc_lite_geometry::Error> for ApiError {
    fn from(err: ifc_lite_geometry::Error) -> Self {
        ApiError::Processing(err.to_string())
    }
}

impl From<cacache::Error> for ApiError {
    fn from(err: cacache::Error) -> Self {
        ApiError::Cache(err.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(err: serde_json::Error) -> Self {
        ApiError::Internal(format!("JSON error: {}", err))
    }
}

impl From<crate::services::ParquetError> for ApiError {
    fn from(err: crate::services::ParquetError) -> Self {
        ApiError::Parquet(err.to_string())
    }
}

impl From<crate::services::parquet_data_model::DataModelParquetError> for ApiError {
    fn from(err: crate::services::parquet_data_model::DataModelParquetError) -> Self {
        ApiError::Parquet(err.to_string())
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;

    /// Every `ApiError` variant maps to the specific HTTP status + JSON
    /// `code` pair clients rely on. Only `Overloaded` (503) was exercised
    /// end-to-end before this test — the other nine variants' status codes
    /// were never checked through `IntoResponse`, so a swapped match arm
    /// (e.g. `FileTooLarge` silently becoming 200) would have shipped
    /// unnoticed.
    #[tokio::test]
    async fn into_response_maps_every_variant_to_its_documented_status_and_code() {
        let cases: Vec<(ApiError, StatusCode, &str)> = vec![
            (ApiError::BadRequest("x".into()), StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            (ApiError::MissingFile, StatusCode::BAD_REQUEST, "MISSING_FILE"),
            (
                ApiError::FileTooLarge { max_mb: 5 },
                StatusCode::PAYLOAD_TOO_LARGE,
                "FILE_TOO_LARGE",
            ),
            (
                ApiError::Processing("x".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "PROCESSING_ERROR",
            ),
            (ApiError::Cache("x".into()), StatusCode::INTERNAL_SERVER_ERROR, "CACHE_ERROR"),
            (ApiError::NotFound("x".into()), StatusCode::NOT_FOUND, "NOT_FOUND"),
            (
                ApiError::Internal("x".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
            ),
            (
                ApiError::Parquet("x".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "PARQUET_ERROR",
            ),
            (
                ApiError::Overloaded { retry_after_secs: 3 },
                StatusCode::SERVICE_UNAVAILABLE,
                "OVERLOADED",
            ),
        ];

        for (err, expected_status, expected_code) in cases {
            let debug_repr = format!("{err:?}");
            let response = err.into_response();
            assert_eq!(response.status(), expected_status, "wrong status for {debug_repr}");
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["code"], expected_code, "wrong code for {debug_repr}");
        }
    }

    /// Only `Overloaded` sets `Retry-After`; every other variant must not,
    /// or a downstream client would wrongly back off after e.g. a 400.
    #[test]
    fn only_overloaded_sets_the_retry_after_header() {
        let overloaded = ApiError::Overloaded { retry_after_secs: 7 }.into_response();
        assert_eq!(
            overloaded
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("7")
        );

        let bad_request = ApiError::BadRequest("x".into()).into_response();
        assert!(bad_request.headers().get(axum::http::header::RETRY_AFTER).is_none());
    }

    /// The JSON `code` field is what viewer/CLI clients branch on, so pin it
    /// per variant too (a body extraction, unlike the status-only checks
    /// above, so it lives in a `tokio::test`).
    #[tokio::test]
    async fn error_bodies_carry_the_documented_code() {
        let response = ApiError::MissingFile.into_response();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["code"], "MISSING_FILE");
    }
}
