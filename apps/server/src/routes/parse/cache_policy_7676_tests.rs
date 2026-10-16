// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One policy for an unusable cache entry, and status codes that mean what
//! they say (#7676: SERVER-12, SERVER-21, SERVER-22).
//!
//! An entry can be unusable without the store being broken: an interrupted
//! write or a partial GC leaves an index row whose content fails cacache's
//! integrity check. That is a miss on every route. A route with the upload
//! in hand re-parses and overwrites it; a read-only route answers its miss
//! status. Answering 500 instead breaks that file on that route forever,
//! because the parse that would repair the entry is exactly what the error
//! skips.

use super::*;
use crate::routes::parse::cache_keys::{
    data_model_cache_key, json_response_cache_key, parquet_geometry_key, parquet_metadata_key,
    parquet_optimized_cache_key, symbolic_cache_key,
};
use crate::services::{DataModelEntities, ParquetLayout};
use std::time::Duration;

async fn send(state: &AppState, method: &str, uri: &str, file: Option<&str>) -> axum::response::Response {
    let builder = Request::builder().method(method).uri(uri);
    let request = match file {
        Some(content) => {
            let (content_type, body) = multipart_body(content.as_bytes());
            builder.header(header::CONTENT_TYPE, content_type).body(Body::from(body))
        }
        None => builder.body(Body::empty()),
    }
    .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

async fn drain(response: axum::response::Response) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(10), to_bytes(response.into_body(), usize::MAX))
        .await
        .expect("body should finish")
        .unwrap()
        .to_vec()
}

/// Overwrite `key`'s stored content with same-length garbage, leaving its
/// index row intact: what a torn write leaves behind. cacache's content
/// layout is private, so it is mirrored here the way `cache_tests` does.
async fn damage(state: &AppState, key: &str) {
    let dir = state.cache.dir_for_tests();
    let entry = cacache::index::find_async(dir, key)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("no index row for {key} to damage"));
    let (algo, hex) = entry.integrity.to_hex();
    let path = dir
        .join("content-v2")
        .join(algo.to_string())
        .join(&hex[0..2])
        .join(&hex[2..4])
        .join(&hex[4..]);
    let len = std::fs::metadata(&path).unwrap().len() as usize;
    let _ = std::fs::remove_file(&path);
    std::fs::write(&path, vec![b'#'; len]).unwrap();
}

async fn wait_for_entry(state: &AppState, key: &str) {
    for _ in 0..200 {
        if matches!(state.cache.get_bytes(key).await, Ok(Some(_))) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{key} was never written");
}

fn request_key() -> (String, String) {
    let hash = DiskCache::generate_key(JOBS_NE_MESHES_FIXTURE.as_bytes());
    let key = format!("{hash}-default");
    (hash, key)
}

/// SERVER-12 (#7676): a damaged entry behind an UPLOAD route is a miss. The
/// route re-parses the bytes it was sent, answers 200, and the re-parse
/// rewrites the entry. The flat, JSON and stream routes answered 500 here
/// (only the optimized route already treated it as a miss).
#[tokio::test]
async fn server_12_a_damaged_entry_behind_an_upload_is_re_parsed() {
    let state = test_state("7676-damaged-upload").await;
    let (_, key) = request_key();

    // The stream route, over its geometry entry.
    let live = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    await_cache_fill(&state, &live).await;
    let geometry = parquet_geometry_key(&key, ParquetLayout::Flat);
    damage(&state, &geometry).await;
    let replay = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    assert!(replay.iter().any(|e| e["type"] == "complete"), "{replay:?}");

    // The flat Parquet route, over the same geometry entry.
    wait_for_entry(&state, &geometry).await;
    damage(&state, &geometry).await;
    let flat = send(&state, "POST", "/api/v1/parse/parquet", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(flat.status(), StatusCode::OK, "POST /parse/parquet over a damaged geometry entry");
    drain(flat).await;

    // The JSON route, over its response entry.
    let json_key = json_response_cache_key(&key);
    let first = send(&state, "POST", "/api/v1/parse", Some(JOBS_NE_MESHES_FIXTURE)).await;
    drain(first).await;
    wait_for_entry(&state, &json_key).await;
    damage(&state, &json_key).await;
    let json = send(&state, "POST", "/api/v1/parse", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(json.status(), StatusCode::OK, "POST /parse over a damaged response entry");
    drain(json).await;

    // The optimized route, over its body (already a miss before; pinned).
    let first = send(&state, "POST", "/api/v1/parse/parquet/optimized", Some(JOBS_NE_MESHES_FIXTURE)).await;
    drain(first).await;
    damage(&state, &parquet_optimized_cache_key(&key)).await;
    let optimized = send(&state, "POST", "/api/v1/parse/parquet/optimized", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(optimized.status(), StatusCode::OK);
    drain(optimized).await;

    // Every one of those re-parses rewrote its entry.
    for entry in [geometry, json_key, parquet_optimized_cache_key(&key)] {
        wait_for_entry(&state, &entry).await;
    }
}

/// SERVER-12 (#7676): a damaged entry behind a READ-ONLY route is that
/// route's miss (404), never a 500. It is also dropped from the index, so the
/// existence check that sent the client there stops reporting it and the
/// client uploads, which rewrites it.
#[tokio::test]
async fn server_12_a_damaged_entry_behind_a_read_route_is_a_miss() {
    let state = test_state("7676-damaged-read").await;
    let (hash, key) = request_key();
    let live = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    await_cache_fill(&state, &live).await;
    let json = send(&state, "POST", "/api/v1/parse", Some(JOBS_NE_MESHES_FIXTURE)).await;
    drain(json).await;
    wait_for_entry(&state, &json_response_cache_key(&key)).await;

    let cases = [
        (data_model_cache_key(&key, DataModelEntities::All), format!("/api/v1/parse/data-model/{key}")),
        (symbolic_cache_key(&key), format!("/api/v1/parse/symbolic/{key}")),
        (json_response_cache_key(&key), format!("/api/v1/cache/{key}")),
        (parquet_geometry_key(&key, ParquetLayout::Flat), format!("/api/v1/cache/geometry/{hash}")),
    ];
    for (entry, uri) in cases {
        damage(&state, &entry).await;
        let response = send(&state, "GET", &uri, None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "GET {uri} over a damaged entry");
    }
    let check = send(&state, "GET", &format!("/api/v1/cache/check/{hash}"), None).await;
    assert_eq!(
        check.status(),
        StatusCode::NOT_FOUND,
        "the existence check still reported an entry every reader refuses"
    );
}

/// SERVER-12 (#7676): a metadata header that does not decode is a miss for
/// the stream probe (404, "upload it"), not a 500 on every probe for the file.
#[tokio::test]
async fn server_12_an_undecodable_replay_header_is_a_probe_miss() {
    let state = test_state("7676-bad-replay-header").await;
    let (hash, key) = request_key();
    let live = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    await_cache_fill(&state, &live).await;
    state.cache.set_bytes(&parquet_metadata_key(&key), b"{not a header").await.unwrap();

    let response = send(&state, "POST", &format!("/api/v1/parse/parquet-stream?sha256={hash}"), None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // The upload path re-parses the same file and repairs the header.
    let replay = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    assert!(replay.iter().any(|e| e["type"] == "complete"));
}

/// SERVER-21 (#7676): `GET /parse/symbolic/{key}` for a key nothing is
/// writing answers 404, as `GET /parse/data-model` has since #5129. It
/// answered 202 "still being processed" for any absent key (a typo, an
/// evicted entry), so a polling client spun until its own timeout.
#[tokio::test]
async fn server_21_symbolic_for_a_key_nothing_writes_is_404() {
    let state = test_state("7676-symbolic-404").await;
    let response = send(&state, "GET", &format!("/api/v1/parse/symbolic/{}-default", "e".repeat(64)), None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// SERVER-21 (#7676): while a stream that will write the sidecar is still
/// running, the same request answers 202, and 200 once it has landed.
#[tokio::test]
async fn server_21_symbolic_answers_202_while_a_stream_will_still_write_it() {
    let state = test_state("7676-symbolic-202").await;
    let (_, key) = request_key();
    let uri = format!("/api/v1/parse/symbolic/{key}");

    let stream = send(&state, "POST", "/api/v1/parse/parquet-stream", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(stream.status(), StatusCode::OK);
    assert_eq!(send(&state, "GET", &uri, None).await.status(), StatusCode::ACCEPTED);
    drain(stream).await;
    for _ in 0..200 {
        if send(&state, "GET", &uri, None).await.status() == StatusCode::OK {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the symbolic sidecar never became readable");
}

/// SERVER-22 (#7676): `POST /parse/stream` writes no cache entry, so its
/// `complete` event must not name one. It carried the bare file hash, which
/// `GET /cache/{key}` refuses with a 400, and computing it cost a second
/// SHA-256 over the whole upload on every streamed request.
#[tokio::test]
async fn server_22_the_json_stream_names_no_cache_key() {
    let state = test_state("7676-stream-no-key").await;
    let response = send(&state, "POST", "/api/v1/parse/stream", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let events = parse_sse_events(std::str::from_utf8(&drain(response).await).unwrap());
    let complete = events.iter().find(|e| e["type"] == "complete").expect("a complete event");
    assert!(
        complete.get("cache_key").is_none(),
        "the JSON stream advertised a cache key that names nothing: {}",
        complete["cache_key"]
    );
}
