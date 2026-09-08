// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the cache-fetch endpoints in `fetch.rs` (mutation-audit round 29).
//!
//! `get_data_model`, `check_cache`, and `get_cached_geometry` were previously
//! un-hit by any test in the crate: no test drove `GET /api/v1/parse/data-model`,
//! `GET /api/v1/cache/check`, or `GET /api/v1/cache/geometry` through the router.
//! `get_cached_geometry` in particular only succeeds on `(Some(parquet),
//! Some(metadata))` and falls through to `NotFound` for every other
//! combination — these tests cover each partial-cache-state branch, not just
//! both-present and both-absent.

use super::cache_keys::{
    cache_key_from_parts, data_model_cache_key, parquet_cache_key, parquet_metadata_cache_key,
};
use crate::admission::{Admission, AdmissionCfg};
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::services::{OpeningFilterMode, ParquetLayout};
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use ifc_lite_processing::TessellationQuality;
use std::sync::Arc;
use tower::ServiceExt;

/// Construct an `AppState` backed by a fresh temp cache directory unique to
/// `label` so tests don't share cache entries.
async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-test-fetch-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    AppState {
        cache,
        config: Arc::new(Config::from_env()),
        admission: Arc::new(Admission::new(AdmissionCfg {
            max_concurrent_parses: 8,
            mem_budget_bytes: 0,
            queue_depth: 16,
            queue_timeout: std::time::Duration::from_millis(100),
            shed_pct: 85,
        })),
    }
}

/// GET `uri` through the full router and return the response.
async fn get(state: &AppState, uri: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

// ---------------------------------------------------------------------------
// check_cache
// ---------------------------------------------------------------------------

/// MISS: no parquet entry under the hash's cache key -> 404, empty body.
#[tokio::test]
async fn check_cache_returns_404_when_uncached() {
    let state = test_state("check-cache-miss").await;
    let response = get(&state, "/api/v1/cache/check/nosuchhash").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(body_bytes(response).await.is_empty());
}

/// HIT: a parquet entry exists under the exact key the writer would have used
/// for this hash/filter/quality combination -> 200, empty body.
#[tokio::test]
async fn check_cache_returns_200_when_parquet_cached() {
    let state = test_state("check-cache-hit").await;
    let hash = "abc123hash";
    let key = parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state.cache.set_bytes(&key, b"parquet-bytes").await.unwrap();
    // A hit also requires a data model at the current payload version (#3869).
    seed_current_data_model(&state, hash, OpeningFilterMode::Default).await;

    let response = get(&state, &format!("/api/v1/cache/check/{hash}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_bytes(response).await.is_empty());
}

/// Seed a data-model entry at the CURRENT payload version for `hash`.
async fn seed_current_data_model(state: &AppState, hash: &str, filter: OpeningFilterMode) {
    let seed = cache_key_from_parts(hash, filter, TessellationQuality::default());
    state
        .cache
        .set_bytes(&data_model_cache_key(&seed), b"data-model-bytes")
        .await
        .unwrap();
}

/// A geometry entry outlives a data-model version bump: the geometry key is
/// versioned separately and does not move when a data-model column is added.
/// Reporting a hit on geometry alone makes the client skip the upload, so
/// nothing ever writes the new data-model key and `fetchDataModel` polls a key
/// nobody writes until it times out — geometry on screen, no properties, and
/// no error (issue #3869). The check must miss so the file is re-parsed.
#[tokio::test]
async fn check_cache_misses_when_the_data_model_predates_the_current_version() {
    let state = test_state("check-cache-stale-datamodel").await;
    let hash = "staledmhash";
    let geometry_key =
        parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state
        .cache
        .set_bytes(&geometry_key, b"parquet-bytes")
        .await
        .unwrap();
    // The data model this deployment left behind: previous payload version.
    let seed = cache_key_from_parts(hash, OpeningFilterMode::Default, TessellationQuality::default());
    state
        .cache
        .set_bytes(&format!("{seed}-datamodel-v5"), b"pre-rel_id-parquet")
        .await
        .unwrap();

    let response = get(&state, &format!("/api/v1/cache/check/{hash}")).await;
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "geometry alone must not report a hit when the data model is stale"
    );
}

/// Negative control for the gate above: geometry cached with NO data model at
/// all must also miss, so the client uploads and both get written.
#[tokio::test]
async fn check_cache_misses_when_no_data_model_is_cached_at_all() {
    let state = test_state("check-cache-no-datamodel").await;
    let hash = "nodmhash";
    let geometry_key =
        parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state
        .cache
        .set_bytes(&geometry_key, b"parquet-bytes")
        .await
        .unwrap();

    let response = get(&state, &format!("/api/v1/cache/check/{hash}")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// The cache key is filter-specific: a cached entry for `ignore_all` must NOT
/// satisfy a `default`-filter check for the same hash.
#[tokio::test]
async fn check_cache_is_scoped_to_opening_filter() {
    let state = test_state("check-cache-filter-scoped").await;
    let hash = "def456hash";
    let key = parquet_cache_key(
        hash,
        OpeningFilterMode::IgnoreAll,
        TessellationQuality::default(),
        ParquetLayout::Flat,
    );
    state.cache.set_bytes(&key, b"parquet-bytes").await.unwrap();

    // Default filter (no query param) must still miss.
    let default_response = get(&state, &format!("/api/v1/cache/check/{hash}")).await;
    assert_eq!(default_response.status(), StatusCode::NOT_FOUND);

    // The matching filter must hit (with a current data model beside it).
    seed_current_data_model(&state, hash, OpeningFilterMode::IgnoreAll).await;
    let scoped_response = get(
        &state,
        &format!("/api/v1/cache/check/{hash}?opening_filter=ignore_all"),
    )
    .await;
    assert_eq!(scoped_response.status(), StatusCode::OK);
}

// ---------------------------------------------------------------------------
// get_cached_geometry
// ---------------------------------------------------------------------------

/// Both present -> 200 with the parquet bytes as the body and the metadata
/// JSON echoed back verbatim in `X-IFC-Metadata`.
#[tokio::test]
async fn get_cached_geometry_returns_full_payload_when_both_present() {
    let state = test_state("geometry-both-present").await;
    let hash = "fullhash1";
    let parquet_key = parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    let metadata_key =
        parquet_metadata_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default());
    state
        .cache
        .set_bytes(&parquet_key, b"the-parquet-bytes")
        .await
        .unwrap();
    state
        .cache
        .set_bytes(&metadata_key, br#"{"cache_key":"fullhash1-default"}"#)
        .await
        .unwrap();

    let response = get(&state, &format!("/api/v1/cache/geometry/{hash}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let metadata_header = response
        .headers()
        .get("X-IFC-Metadata")
        .expect("200 response must carry X-IFC-Metadata")
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(metadata_header, r#"{"cache_key":"fullhash1-default"}"#);
    let body = body_bytes(response).await;
    assert_eq!(body, b"the-parquet-bytes");
}

/// Partial state: parquet present, metadata absent -> 404 (not a 200 with a
/// missing header, not a 500).
#[tokio::test]
async fn get_cached_geometry_404s_when_metadata_missing() {
    let state = test_state("geometry-metadata-missing").await;
    let hash = "partialhash1";
    let parquet_key = parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state
        .cache
        .set_bytes(&parquet_key, b"the-parquet-bytes")
        .await
        .unwrap();
    // No metadata entry written.

    let response = get(&state, &format!("/api/v1/cache/geometry/{hash}")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// Partial state: metadata present, parquet absent -> 404.
#[tokio::test]
async fn get_cached_geometry_404s_when_parquet_missing() {
    let state = test_state("geometry-parquet-missing").await;
    let hash = "partialhash2";
    let metadata_key =
        parquet_metadata_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default());
    state
        .cache
        .set_bytes(&metadata_key, br#"{"cache_key":"partialhash2-default"}"#)
        .await
        .unwrap();
    // No parquet entry written.

    let response = get(&state, &format!("/api/v1/cache/geometry/{hash}")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// Neither present -> 404.
#[tokio::test]
async fn get_cached_geometry_404s_when_both_missing() {
    let state = test_state("geometry-both-missing").await;
    let response = get(&state, "/api/v1/cache/geometry/nosuchhash").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// get_data_model
// ---------------------------------------------------------------------------

/// Unknown cache key -> 202 Accepted (still processing), never 404.
#[tokio::test]
async fn get_data_model_returns_202_when_not_yet_cached() {
    let state = test_state("data-model-pending").await;
    let response = get(&state, "/api/v1/parse/data-model/does-not-exist").await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
}

/// An entry written under the PREVIOUS payload version must not be served
/// (issue #3860). The `rel_id` column was added to the relationships table, so
/// a `v5` blob decodes cleanly and silently restores `RelId = 0` on every
/// relationship row of a server-loaded model. The reader must miss it and let
/// the file be re-parsed.
#[tokio::test]
async fn get_data_model_ignores_an_entry_written_under_the_previous_version() {
    let state = test_state("data-model-stale").await;
    let cache_key = "somehash-default";
    state
        .cache
        .set_bytes(&format!("{cache_key}-datamodel-v5"), b"pre-rel_id-parquet")
        .await
        .unwrap();

    let response = get(&state, &format!("/api/v1/parse/data-model/{cache_key}")).await;
    assert_eq!(
        response.status(),
        StatusCode::ACCEPTED,
        "a pre-bump data-model blob must not be served"
    );
}

/// Cached data model -> 200 with the exact stored bytes as the body.
#[tokio::test]
async fn get_data_model_returns_200_with_cached_bytes() {
    let state = test_state("data-model-hit").await;
    let cache_key = "somehash-default";
    let data_model_key = data_model_cache_key(cache_key);
    state
        .cache
        .set_bytes(&data_model_key, b"the-data-model-parquet")
        .await
        .unwrap();

    let response = get(&state, &format!("/api/v1/parse/data-model/{cache_key}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_bytes(response).await;
    assert_eq!(body, b"the-data-model-parquet");
}
