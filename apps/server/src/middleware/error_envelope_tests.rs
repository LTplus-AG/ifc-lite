// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5750: every non-2xx answer is the `{"error", "code"}` envelope. Before
//! it, the server answered errors in four shapes: that envelope (handler
//! failures), `text/plain` (extractor rejections, `/metrics` while disabled),
//! an empty body (auth `401`, `/cache/check` miss, unknown route, wrong
//! method, timeout), and the SSE `error` event mid-stream, which is not an
//! HTTP error and stays as it is. The cases below are driven through the real
//! router, one per former shape that a request can reach.

use super::*;
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use axum::response::IntoResponse;
use serde_json::Value;
use std::io::Read;
use std::sync::Arc;
use tower::ServiceExt;

async fn test_state(label: &str, api_token: Option<&str>) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-5750-envelope-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    let mut config = Config::from_env();
    config.api_token = api_token.map(str::to_owned);
    config.metrics_enabled = false;
    AppState {
        cache,
        config: Arc::new(config),
        admission: Arc::new(crate::admission::Admission::new(crate::admission::AdmissionCfg {
            max_concurrent_parses: 4,
            mem_budget_bytes: 0,
            queue_depth: 8,
            queue_timeout: std::time::Duration::from_millis(100),
            shed_pct: 85,
        })),
        data_model_in_flight: Arc::new(crate::in_flight::InFlightKeys::default()),
    }
}

async fn send(state: &AppState, request: Request<Body>) -> Response {
    build_router(state.clone()).oneshot(request).await.unwrap()
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

/// The envelope a response carries, asserting the content type says so.
async fn envelope(response: Response) -> Value {
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
        Some("application/json"),
        "an error must be declared JSON"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|e| panic!("not a JSON body ({e}): {:?}", String::from_utf8_lossy(&bytes)));
    assert!(body["error"].as_str().is_some_and(|s| !s.is_empty()), "no `error` message: {body}");
    assert!(body["code"].as_str().is_some_and(|s| !s.is_empty()), "no `code`: {body}");
    assert_eq!(body.as_object().unwrap().len(), 2, "exactly `error` and `code`: {body}");
    body
}

const DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Formerly `text/plain`: an extractor rejection keeps axum's message as
/// `error` and gets the status's code.
#[tokio::test]
async fn issue_5750_query_rejection_is_the_envelope() {
    let state = test_state("query", None).await;
    let response = send(&state, get(&format!("/api/v1/cache/check/{DIGEST}?opening_filter=bogus"))).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = envelope(response).await;
    assert_eq!(body["code"], "BAD_REQUEST");
    assert!(body["error"].as_str().unwrap().contains("opening_filter"), "{body}");
}

/// Formerly `text/plain`: a parse request that is not multipart.
#[tokio::test]
async fn issue_5750_multipart_rejection_is_the_envelope() {
    let state = test_state("multipart", None).await;
    let request = Request::builder().method("POST").uri("/api/v1/parse").body(Body::empty()).unwrap();
    let response = send(&state, request).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(envelope(response).await["code"], "BAD_REQUEST");
}

/// Formerly `text/plain`: `/metrics` while disabled.
#[tokio::test]
async fn issue_5750_disabled_metrics_is_the_envelope() {
    let state = test_state("metrics", None).await;
    let response = send(&state, get("/api/v1/metrics")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(envelope(response).await["code"], "NOT_FOUND");
}

/// Formerly empty: the bearer layer's `401`, now with `WWW-Authenticate`.
#[tokio::test]
async fn issue_5750_unauthorized_is_the_envelope() {
    let state = test_state("auth", Some("s3cr3t")).await;
    let response = send(&state, get(&format!("/api/v1/cache/{DIGEST}-default"))).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers().get(header::WWW_AUTHENTICATE).and_then(|v| v.to_str().ok()),
        Some("Bearer")
    );
    assert_eq!(envelope(response).await["code"], "UNAUTHORIZED");
}

/// Formerly empty: the `/cache/check` miss.
#[tokio::test]
async fn issue_5750_cache_check_miss_is_the_envelope() {
    let state = test_state("check", None).await;
    let response = send(&state, get(&format!("/api/v1/cache/check/{DIGEST}"))).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(envelope(response).await["code"], "NOT_FOUND");
}

/// Formerly empty: an unknown route and a known route with the wrong method.
/// The `405` keeps its `Allow` header.
#[tokio::test]
async fn issue_5750_unknown_route_and_wrong_method_are_the_envelope() {
    let state = test_state("routing", None).await;
    let response = send(&state, get("/api/v1/nope")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(envelope(response).await["code"], "NOT_FOUND");

    let request = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/cache/{DIGEST}-default"))
        .body(Body::empty())
        .unwrap();
    let response = send(&state, request).await;
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert!(response.headers().get(header::ALLOW).is_some(), "the 405 lost its Allow header");
    let body = envelope(response).await;
    assert_eq!(body["code"], "METHOD_NOT_ALLOWED");
    assert_eq!(body["error"], "Method Not Allowed");
}

/// The envelope is written before compression, so a client that accepts gzip
/// gets a gzipped envelope, never a gzipped `text/plain` the envelope layer
/// could not read.
#[tokio::test]
async fn issue_5750_the_envelope_survives_compression() {
    let state = test_state("gzip", None).await;
    let request = Request::builder()
        .uri(format!("/api/v1/cache/check/{DIGEST}?opening_filter=bogus"))
        .header(header::ACCEPT_ENCODING, "gzip")
        .body(Body::empty())
        .unwrap();
    let response = send(&state, request).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let gzipped = response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v == "gzip");
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = if gzipped {
        let mut decoded = String::new();
        flate2::read::GzDecoder::new(bytes.as_ref()).read_to_string(&mut decoded).unwrap();
        decoded
    } else {
        String::from_utf8(bytes.to_vec()).unwrap()
    };
    let body: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}: {text:?}"));
    assert_eq!(body["code"], "BAD_REQUEST");
    assert!(
        body["error"].as_str().unwrap().contains("opening_filter"),
        "the rejection text must survive, not arrive as gzip bytes read as text: {body}"
    );
}

/// A handler's `ApiError` is already the envelope and passes through byte for
/// byte, as does the one other JSON non-2xx body, `/ready`'s `503` probe
/// document.
#[tokio::test]
async fn issue_5750_json_error_bodies_pass_through_unchanged() {
    let original = crate::error::ApiError::Overloaded { retry_after_secs: 3 }.into_response();
    let (parts, body) = original.into_parts();
    let original_bytes = to_bytes(body, usize::MAX).await.unwrap();
    let wrapped = envelope_errors(Response::from_parts(parts, Body::from(original_bytes.clone()))).await;
    assert_eq!(wrapped.headers().get(header::RETRY_AFTER).unwrap(), "3");
    assert_eq!(to_bytes(wrapped.into_body(), usize::MAX).await.unwrap(), original_bytes);

    let probe = Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"status":"shedding"}"#))
        .unwrap();
    let wrapped = envelope_errors(probe).await;
    assert_eq!(to_bytes(wrapped.into_body(), usize::MAX).await.unwrap(), r#"{"status":"shedding"}"#);
}

/// Formerly empty: the request timeout's `408`. Driven directly, since the
/// shortest configurable timeout is a whole second of wall clock.
#[tokio::test]
async fn issue_5750_empty_error_bodies_get_the_reason_phrase() {
    let timeout = Response::builder().status(StatusCode::REQUEST_TIMEOUT).body(Body::empty()).unwrap();
    let body = envelope(envelope_errors(timeout).await).await;
    assert_eq!(body["code"], "REQUEST_TIMEOUT");
    assert_eq!(body["error"], "Request Timeout");
}

/// A `2xx`/`3xx` is never touched, whatever its body.
#[tokio::test]
async fn success_bodies_are_never_rewritten() {
    for status in [StatusCode::OK, StatusCode::ACCEPTED, StatusCode::NOT_MODIFIED] {
        let response = Response::builder().status(status).body(Body::from("plain")).unwrap();
        let wrapped = envelope_errors(response).await;
        assert_eq!(wrapped.status(), status);
        assert_eq!(to_bytes(wrapped.into_body(), usize::MAX).await.unwrap(), "plain");
    }
}

/// The statuses `ApiError` also produces keep its code spelling, so one
/// condition has one code whichever layer answered it.
#[test]
fn shared_statuses_keep_the_api_error_codes() {
    assert_eq!(code_for_status(StatusCode::INTERNAL_SERVER_ERROR), "INTERNAL_ERROR");
    assert_eq!(code_for_status(StatusCode::PAYLOAD_TOO_LARGE), "FILE_TOO_LARGE");
    assert_eq!(code_for_status(StatusCode::SERVICE_UNAVAILABLE), "OVERLOADED");
    assert_eq!(code_for_status(StatusCode::UNSUPPORTED_MEDIA_TYPE), "UNSUPPORTED_MEDIA_TYPE");
    assert_eq!(code_for_status(StatusCode::from_u16(599).unwrap()), "HTTP_599");
}

/// The panic catcher answers with the envelope and never the payload, which
/// is file-derived text.
#[tokio::test]
async fn a_caught_panic_is_the_envelope_without_its_payload() {
    let response = panic_response(Box::new("secret payload from a malformed file".to_owned()));
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = envelope(response).await;
    assert_eq!(body["code"], "INTERNAL_ERROR");
    assert!(!body.to_string().contains("secret payload"), "{body}");
}
