// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the error → HTTP status/code mapping.
//!
//! `error.rs` had no tests. The whole `match` in `IntoResponse` was unpinned
//! except for `Overloaded` (incidentally, via `parity_tests`): remapping
//! `FileTooLarge` from `413` to `400` left the suite green, even though the
//! streaming size guard exists specifically so a client sees a clean `413`
//! rather than a generic multipart error.

use super::*;
use axum::body::to_bytes;

/// `(status, code)` for one error, plus the JSON body it serialises to.
async fn parts(err: ApiError) -> (StatusCode, String, serde_json::Value) {
    let response = err.into_response();
    let status = response.status();
    let retry_after = response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON error body");
    (status, retry_after, body)
}

/// The full mapping table, one row per variant. Each row is checked
/// independently, so a mutation to any single arm fails on that arm rather
/// than being masked by the rest of the loop.
#[tokio::test]
async fn every_variant_maps_to_its_documented_status_and_code() {
    let cases: Vec<(ApiError, StatusCode, &str)> = vec![
        (
            ApiError::BadRequest("nope".into()),
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
        ),
        (ApiError::MissingFile, StatusCode::BAD_REQUEST, "MISSING_FILE"),
        (
            ApiError::FileTooLarge { max_mb: 500 },
            StatusCode::PAYLOAD_TOO_LARGE,
            "FILE_TOO_LARGE",
        ),
        (
            ApiError::Processing("boom".into()),
            StatusCode::INTERNAL_SERVER_ERROR,
            "PROCESSING_ERROR",
        ),
        (
            ApiError::Cache("boom".into()),
            StatusCode::INTERNAL_SERVER_ERROR,
            "CACHE_ERROR",
        ),
        (ApiError::NotFound("key".into()), StatusCode::NOT_FOUND, "NOT_FOUND"),
        (
            ApiError::Internal("boom".into()),
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
        ),
        (
            ApiError::Parquet("boom".into()),
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
        let label = err.to_string();
        let (status, _, body) = parts(err).await;
        assert_eq!(status, expected_status, "status for {label:?}");
        assert_eq!(body["code"], expected_code, "code for {label:?}");
        assert_eq!(
            body["error"], label,
            "the body message must be the Display text for {label:?}"
        );
    }
}

/// An oversized upload is a `413`, not a `400`. The distinction is what lets a
/// client tell "your file is too big, split it" from "your request was
/// malformed", and the message must carry the actual ceiling.
#[tokio::test]
async fn file_too_large_is_413_and_names_the_limit() {
    let (status, _, body) = parts(ApiError::FileTooLarge { max_mb: 500 }).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_ne!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "FILE_TOO_LARGE");
    assert_eq!(body["error"], "File too large: maximum size is 500 MB");
    // The limit is interpolated, not hard-coded.
    let (_, _, body) = parts(ApiError::FileTooLarge { max_mb: 42 }).await;
    assert_eq!(body["error"], "File too large: maximum size is 42 MB");
}

/// `Retry-After` is emitted for `Overloaded` and for NOTHING else — both
/// directions of the header signal, and the value is the one carried in the
/// variant rather than a constant.
#[tokio::test]
async fn retry_after_header_is_overloaded_only() {
    let (status, retry_after, _) = parts(ApiError::Overloaded { retry_after_secs: 7 }).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(retry_after, "7");

    let (_, retry_after, _) = parts(ApiError::Overloaded { retry_after_secs: 12 }).await;
    assert_eq!(retry_after, "12", "the header echoes the variant's value");

    for other in [
        ApiError::BadRequest("x".into()),
        ApiError::MissingFile,
        ApiError::FileTooLarge { max_mb: 1 },
        ApiError::NotFound("x".into()),
        ApiError::Internal("x".into()),
    ] {
        let label = other.to_string();
        let (_, retry_after, _) = parts(other).await;
        assert!(
            retry_after.is_empty(),
            "{label:?} must not advertise Retry-After, got {retry_after:?}"
        );
    }
}

/// Domain errors from the workspace crates become `PROCESSING_ERROR` (500) and
/// carry the underlying message, so a malformed-IFC failure is diagnosable from
/// the response alone.
#[tokio::test]
async fn core_and_geometry_errors_become_processing_errors() {
    let core: ApiError = ifc_lite_core::Error::ParseError {
        position: 42,
        message: "bad STEP header".into(),
    }
    .into();
    assert!(matches!(core, ApiError::Processing(_)));
    let (status, _, body) = parts(core).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "PROCESSING_ERROR");
    assert!(
        body["error"].as_str().unwrap().contains("bad STEP header"),
        "the underlying message must survive the conversion: {body}"
    );
}

/// A JSON (de)serialisation failure is an INTERNAL error, not a client error:
/// the client did not send the JSON that failed, the server produced it.
#[tokio::test]
async fn serde_json_errors_become_internal_errors() {
    let err = serde_json::from_str::<serde_json::Value>("{not json").unwrap_err();
    let api: ApiError = err.into();
    assert!(matches!(api, ApiError::Internal(_)));
    let (status, _, body) = parts(api).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "INTERNAL_ERROR");
    assert!(body["error"].as_str().unwrap().starts_with("Internal server error: JSON error:"));
}

/// The body is always a two-field object; a client parses `code`
/// programmatically and shows `error` to a human.
#[tokio::test]
async fn the_error_body_shape_is_stable() {
    let (_, _, body) = parts(ApiError::NotFound("cache key abc".into())).await;
    let obj = body.as_object().expect("object body");
    assert_eq!(obj.len(), 2, "exactly `error` and `code`: {body}");
    assert!(obj.contains_key("error"));
    assert!(obj.contains_key("code"));
    assert_eq!(body["error"], "Not found: cache key abc");
}
