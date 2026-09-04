// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Route-level tests for the optimized-Parquet endpoint's cache
//! (`parse_parquet_optimized`, `POST /api/v1/parse/parquet/optimized`),
//! added with issue #3889: the route had no cache key of its own, so every
//! request re-parsed the file while the flat route beside it replayed.
//!
//! The proof that a repeat request does NOT parse is a sentinel: after a real
//! request warms the cache, the stored body is overwritten with bytes no parse
//! could ever produce. A second identical request that answers with those bytes
//! read them off disk; one that parses answers with real Parquet instead.

use super::cache_keys::{
    data_model_cache_key, parquet_cache_key, parquet_metadata_cache_key,
    parquet_optimized_cache_key, parquet_optimized_metadata_cache_key, request_cache_key,
    symbolic_cache_key,
};
use super::ParseQuery;
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::services::OpeningFilterMode;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use ifc_lite_processing::TessellationQuality;
use std::sync::Arc;
use tower::ServiceExt;

const BOUNDARY: &str = "ifclite-3889-optimized-boundary";

/// Bytes no optimized-Parquet serialization could ever emit (a real payload
/// starts with the Parquet magic `PAR1`), so seeing them in a response is
/// unambiguous evidence the response came from the cache.
const SENTINEL_BODY: &[u8] = b"SENTINEL-OPTIMIZED-BODY-NOT-PARQUET";

/// A minimal but real IFC file: the fall-through parse must actually succeed,
/// so a failed assertion below is about the cache gate, not a parse error.
const MINIMAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3889 optimized cache fixture'),'2;1');
FILE_NAME('opt.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn multipart_body(content: &[u8]) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-3889-optimized-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    AppState {
        cache,
        config: Arc::new(Config::from_env()),
        admission: Arc::new(crate::admission::Admission::new(
            crate::admission::AdmissionCfg {
                max_concurrent_parses: 4,
                mem_budget_bytes: 0,
                queue_depth: 8,
                queue_timeout: std::time::Duration::from_millis(100),
                shed_pct: 85,
            },
        )),
    }
}

/// Issue an optimized-Parquet request against `state` and return
/// `(status, X-IFC-Metadata, body)`.
async fn post_optimized(state: &AppState, content: &[u8]) -> (StatusCode, String, Vec<u8>) {
    post_to(state, "/api/v1/parse/parquet/optimized", content).await
}

async fn post_to(state: &AppState, uri: &str, content: &[u8]) -> (StatusCode, String, Vec<u8>) {
    let (content_type, body) = multipart_body(content);
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let metadata = response
        .headers()
        .get("X-IFC-Metadata")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, metadata, body.to_vec())
}

/// The headline behaviour from #3889: a second identical request must be a
/// disk read, not a parse.
///
/// The first request warms the cache; its body is then replaced with bytes no
/// parse can produce. If the second request re-parsed (the pre-fix behaviour,
/// where the route had no key at all) it would answer with real Parquet and
/// this fails.
#[tokio::test]
async fn a_second_identical_optimized_request_replays_without_parsing() {
    let state = test_state("replays").await;
    let content = MINIMAL_IFC.as_bytes();
    let cache_key = request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());

    let (status, first_metadata, first_body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!first_body.is_empty(), "the live parse must return a payload");

    // The write is synchronous, so the entries are there the moment the first
    // response is in hand -- no sleep, no polling.
    let body_key = parquet_optimized_cache_key(&cache_key);
    let stored = state
        .cache
        .get_bytes(&body_key)
        .await
        .unwrap()
        .expect("the optimized body must be cached after the first request");
    assert_eq!(stored, first_body, "the cached body must be what was served");

    state
        .cache
        .set_bytes(&body_key, SENTINEL_BODY)
        .await
        .expect("overwrite the cached body with a sentinel");

    let (status, second_metadata, second_body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        second_body, SENTINEL_BODY,
        "the second request re-parsed instead of replaying the cached body"
    );
    assert_eq!(
        second_metadata, first_metadata,
        "a replay must report the same metadata header (optimization_stats included)"
    );
}

/// A hit on the flat route must NOT make the optimized route think it is
/// cached. The two emit different payloads (quantized vertices, deduplicated
/// shapes), so serving one where the other is expected is a decode error at
/// best and a wrong model at worst.
#[tokio::test]
async fn a_cached_flat_response_does_not_satisfy_the_optimized_route() {
    let state = test_state("flat-does-not-satisfy-optimized").await;
    let content = MINIMAL_IFC.as_bytes();
    let cache_key = request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());

    // Everything the FLAT route's cache hit needs, and nothing else. Built
    // from the shared key helpers, so a flat-suffix bump moves this fixture
    // with the route instead of leaving it seeding a dead key.
    let hash = DiskCache::generate_key(content);
    let flat_key = parquet_cache_key(
        &hash,
        OpeningFilterMode::Default,
        TessellationQuality::default(),
    );
    let flat_metadata_key = parquet_metadata_cache_key(
        &hash,
        OpeningFilterMode::Default,
        TessellationQuality::default(),
    );
    for (key, value) in [
        (flat_key, b"FLAT-GEOMETRY".as_slice()),
        (flat_metadata_key, b"{}".as_slice()),
        (data_model_cache_key(&cache_key), b"FLAT-DATA-MODEL".as_slice()),
        (symbolic_cache_key(&cache_key), b"{}".as_slice()),
    ] {
        state.cache.set_bytes(&key, value).await.expect("seed flat entry");
    }

    // Anti-vacuity: the flat entries really are a hit for the flat route.
    let (status, _, flat_body) = post_to(&state, "/api/v1/parse/parquet", content).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        flat_body, b"FLAT-GEOMETRY",
        "fixture is wrong: the flat route did not treat its seeded entries as a hit"
    );

    let (status, metadata, body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(
        body, b"FLAT-GEOMETRY",
        "the optimized route served the flat route's cached body"
    );
    assert!(
        metadata.contains("optimization_stats"),
        "the optimized route must have parsed and emitted its own header, got: {metadata}"
    );
}

/// And the reverse: a cached optimized response must not be served by the flat
/// route, whose clients decode a different format.
#[tokio::test]
async fn a_cached_optimized_response_does_not_satisfy_the_flat_route() {
    let state = test_state("optimized-does-not-satisfy-flat").await;
    let content = MINIMAL_IFC.as_bytes();
    let cache_key = request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());

    for (key, value) in [
        (parquet_optimized_cache_key(&cache_key), SENTINEL_BODY),
        (
            parquet_optimized_metadata_cache_key(&cache_key),
            b"{}".as_slice(),
        ),
        (symbolic_cache_key(&cache_key), b"{}".as_slice()),
    ] {
        state
            .cache
            .set_bytes(&key, value)
            .await
            .expect("seed optimized entry");
    }

    // Anti-vacuity: those entries really are a hit for the optimized route.
    let (status, _, optimized_body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        optimized_body, SENTINEL_BODY,
        "fixture is wrong: the optimized route did not treat its seeded entries as a hit"
    );

    let (status, _, body) = post_to(&state, "/api/v1/parse/parquet", content).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(
        body, SENTINEL_BODY,
        "the flat route served the optimized route's cached body"
    );
}

/// The optimized parse is what writes the symbolic sidecar, so a body entry
/// that outlived its sidecar must re-parse rather than replay. Otherwise the
/// client's `GET /api/v1/parse/symbolic/{cache_key}` polls a key nobody ever
/// writes -- the shape of #3869, one route over.
#[tokio::test]
async fn an_optimized_hit_with_no_symbolic_sidecar_re_parses_and_writes_one() {
    let state = test_state("missing-symbolic").await;
    let content = MINIMAL_IFC.as_bytes();
    let cache_key = request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());
    let symbolic_key = symbolic_cache_key(&cache_key);

    state
        .cache
        .set_bytes(&parquet_optimized_cache_key(&cache_key), SENTINEL_BODY)
        .await
        .expect("seed optimized body");
    state
        .cache
        .set_bytes(
            &parquet_optimized_metadata_cache_key(&cache_key),
            b"{\"stale\":true}",
        )
        .await
        .expect("seed optimized metadata");

    // Anti-vacuity: the sidecar really is absent before the request.
    assert!(
        state.cache.get_bytes(&symbolic_key).await.unwrap().is_none(),
        "fixture must start with no symbolic sidecar"
    );

    let (status, _, body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(
        body, SENTINEL_BODY,
        "a body with no symbolic sidecar must re-parse, not replay"
    );
    assert!(
        state.cache.get_bytes(&symbolic_key).await.unwrap().is_some(),
        "the re-parse must write the symbolic sidecar"
    );
}

/// A body cached with no metadata beside it is a miss, not a 500 and not a
/// response with an empty header: the client reads `cache_key`,
/// `vertex_multiplier` and `optimization_stats` out of that header and cannot
/// decode the payload without them.
#[tokio::test]
async fn an_optimized_body_with_no_metadata_re_parses() {
    let state = test_state("body-without-metadata").await;
    let content = MINIMAL_IFC.as_bytes();
    let cache_key = request_cache_key(content, &ParseQuery::default(), TessellationQuality::default());

    state
        .cache
        .set_bytes(&parquet_optimized_cache_key(&cache_key), SENTINEL_BODY)
        .await
        .expect("seed optimized body");
    state
        .cache
        .set_bytes(&symbolic_cache_key(&cache_key), b"{}")
        .await
        .expect("seed symbolic sidecar");

    let (status, metadata, body) = post_optimized(&state, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(body, SENTINEL_BODY, "a body with no metadata must re-parse");
    assert!(
        metadata.contains("vertex_multiplier"),
        "the re-parse must emit a full metadata header, got: {metadata}"
    );
}

/// Different files must not share an optimized entry: the second request's
/// content differs, so it parses rather than replaying the first one's body.
#[tokio::test]
async fn a_different_file_does_not_hit_the_first_files_optimized_entry() {
    let state = test_state("different-file").await;
    let first = MINIMAL_IFC.as_bytes();
    let second = MINIMAL_IFC.replace("'W1'", "'W2'");

    let (status, _, _) = post_optimized(&state, first).await;
    assert_eq!(status, StatusCode::OK);

    let first_key =
        request_cache_key(first, &ParseQuery::default(), TessellationQuality::default());
    state
        .cache
        .set_bytes(&parquet_optimized_cache_key(&first_key), SENTINEL_BODY)
        .await
        .expect("mark the first file's entry");

    let (status, _, body) = post_optimized(&state, second.as_bytes()).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(
        body, SENTINEL_BODY,
        "a different file read the first file's cached body"
    );
}
