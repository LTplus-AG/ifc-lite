// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Admission on every route that reads a stored model (#7676: SERVER-6,
//! SERVER-7, and SERVER-24 for cache reads).
//!
//! The server parses untrusted uploads for any caller, so a route that reads
//! or holds a whole model has to be charged against the admission budget, and
//! a route that only asks "is it there" must not read the model at all. Each
//! test drives the real router.

use super::*;
use crate::admission::{Admission, AdmissionCfg};
use crate::routes::parse::cache_keys::{json_response_cache_key, parquet_geometry_key};
use crate::services::ParquetLayout;
use std::sync::atomic::Ordering;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

/// A fresh admission with `slots` CPU slots, a `budget_mib` byte budget
/// (0 disables it), no queue, and a short wait, so an over-limit request
/// answers 503 at once.
fn admission(slots: usize, budget_mib: u64) -> Arc<Admission> {
    Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: slots,
        mem_budget_bytes: budget_mib * MIB,
        queue_depth: 0,
        queue_timeout: Duration::from_millis(50),
        shed_pct: 0,
    }))
}

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

/// Warm every entry a read route serves, through the real parse routes: the
/// flat stream entries (geometry, metadata, data model, symbolic, progress),
/// the optimized body, and the JSON response. Returns `(hash, cache_key)`.
pub(super) async fn warm_everything(state: &AppState) -> (String, String) {
    let live = stream_once(state, JOBS_NE_MESHES_FIXTURE).await;
    let key = await_cache_fill(state, &live).await;
    let hash = DiskCache::generate_key(JOBS_NE_MESHES_FIXTURE.as_bytes());

    let optimized = send(state, "POST", "/api/v1/parse/parquet/optimized", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(optimized.status(), StatusCode::OK);
    drain(optimized).await;

    let json = send(state, "POST", "/api/v1/parse", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(json.status(), StatusCode::OK);
    drain(json).await;
    for _ in 0..200 {
        if matches!(state.cache.get_bytes(&json_response_cache_key(&key)).await, Ok(Some(_))) {
            return (hash, key);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the JSON response entry was never written for {key}");
}

/// Every route that hands back a stored model, as `(method, uri)`.
fn cache_hit_routes(hash: &str, key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("GET", format!("/api/v1/parse/data-model/{key}")),
        ("GET", format!("/api/v1/parse/symbolic/{key}")),
        ("GET", format!("/api/v1/cache/geometry/{hash}")),
        ("GET", format!("/api/v1/cache/{key}")),
        ("POST", format!("/api/v1/parse/parquet-stream?sha256={hash}")),
        ("POST", format!("/api/v1/parse/parquet/optimized?sha256={hash}")),
    ]
}

/// SERVER-6 (#7676): every route that reads a whole stored model into memory
/// is admitted, like the parse routes and `GET /cache/{key}` already were;
/// the routes that only answer "is it there" need no admission. A read that
/// computes nothing is charged to the byte budget only, so here the one CPU
/// slot AND the whole budget are held.
///
/// Before the fix, `GET /parse/data-model`, `/parse/symbolic` and
/// `/cache/geometry` read the whole entry with no admission at all, so a
/// caller who knows one cached hash could pin any number of model-sized
/// buffers.
#[tokio::test]
async fn server_6_every_route_that_reads_a_stored_model_needs_admission() {
    let mut state = test_state("7676-admission-matrix").await;
    let (hash, key) = warm_everything(&state).await;

    state.admission = admission(1, 8);
    let held = state.admission.acquire(8 * MIB).await.expect("the slot and the budget are free");

    for (method, uri) in cache_hit_routes(&hash, &key) {
        let response = send(&state, method, &uri, None).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{method} {uri} read a stored model with no admission left"
        );
    }
    let uploads = [
        "/api/v1/parse",
        "/api/v1/parse/stream",
        "/api/v1/parse/metadata",
        "/api/v1/parse/parquet",
        "/api/v1/parse/parquet/optimized",
        "/api/v1/parse/parquet-stream",
    ];
    for uri in uploads {
        let response = send(&state, "POST", uri, Some(JOBS_NE_MESHES_FIXTURE)).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "POST {uri} buffered an upload with no admission left"
        );
    }

    // Existence checks and misses read no model, so they need no admission.
    let unknown = "f".repeat(64);
    let no_slot_needed = [
        (format!("/api/v1/cache/check/{hash}"), StatusCode::OK),
        (format!("/api/v1/cache/check/{unknown}"), StatusCode::NOT_FOUND),
        (format!("/api/v1/cache/geometry/{unknown}"), StatusCode::NOT_FOUND),
        (format!("/api/v1/parse/data-model/{unknown}-default"), StatusCode::NOT_FOUND),
        (format!("/api/v1/cache/{unknown}-default"), StatusCode::NOT_FOUND),
    ];
    for (uri, expected) in no_slot_needed {
        assert_eq!(send(&state, "GET", &uri, None).await.status(), expected, "GET {uri}");
    }

    // Anti-vacuity: every one of those 503s was a real hit held back.
    drop(held);
    for (method, uri) in cache_hit_routes(&hash, &key) {
        let response = send(&state, method, &uri, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{method} {uri} with admission free");
        drain(response).await;
    }
}

/// SERVER-6 (#7676): `GET /cache/check/{hash}` is an existence check. It
/// used to read and integrity-hash the geometry, the data model, the symbolic
/// sidecar and the metadata header, all to return an empty `200`.
#[tokio::test]
async fn server_6_the_cache_check_reads_no_entry_content() {
    let state = test_state("7676-check-reads-nothing").await;
    let live = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    await_cache_fill(&state, &live).await;
    let hash = DiskCache::generate_key(JOBS_NE_MESHES_FIXTURE.as_bytes());

    state.cache.content_reads.store(0, Ordering::SeqCst);
    let response = send(&state, "GET", &format!("/api/v1/cache/check/{hash}"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        state.cache.content_reads.load(Ordering::SeqCst),
        0,
        "the cache check read entry content to answer an existence question"
    );
}

/// SERVER-6 (#7676): the `?sha256=` probe's gates run before any admission
/// slot is taken, which is only safe if they read nothing. The data-model
/// "marker" they read was the whole data-model Parquet. Here every sidecar is
/// present and only the geometry is gone, so the probe misses: it must find
/// that out without reading a byte of any entry.
#[tokio::test]
async fn server_6_a_probe_miss_reads_no_entry_content() {
    let state = test_state("7676-probe-miss-reads-nothing").await;
    let live = stream_once(&state, JOBS_NE_MESHES_FIXTURE).await;
    let key = await_cache_fill(&state, &live).await;
    let hash = DiskCache::generate_key(JOBS_NE_MESHES_FIXTURE.as_bytes());
    state.cache.remove(&parquet_geometry_key(&key, ParquetLayout::Flat)).await.unwrap();

    state.cache.content_reads.store(0, Ordering::SeqCst);
    let response = send(&state, "POST", &format!("/api/v1/parse/parquet-stream?sha256={hash}"), None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        state.cache.content_reads.load(Ordering::SeqCst),
        0,
        "the probe read entry content before (or instead of) finding the miss"
    );
}

/// SERVER-7 / SERVER-24 (#7676): a response that holds a stored model keeps
/// that model's bytes reserved until the client has drained it, and frees
/// its CPU slot at once.
///
/// The replay builds every batch base64-encoded in memory, and the other
/// routes hold the whole entry in the body; a slow reader keeps all of it
/// resident for up to the write-idle timeout. Before the fix the slot was
/// dropped as the response was returned (or never taken), so any number of
/// slow readers could each pin a model with nothing accounted. The
/// reservation is the entry's own size, not `MAX_FILE_SIZE_MB`, so the rest
/// of the budget stays usable.
#[tokio::test]
async fn server_7_a_held_response_keeps_its_bytes_reserved_until_drained() {
    let mut state = test_state("7676-drain-reservation").await;
    let (hash, key) = warm_everything(&state).await;

    const BUDGET_MIB: u64 = 64;
    state.admission = admission(1, BUDGET_MIB);
    for (method, uri) in cache_hit_routes(&hash, &key) {
        let response = send(&state, method, &uri, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{method} {uri}");

        assert!(
            state.admission.acquire(BUDGET_MIB * MIB).await.is_err(),
            "{method} {uri}: the whole budget was free while the response still held the model"
        );
        let other = state.admission.acquire(BUDGET_MIB * MIB / 2).await;
        assert!(
            other.is_ok(),
            "{method} {uri}: a held response must free its CPU slot and reserve only its own size: {other:?}"
        );
        drop(other);

        drain(response).await;
        let mut freed = false;
        for _ in 0..200 {
            if let Ok(guard) = state.admission.acquire(BUDGET_MIB * MIB).await {
                drop(guard);
                freed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(freed, "{method} {uri}: the reservation outlived the drained response");
    }
}
