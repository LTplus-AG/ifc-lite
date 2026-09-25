// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `POST /api/v1/parse/parquet/optimized?sha256=...` with NO request body
//! (issue #5128), the same shape as the flat route's probe (issue #3901,
//! `parquet_stream_hash_only_tests.rs`).
//!
//! Before this, the optimized route had no way to be asked for a cached
//! response by hash at all: `parse_parquet_optimized` took `Multipart`
//! unconditionally, so a bare `?sha256=` request with no body failed
//! multipart parsing before the handler ever ran, and every other route this
//! issue's reporter tried (`cache/check`, `cache/geometry`, `cache/{key}`)
//! either does not know about this artifact or 500s on it.

use super::*;
use crate::services::cache::DiskCache;
use serde_json::Value;

/// SHA-256 of `content`, in the hex shape the cache key is built from.
fn digest(content: &[u8]) -> String {
    DiskCache::generate_key(content)
}

/// Drive the route with a `sha256` query parameter and NO multipart body at
/// all: no `Content-Type`, no bytes.
async fn hash_only_request(state: &AppState, sha256: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/parse/parquet/optimized?sha256={sha256}"))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

/// Read a response into `(status, X-IFC-Metadata, body)`, matching
/// `post_to`'s shape so hash-only and upload responses compare directly.
async fn read_response(response: axum::response::Response) -> (StatusCode, String, Vec<u8>) {
    let status = response.status();
    let metadata = response
        .headers()
        .get("X-IFC-Metadata")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, metadata, body.to_vec())
}

/// The shape guard. The hash is concatenated into a cache key, so a value
/// that is not a bare digest is a caller-shaped key: `sha256=<key>-datamodel-v8`
/// would address another request's data-model slot through the optimized
/// reader. Anything but 64 lowercase hex characters is a `400`, not a lookup.
#[tokio::test]
async fn optimized_probe_rejects_non_digest_with_400() {
    let state = test_state("optimized-hash-shape").await;
    let real = digest(MINIMAL_IFC.as_bytes());
    for bogus in [
        "not-a-hash",
        // Right alphabet, wrong length.
        "abc123",
        // A well-formed digest with a namespace suffix glued on.
        &format!("{real}-default-datamodel-v8"),
        // Uppercase: `DiskCache::generate_key` only ever emits lowercase.
        &real.to_uppercase(),
    ] {
        let response = hash_only_request(&state, bogus).await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{bogus} must be rejected on shape, not looked up"
        );
    }
}

/// Property: nothing cached means `404` and no parse ran.
///
/// `404` is the status `GET /api/v1/cache/check/{hash}` already uses for
/// "upload it" (and what the flat route's own probe answers), so a client
/// that understands one understands the other. The second half is what stops
/// the parameter from becoming a way to make the server do work for a body it
/// never received: after the miss, nothing is cached under the key the hash
/// names.
#[tokio::test]
async fn optimized_probe_404_when_nothing_cached() {
    let state = test_state("optimized-hash-miss").await;
    let content = MINIMAL_IFC.as_bytes();
    let hash = digest(content);
    let cache_key =
        request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());

    let (status, _, body) = read_response(hash_only_request(&state, &hash).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!("NOT_FOUND"));
    assert!(
        json["error"].as_str().unwrap_or("").contains("multipart"),
        "the miss has to tell the client to send the body, got {json}"
    );

    // Built from the shared key helpers, not repeated as literal suffixes, so
    // a suffix bump moves this fixture with the route instead of leaving it
    // asserting `Ok(None)` for a key nobody would ever write either way.
    for key in [
        parquet_optimized_cache_key(&cache_key),
        parquet_optimized_metadata_cache_key(&cache_key),
        symbolic_cache_key(&cache_key),
    ] {
        assert!(
            matches!(state.cache.get_bytes(&key).await, Ok(None)),
            "a hash-only miss must not have parsed or cached anything ({key})"
        );
    }
}

/// The headline property: a hash-only hit is indistinguishable from the
/// upload that warmed the entry -- same status, same `X-IFC-Metadata` header
/// (`optimization_stats` included; only `stats.from_cache` differs, #5542),
/// same body bytes.
#[tokio::test]
async fn optimized_probe_replays_after_upload() {
    let state = test_state("optimized-hash-replay").await;
    let content = MINIMAL_IFC.as_bytes();

    let (status, upload_metadata, upload_body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !upload_body.is_empty(),
        "the live parse must return a payload"
    );

    let hash = digest(content);
    let (status, probe_metadata, probe_body) =
        read_response(hash_only_request(&state, &hash).await).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a warm entry must be replayable from the hash alone"
    );
    // Same header the upload's live parse reported, except that a hit says
    // it is one (#5542).
    let upload: serde_json::Value = serde_json::from_str(&upload_metadata).unwrap();
    let probe: serde_json::Value = serde_json::from_str(&probe_metadata).unwrap();
    assert_eq!(probe["stats"]["from_cache"], true, "a hash-only hit is a cache hit");
    let mut expected = upload;
    expected["stats"]["from_cache"] = serde_json::Value::Bool(true);
    assert_eq!(
        probe, expected,
        "a hash-only hit must otherwise report the same X-IFC-Metadata header"
    );
    assert_eq!(
        probe_body, upload_body,
        "a hash-only hit must replay the same bytes an upload hit produced"
    );
}

/// The probe path applies the same #3869/#5129 rule the upload path does
/// (`try_cached_optimized_parquet`, called from both): a hash-only request
/// for an entry warmed before a current data model exists must 404, not
/// replay a geometry-only response with no data model behind it. Deleting
/// only the data-model entry (built via `data_model_cache_key`, never a
/// literal, so a suffix bump moves this fixture with the route) simulates a
/// cache warmed by a pre-#5129 deployment.
#[tokio::test]
async fn optimized_probe_requires_current_data_model() {
    let state = test_state("optimized-hash-stale-data-model").await;
    let content = MINIMAL_IFC.as_bytes();

    let (status, _, _) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);

    let cache_key =
        request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());
    let dm_key = data_model_cache_key(&cache_key);
    state
        .cache
        .remove(&dm_key)
        .await
        .expect("remove the data-model entry");
    assert!(
        state.cache.get_bytes(&dm_key).await.unwrap().is_none(),
        "fixture must start with no current data model"
    );

    let hash = digest(content);
    let response = hash_only_request(&state, &hash).await;
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "a probe for an entry with no current data model must not replay"
    );
}

/// Neither a body nor a hash: there is nothing to identify a file with. Making
/// the multipart body optional must not turn a request with neither into a
/// `500` or a hang -- it is the same `400 MISSING_FILE` a body with no `file`
/// field already answers.
#[tokio::test]
async fn a_request_with_neither_body_nor_hash_is_a_missing_file() {
    let state = test_state("optimized-hash-neither").await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/parquet/optimized")
        .body(Body::empty())
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!("MISSING_FILE"));
}

/// A bot-review concern on this PR: does `Option<Multipart>` turn a
/// genuinely malformed multipart request into a silent probe hit just
/// because it also carries `?sha256=` for an entry that happens to be
/// cached? It does not, and this pins why: axum's
/// `OptionalFromRequest for Multipart` (`axum::extract::multipart`) maps
/// `None` only when `Content-Type` is missing or is not
/// `multipart/form-data` at all (`multer::Error::NoMultipart`) --
/// `Content-Type: multipart/form-data` with no `boundary` parameter is a
/// DIFFERENT failure (`multer::Error::NoBoundary`), which the extractor
/// turns into a real `MultipartRejection::InvalidBoundary` (400) instead of
/// `None`. So a request that actually attempts a multipart upload, however
/// malformed, is rejected before the handler runs and never reaches the
/// probe branch; only a request that never looked like multipart at all
/// (no `Content-Type`, or a non-multipart one) does, which is the same "no
/// body" case this and the flat route's probe were built to answer.
#[tokio::test]
async fn a_malformed_multipart_boundary_alongside_a_cached_hash_is_rejected_not_replayed() {
    let state = test_state("optimized-hash-malformed-boundary").await;
    let content = MINIMAL_IFC.as_bytes();

    // Warm a real entry so a silent probe-hit would be observable as a 200.
    let (status, _, _) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    let hash = digest(content);

    // `multipart/form-data` with no `boundary` parameter: a genuine (if
    // malformed) multipart attempt, not the "no Content-Type at all" shape
    // the probe is meant for.
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/parse/parquet/optimized?sha256={hash}"))
        .header(header::CONTENT_TYPE, "multipart/form-data")
        .body(Body::from(b"whatever".to_vec()))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();

    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "a malformed multipart request must be rejected (axum's own \
         InvalidBoundary), not silently replayed as a hash-only probe hit"
    );
}
