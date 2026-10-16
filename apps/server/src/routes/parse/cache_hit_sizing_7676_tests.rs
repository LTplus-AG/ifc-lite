// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A cache hit is charged the stored entries' size on every route, upload
//! routes included, and the responses that know their length say so (#7676
//! review of the cache-entry policy: findings 2 and 4).
//!
//! An upload route admits the upload and charges it a multiple of ITS size.
//! A hit does not hold that: it holds the stored entries, which can be many
//! times larger, so the charge has to follow them.

use super::cache_read_7676::warm_everything;
use super::*;
use crate::admission::{Admission, AdmissionCfg};
use crate::routes::parse::cache_keys::{
    json_response_cache_key, parquet_geometry_key, parquet_optimized_cache_key, symbolic_cache_key,
};
use crate::services::ParquetLayout;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

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

/// Make `key`'s stored entry `extra` bytes larger without making it unusable:
/// JSON takes trailing whitespace, and the geometry frames name their own
/// length, so a raw reader returns the tail and a framed one ignores it.
async fn pad(state: &AppState, key: &str, extra: u64, fill: u8) {
    let mut bytes = state.cache.get_bytes(key).await.unwrap().unwrap_or_else(|| panic!("no entry {key}"));
    bytes.resize(bytes.len() + extra as usize, fill);
    state.cache.set_bytes(key, &bytes).await.unwrap();
}

/// A warm cache whose entries are big next to a tiny upload, and an admission
/// whose budget is `10 MiB` with `MAX_FILE_SIZE_MB` at 4, so the upload's
/// own charge (one permit) says nothing about what a hit holds.
async fn big_entries(label: &str) -> (AppState, String) {
    let mut state = test_state(label).await;
    let (_, key) = warm_everything(&state).await;
    for (entry, fill) in [
        (json_response_cache_key(&key), b' '),
        (parquet_geometry_key(&key, ParquetLayout::Flat), 0),
        (parquet_optimized_cache_key(&key), 0),
    ] {
        pad(&state, &entry, 4 * MIB, fill).await;
    }
    state.config = Arc::new(Config { max_file_size_mb: 4, ..(*state.config).clone() });
    state.admission = Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: 4,
        mem_budget_bytes: 10 * MIB,
        queue_depth: 0,
        queue_timeout: Duration::from_millis(50),
        shed_pct: 0,
    }));
    (state, key)
}

/// A hit on each upload route that serves the stored body holds the stored
/// size while the client reads it, not the 3 KB upload's one permit.
#[tokio::test]
async fn an_upload_route_hit_holds_the_stored_size_until_drained() {
    let (state, _) = big_entries("7709-hit-holds-stored-size").await;
    for uri in ["/api/v1/parse", "/api/v1/parse/parquet", "/api/v1/parse/parquet/optimized"] {
        let hit = send(&state, "POST", uri, Some(JOBS_NE_MESHES_FIXTURE)).await;
        assert_eq!(hit.status(), StatusCode::OK, "POST {uri}");
        let rest = state.admission.acquire_resident(7 * MIB).await;
        assert!(rest.is_err(), "POST {uri}: a hit on 4 MiB+ of stored entries held only the upload's charge");
        drain(hit).await;
        assert!(state.admission.acquire_resident(7 * MIB).await.is_ok(), "POST {uri}: the charge outlived the body");
    }
}

/// The stream's replay builds from the stored geometry (a copy of it, its
/// batches, their encoding), so it needs that size while it builds: with the
/// budget taken by someone else it is refused, rather than admitted for the
/// upload's size and left to allocate on top of the budget.
#[tokio::test]
async fn a_stream_replay_needs_the_stored_geometrys_size_to_build() {
    let (state, _) = big_entries("7709-replay-needs-stored-size").await;
    let other = state.admission.acquire_resident(4 * MIB).await.expect("the budget has room");

    let refused = send(&state, "POST", "/api/v1/parse/parquet-stream", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE, "replaying 4 MiB+ of geometry on an upload's charge");
    drain(refused).await;

    drop(other);
    let admitted = send(&state, "POST", "/api/v1/parse/parquet-stream", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(admitted.status(), StatusCode::OK);
    drain(admitted).await;
}

/// A hit that turns out to be a miss goes back to the upload's charge, so the
/// re-parse that follows is admitted for what the upload needs, no more.
#[tokio::test]
async fn a_hit_that_misses_gives_the_bytes_back_to_the_parse() {
    let (state, key) = big_entries("7709-miss-restores-charge").await;
    // Not JSON any more: the hit is read, fails to decode, and the parse runs.
    state.cache.set_bytes(&json_response_cache_key(&key), &vec![b'#'; (4 * MIB) as usize]).await.unwrap();

    let reparsed = send(&state, "POST", "/api/v1/parse", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(reparsed.status(), StatusCode::OK);
    drain(reparsed).await;
    assert!(
        state.admission.acquire(9 * MIB).await.is_ok(),
        "the re-parse's reservation was not given back after the response"
    );
}

/// A replay that is not a hit (here: the symbolic sidecar is gone, so the
/// gate says re-parse) must cost an already-admitted upload nothing. The
/// replay used to be sized before that gate, and growing to the stored
/// geometry's size under contention refused an upload that would have parsed.
#[tokio::test]
async fn a_replay_miss_cannot_503_an_admitted_upload_under_contention() {
    let (state, key) = big_entries("7709-miss-under-contention").await;
    state.cache.remove(&symbolic_cache_key(&key)).await.unwrap();
    let other = state.admission.acquire_resident(MIB).await.expect("the budget has room");

    let parsed = send(&state, "POST", "/api/v1/parse/parquet-stream", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(parsed.status(), StatusCode::OK, "a miss was refused for the size of an entry it never read");
    drain(parsed).await;
    drop(other);
}

/// Finding 2: `Content-Length` is sent wherever the body's length is known,
/// as it was before these routes streamed their body.
#[tokio::test]
async fn bodies_of_known_length_say_so() {
    let state = test_state("7709-content-length").await;
    let (_, key) = warm_everything(&state).await;

    let live = send(&state, "POST", "/api/v1/parse", Some(&JOBS_NE_MESHES_FIXTURE.replace("p3897.ifc", "s4-7709-cl.ifc"))).await;
    let hit = send(&state, "POST", "/api/v1/parse", Some(JOBS_NE_MESHES_FIXTURE)).await;
    let get = send(&state, "GET", &format!("/api/v1/cache/{key}"), None).await;
    for (what, response) in [("live parse", live), ("parse hit", hit), ("GET /cache/{key}", get)] {
        assert_eq!(response.status(), StatusCode::OK, "{what}");
        let declared = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .unwrap_or_else(|| panic!("{what} sent no Content-Length"))
            .to_str()
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert_eq!(declared, drain(response).await.len(), "{what}");
    }
}
