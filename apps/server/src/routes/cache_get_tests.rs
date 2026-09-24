// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `GET /api/v1/cache/:key` against an entry that is not a JSON
//! `ParseResponse` (issue #5128).
//!
//! Before this, `get_cached` deserialized whatever `DiskCache::get` read as
//! `ParseResponse` unconditionally, via `?`. A binary Parquet body cached
//! under its real key (`-parquet-v5`, `-parquet-v7`, `-parquet-optimized-v2`)
//! is not JSON, so `serde_json::from_slice` fails, `From<serde_json::Error>`
//! turns that into `ApiError::Internal`, and the client sees a `500` on a key
//! that genuinely exists -- the reporter's `GET /cache/{sha}-default-parquet-optimized-v1`
//! reproduction. The fix is a decode failure answers the same `404` a key
//! that was never written already does; the general fixture here (raw
//! non-JSON bytes) stands in for any of those binary entries without needing
//! a real Parquet blob.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-5128-cache-get-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    let mut config = Config::from_env();
    config.api_token = None;
    AppState {
        cache,
        config: Arc::new(config),
        admission: Arc::new(crate::admission::Admission::new(
            crate::admission::AdmissionCfg {
                max_concurrent_parses: 4,
                mem_budget_bytes: 0,
                queue_depth: 8,
                queue_timeout: std::time::Duration::from_millis(100),
                shed_pct: 85,
            },
        )),
        data_model_in_flight: Arc::new(crate::in_flight::InFlightKeys::default()),
    }
}

async fn get_cache(state: &AppState, key: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/cache/{key}"))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

#[tokio::test]
async fn get_cached_answers_404_for_non_json_entry() {
    let state = test_state("non-json").await;
    let key = "2222222222222222222222222222222222222222222222222222222222222222-default";
    // Since #5542 the route reads the JSON response slot for `key`, so a
    // binary Parquet key is simply absent there; seed the undecodable bytes
    // in that slot to keep the decode-failure branch itself under test.
    state
        .cache
        .set_bytes(&crate::routes::parse::cache_keys::json_response_cache_key(key), b"not json")
        .await
        .expect("seed a non-JSON entry");

    let response = get_cache(&state, key).await;
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "an entry present on disk but not a ParseResponse must 404, not 500"
    );

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!("NOT_FOUND"));
}

const BOUNDARY: &str = "ifclite-5542-cache-get-boundary";

/// A minimal but real IFC file, so the JSON parse the test drives succeeds.
const MINIMAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-5542 cache-get fixture'),'2;1');
FILE_NAME('get.ifc','2026-09-24T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// #5542: `getCached(result.cache_key)` is the client's documented call, and
/// it could never hit. `POST /api/v1/parse` returns the request `cache_key`
/// and stores its response under `json_response_cache_key(cache_key)`
/// (`{cache_key}-json-v5`); this route looked the key up unchanged, so it
/// answered 404 for every file the JSON route had cached.
///
/// Driven through both real routes rather than a seeded entry, so it pins the
/// writer and the reader to the same key: a future bump of one without the
/// other fails here.
#[tokio::test]
async fn issue_5542_get_cached_serves_the_cache_key_the_json_parse_returned() {
    let state = test_state("5542-parse-then-get").await;

    let mut multipart = Vec::new();
    multipart.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"get.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    multipart.extend_from_slice(MINIMAL_IFC.as_bytes());
    multipart.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse")
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(multipart))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let parsed: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let cache_key = parsed["cache_key"].as_str().expect("parse returns a cache_key").to_owned();
    assert_eq!(parsed["stats"]["from_cache"], false);

    // The parse route writes its cache entry in a background task, so poll
    // for it rather than racing it. Bounded: a key nobody writes stays 404.
    let mut last = StatusCode::NOT_FOUND;
    for _ in 0..200 {
        let response = get_cache(&state, &cache_key).await;
        last = response.status();
        if last == StatusCode::OK {
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let cached: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(cached["cache_key"], parsed["cache_key"]);
            assert_eq!(cached["stats"]["from_cache"], true);
            assert_eq!(cached["meshes"], parsed["meshes"], "the cached response is the parsed one");
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("GET /api/v1/cache/{cache_key} never hit (last status {last}); the parse route's entry is unreachable by the key it returned");
}

/// `POST /api/v1/parse` for `MINIMAL_IFC`, then poll `GET` until its cache
/// write lands. Returns the parsed response's `cache_key`.
async fn parse_and_wait_for_cache(state: &AppState) -> String {
    let mut multipart = Vec::new();
    multipart.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"get.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    multipart.extend_from_slice(MINIMAL_IFC.as_bytes());
    multipart.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse")
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(multipart))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let parsed: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let cache_key = parsed["cache_key"].as_str().expect("parse returns a cache_key").to_owned();
    for _ in 0..200 {
        if get_cache(state, &cache_key).await.status() == StatusCode::OK {
            return cache_key;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the parse route's cache entry for {cache_key} never became readable");
}

async fn delete_cache(state: &AppState, key: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/cache/{key}"))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

/// #5750: `GET` and `DELETE /api/v1/cache/{key}` take one key space. The
/// `cache_key` a parse returned hits on `GET`, is accepted by `DELETE` (which
/// used to answer `400` because it wanted the bare file digest), and after
/// the `DELETE` the same `GET` misses: the two routes named the same entry.
#[tokio::test]
async fn issue_5750_get_and_delete_take_the_same_cache_key() {
    let state = test_state("5750-one-key-space").await;
    let cache_key = parse_and_wait_for_cache(&state).await;

    let deleted = delete_cache(&state, &cache_key).await;
    assert_eq!(deleted.status(), StatusCode::OK, "DELETE must accept the key GET just served");
    let body: Value =
        serde_json::from_slice(&to_bytes(deleted.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["key"], Value::from(cache_key.clone()));
    assert!(body["deleted"].as_u64().unwrap() >= 1, "nothing was removed: {body}");

    assert_eq!(
        get_cache(&state, &cache_key).await.status(),
        StatusCode::NOT_FOUND,
        "the entry GET served is the one DELETE removed"
    );
}

/// #5750: the two routes refuse the same keys, with the same body. A bare
/// digest (what `DELETE` used to take) and a storage key (what `GET` used to
/// take, before #5542) are each refused by both, so neither route can drift
/// back into a key space of its own.
#[tokio::test]
async fn issue_5750_get_and_delete_refuse_the_same_keys() {
    let state = test_state("5750-same-refusals").await;
    let digest = "0".repeat(64);
    for key in [digest.clone(), format!("{digest}-default-json-v5"), "not-a-key".to_owned()] {
        let get = get_cache(&state, &key).await;
        let delete = delete_cache(&state, &key).await;
        assert_eq!(get.status(), StatusCode::BAD_REQUEST, "GET {key}");
        assert_eq!(delete.status(), StatusCode::BAD_REQUEST, "DELETE {key}");
        let get_body = to_bytes(get.into_body(), usize::MAX).await.unwrap();
        let delete_body = to_bytes(delete.into_body(), usize::MAX).await.unwrap();
        assert_eq!(get_body, delete_body, "{key}: one resolver, one refusal");
    }
}

/// #5750: a cache `GET` decodes and re-encodes the whole stored model, so it
/// holds a parse admission slot like the parse route. With every slot taken
/// and no queue, a hit is shed with `503` + `Retry-After` instead of starting
/// another whole-model working set; a miss is answered without a slot; and
/// the same hit goes through once the slot is released.
#[tokio::test]
async fn issue_5750_cache_get_takes_a_parse_admission_slot() {
    let mut state = test_state("5750-admission").await;
    let cache_key = parse_and_wait_for_cache(&state).await;

    state.admission = Arc::new(crate::admission::Admission::new(crate::admission::AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 0,
        queue_depth: 0,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct: 85,
    }));
    let held = state.admission.acquire(0).await.expect("the only slot is free");

    let shed = get_cache(&state, &cache_key).await;
    assert_eq!(shed.status(), StatusCode::SERVICE_UNAVAILABLE, "a hit with no free slot must be shed");
    assert!(shed.headers().get(axum::http::header::RETRY_AFTER).is_some());
    let body: Value = serde_json::from_slice(&to_bytes(shed.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["code"], "OVERLOADED");

    let miss = get_cache(&state, &format!("{}-default", "0".repeat(64))).await;
    assert_eq!(miss.status(), StatusCode::NOT_FOUND, "a miss must not need a slot");

    drop(held);
    assert_eq!(get_cache(&state, &cache_key).await.status(), StatusCode::OK);
}
