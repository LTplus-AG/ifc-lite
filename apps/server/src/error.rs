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
}

/// Error response body.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
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
        };

        let body = ErrorResponse {
            error: self.to_string(),
            code: code.to_string(),
        };

        (status, Json(body)).into_response()
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
