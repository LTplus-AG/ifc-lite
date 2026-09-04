// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `POST /api/v1/parse/parquet-stream?sha256=...` with NO request body
//! (issue #3901).
//!
//! Before this, a cache hit on the streaming route still paid the full upload:
//! the key is the SHA-256 of the received bytes, so `extract_file` had to run
//! before the cache could be consulted. These tests pin the three properties
//! that make presenting a hash instead safe:
//!
//! 1. A hash-only HIT replays byte-for-byte the same SSE events an upload hit
//!    replays. If it did not, the parameter would be a second, divergent
//!    transport for the same data.
//! 2. A hash-only MISS answers `404` and runs no parse. A probe must not be a
//!    way to make the server do work, and the client has to be told to upload.
//! 3. A hash sent ALONGSIDE a body is ignored. The client's claim about its
//!    bytes never decides which entry is read or written.

use super::*;
use crate::services::cache::DiskCache;

/// SHA-256 of `content`, in the hex shape the cache key is built from.
fn digest(content: &str) -> String {
    DiskCache::generate_key(content.as_bytes())
}

/// Drive the route with a `sha256` query parameter and NO multipart body at
/// all: no `Content-Type`, no bytes. That absence is the point of the feature,
/// so the test has to send a genuinely empty request rather than an empty
/// multipart envelope.
async fn hash_only_request(state: &AppState, sha256: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/v1/parse/parquet-stream?sha256={sha256}"
        ))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

/// Read an SSE response body into its JSON events.
async fn sse_events(response: axum::response::Response) -> Vec<Value> {
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        to_bytes(response.into_body(), usize::MAX),
    )
    .await
    .expect("SSE stream should finish")
    .unwrap();
    parse_sse_events(std::str::from_utf8(&bytes).unwrap())
}

/// Warm the cache by parsing `content` through the real route, then wait until
/// every entry `try_cached_replay` needs has actually landed. The geometry,
/// metadata, data model and progress sidecar are all written by tasks spawned
/// off the `Complete` event, so without this wait a follow-up request re-parses
/// and any comparison is between two live runs, which matches for every
/// implementation of the replay including none.
async fn warm_cache(state: &AppState, content: &str) -> String {
    let live = stream_once(state, content).await;
    let key = live
        .iter()
        .find(|e| e["type"] == "start")
        .expect("live run must emit start")["cache_key"]
        .as_str()
        .unwrap()
        .to_string();
    let required = [
        format!("{key}-parquet-v5"),
        format!("{key}-parquet-metadata-v4"),
        crate::routes::parse::cache_keys::data_model_cache_key(&key),
        crate::routes::parse::stream_progress::stream_progress_cache_key(&key),
    ];
    for _ in 0..200 {
        let mut all = true;
        for k in &required {
            if !matches!(state.cache.get_bytes(k).await, Ok(Some(_))) {
                all = false;
            }
        }
        if all {
            return key;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("cache fill never completed for {key}");
}

/// Property 1: the hash-only hit is the SAME stream as the upload hit.
///
/// Both requests replay from the same cache entries, so every event — start,
/// each batch's base64 payload and counters, each progress checkpoint, the
/// complete stats and metadata — has to be identical. The only difference is
/// that one of them sent 0 bytes of file.
#[tokio::test]
async fn a_hash_only_hit_replays_the_same_events_as_an_upload_hit() {
    let state = test_state("hash-only-hit").await;
    let key = warm_cache(&state, JOBS_NE_MESHES_FIXTURE).await;

    let upload_hit = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;

    let response = hash_only_request(&state, &digest(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "a warm entry must be replayable from the hash alone"
    );
    let hash_only = sse_events(response).await;

    // Anti-vacuity: two empty vectors are also equal. A replay of this fixture
    // carries a batch with real Parquet bytes and a terminal complete.
    assert!(
        hash_only.iter().any(|e| e["type"] == "batch"
            && !e["data"].as_str().unwrap_or("").is_empty()),
        "replay must carry at least one non-empty batch, got {hash_only:?}"
    );
    assert!(hash_only.iter().any(|e| e["type"] == "complete"));

    assert_eq!(
        hash_only, upload_hit,
        "a hash-only hit must be indistinguishable from an upload hit"
    );
    assert_eq!(
        hash_only[0]["cache_key"].as_str().unwrap(),
        key,
        "the replay must be keyed by the same request cache key the upload produced"
    );
}

/// Property 2: nothing cached means `404` and no parse.
///
/// `404` is the status `GET /api/v1/cache/check/{hash}` already uses for
/// "upload it", so a client that understands one understands the other.
///
/// The second half is what stops the parameter from becoming a way to make the
/// server work for a body it never received: after the miss, the cache must
/// still be empty for that key. A route that fell through to parsing something
/// would leave entries behind.
#[tokio::test]
async fn a_hash_only_miss_answers_404_and_runs_no_parse() {
    let state = test_state("hash-only-miss").await;
    let hash = digest(JOBS_NE_MESHES_FIXTURE);

    let response = hash_only_request(&state, &hash).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!("NOT_FOUND"));
    assert!(
        json["error"].as_str().unwrap_or("").contains("multipart"),
        "the miss has to tell the client to send the body, got {json}"
    );

    // No parse ran, so nothing was written under the key the hash names.
    let key = format!("{hash}-default");
    for suffix in ["-parquet-v5", "-parquet-v6", "-parquet-metadata-v4"] {
        assert!(
            matches!(
                state.cache.get_bytes(&format!("{key}{suffix}")).await,
                Ok(None)
            ),
            "a hash-only miss must not have parsed or cached anything ({suffix})"
        );
    }
}

/// Property 3: with a body present, the body wins.
///
/// The hash is a SELECTOR for entries that already exist, never an assertion
/// about the bytes. A request that uploads one file while claiming the hash of
/// another must read and write the entry its BYTES name — otherwise a client
/// could poison one file's cache slot with another file's geometry.
#[tokio::test]
async fn a_hash_that_contradicts_the_uploaded_body_still_keys_off_the_body() {
    let state = test_state("hash-vs-body").await;

    // A real digest, of a DIFFERENT file. Well-formed, so it passes the shape
    // guard and only the precedence rule can reject it.
    let lie = digest(TWO_WALL_FIXTURE);
    let truth = digest(JOBS_NE_MESHES_FIXTURE);
    assert_ne!(lie, truth, "the two fixtures must hash differently");

    let (content_type, body) = multipart_body(JOBS_NE_MESHES_FIXTURE.as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/parse/parquet-stream?sha256={lie}"))
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let events = sse_events(response).await;
    let cache_key = events
        .iter()
        .find(|e| e["type"] == "start")
        .expect("upload must emit start")["cache_key"]
        .as_str()
        .unwrap()
        .to_string();

    assert!(
        cache_key.starts_with(&truth),
        "the cache key must come from the uploaded bytes, got {cache_key}"
    );
    assert!(
        !cache_key.starts_with(&lie),
        "the client-supplied hash must not select the entry when a body is present"
    );
}

/// The shape guard. The hash is concatenated into a cache key, so a value that
/// is not a bare digest is a caller-shaped key: `sha256=<key>-datamodel-v6`
/// would address another request's data-model slot through the geometry
/// reader. Anything but 64 lowercase hex characters is a `400`, not a lookup.
#[tokio::test]
async fn a_sha256_that_is_not_a_bare_digest_is_rejected() {
    let state = test_state("hash-only-shape").await;
    for bogus in [
        "not-a-hash",
        // Right alphabet, wrong length.
        "abc123",
        // A well-formed digest with a namespace suffix glued on.
        &format!("{}-default-datamodel-v6", digest(TWO_WALL_FIXTURE)),
        // Uppercase: `DiskCache::generate_key` only ever emits lowercase, so
        // accepting this would make two spellings of one file.
        &digest(TWO_WALL_FIXTURE).to_uppercase(),
    ] {
        let response = hash_only_request(&state, bogus).await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{bogus} must be rejected on shape, not looked up"
        );
    }
}

/// Neither a body nor a hash: there is nothing to identify a file with. This is
/// the same `400 MISSING_FILE` a multipart body with no `file` field answers,
/// and making the body optional must not turn it into a `500` or a hang.
#[tokio::test]
async fn a_request_with_neither_body_nor_hash_is_a_missing_file() {
    let state = test_state("hash-only-neither").await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/parquet-stream")
        .body(Body::empty())
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!("MISSING_FILE"));
}
