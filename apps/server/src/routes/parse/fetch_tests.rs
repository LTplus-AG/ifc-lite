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
        data_model_in_flight: Arc::new(crate::in_flight::InFlightKeys::default()),
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

/// MISS: no parquet entry under the hash's cache key -> 404, in the shared
/// `{"error", "code"}` envelope (#5750; the body was empty before).
#[tokio::test]
async fn check_cache_returns_404_when_uncached() {
    let state = test_state("check-cache-miss").await;
    let response = get(&state, "/api/v1/cache/check/nosuchhash").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
    assert_eq!(body["code"], "NOT_FOUND");
    assert!(
        !body.to_string().contains("nosuchhash"),
        "the caller-supplied hash must not be echoed: {body}"
    );
}

/// HIT: a parquet entry exists under the exact key the writer would have used
/// for this hash/filter/quality combination -> 200, empty body.
#[tokio::test]
async fn check_cache_returns_200_when_parquet_cached() {
    let state = test_state("check-cache-hit").await;
    let hash = "abc123hash";
    let key = parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state.cache.set_bytes(&key, b"parquet-bytes").await.unwrap();
    // A hit also requires a data model at the current payload version (#3869)
    // and the metadata header the geometry fetch serves (#4675).
    seed_current_data_model(&state, hash, OpeningFilterMode::Default).await;
    seed_current_metadata(&state, hash, OpeningFilterMode::Default).await;

    let response = get(&state, &format!("/api/v1/cache/check/{hash}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_bytes(response).await.is_empty());
}

/// Seed a data-model entry at the CURRENT payload version for `hash`.
async fn seed_current_data_model(state: &AppState, hash: &str, filter: OpeningFilterMode) {
    let seed = cache_key_from_parts(hash, filter, TessellationQuality::default());
    super::cache_keys::cache_symbolic_data(&state.cache, &seed,
        &ifc_lite_processing::SymbolicDataWithProvenance::default()).await;
    state
        .cache
        .set_bytes(&data_model_cache_key(&seed), b"data-model-bytes")
        .await
        .unwrap();
}

/// Seed the Parquet metadata header at the CURRENT version for `hash`.
async fn seed_current_metadata(state: &AppState, hash: &str, filter: OpeningFilterMode) {
    let key = parquet_metadata_cache_key(hash, filter, TessellationQuality::default());
    state.cache.set_bytes(&key, b"{}").await.unwrap();
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
    seed_current_metadata(&state, hash, OpeningFilterMode::Default).await;
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
    seed_current_metadata(&state, hash, OpeningFilterMode::Default).await;

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

    // The matching filter must hit (with current sidecars beside it).
    seed_current_data_model(&state, hash, OpeningFilterMode::IgnoreAll).await;
    seed_current_metadata(&state, hash, OpeningFilterMode::IgnoreAll).await;
    let scoped_response = get(
        &state,
        &format!("/api/v1/cache/check/{hash}?opening_filter=ignore_all"),
    )
    .await;
    assert_eq!(scoped_response.status(), StatusCode::OK);
}

/// A metadata header written under a previous version is not a hit (#4675).
/// A check hit makes `parseParquet` skip the upload and call
/// `get_cached_geometry`, which needs the header at the CURRENT version, so a
/// check that answers on geometry alone sends the client to a 404 it never
/// recovers from. After the #4653 bump every warm deployment holds exactly
/// this: current geometry and data model beside a `-parquet-metadata-v4` header.
#[tokio::test]
async fn issue_4675_check_cache_misses_when_the_metadata_header_predates_the_current_version() {
    let state = test_state("4675-check-stale-metadata").await;
    let hash = "stalemetahash";
    let seed = cache_key_from_parts(hash, OpeningFilterMode::Default, TessellationQuality::default());
    let geometry_key =
        parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state.cache.set_bytes(&geometry_key, b"parquet-bytes").await.unwrap();
    seed_current_data_model(&state, hash, OpeningFilterMode::Default).await;
    state.cache.set_bytes(&format!("{seed}-parquet-metadata-v4"), b"{}").await.unwrap();

    assert_eq!(
        get(&state, &format!("/api/v1/cache/geometry/{hash}")).await.status(),
        StatusCode::NOT_FOUND,
        "a pre-#4653 header must not be served"
    );
    assert_eq!(
        get(&state, &format!("/api/v1/cache/check/{hash}")).await.status(),
        StatusCode::NOT_FOUND,
        "the check must not report a hit the geometry fetch cannot serve"
    );

    // Anti-vacuity: the current header is what turns both into hits.
    seed_current_metadata(&state, hash, OpeningFilterMode::Default).await;
    assert_eq!(get(&state, &format!("/api/v1/cache/check/{hash}")).await.status(), StatusCode::OK);
    assert_eq!(get(&state, &format!("/api/v1/cache/geometry/{hash}")).await.status(), StatusCode::OK);
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

/// MISS: the 404 body does not reflect the caller-supplied hash (#5750
/// review, the sibling of `check_cache_returns_404_when_uncached`).
#[tokio::test]
async fn get_cached_geometry_404_does_not_echo_the_hash() {
    let state = test_state("geometry-miss-no-echo").await;
    let response = get(&state, "/api/v1/cache/geometry/nosuchgeometryhash").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
    assert_eq!(body["code"], "NOT_FOUND");
    assert!(
        !body.to_string().contains("nosuchgeometryhash"),
        "the caller-supplied hash must not be echoed: {body}"
    );
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

/// Unknown cache key, no fill in flight -> 404 (issue #5129). Previously this
/// answered 202 unconditionally, which reads as "still processing" for a key
/// nothing was ever going to process -- exactly what happened to a client
/// that only ever called `/parse/parquet/optimized`, which never wrote this
/// key at all.
#[tokio::test]
async fn get_data_model_404_when_nothing_in_flight() {
    let state = test_state("data-model-pending").await;
    let response = get(&state, "/api/v1/parse/data-model/does-not-exist").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// 202 only while `InFlightKeys` actually holds the key: begin a fill, see
/// 202, drop the guard (as the background task's `Drop` does on completion,
/// failure, or admission-saturated early return alike), see 404. The state
/// transition end-to-end, not just the miss case above.
#[tokio::test]
async fn get_data_model_202_only_while_fill_in_flight() {
    let state = test_state("data-model-in-flight").await;
    let cache_key = "somehash-default";

    let guard = state.data_model_in_flight.begin(cache_key.to_string());
    let response = get(&state, &format!("/api/v1/parse/data-model/{cache_key}")).await;
    assert_eq!(
        response.status(),
        StatusCode::ACCEPTED,
        "a key with a fill in flight must answer 202"
    );

    drop(guard);
    let response = get(&state, &format!("/api/v1/parse/data-model/{cache_key}")).await;
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "once the fill ends (guard dropped) with nothing cached, the key must 404"
    );
}

/// An entry written under the PREVIOUS payload version must not be served
/// (issue #3860). The `rel_id` column was added to the relationships table, so
/// a `v5` blob decodes cleanly and silently restores `RelId = 0` on every
/// relationship row of a server-loaded model. The reader must miss it and let
/// the file be re-parsed. No fill is in flight for this key, so the miss is a
/// 404 (#5129), not the pre-existing unconditional 202.
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
        StatusCode::NOT_FOUND,
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

#[tokio::test]
async fn issue_4459_hash_check_requires_fresh_symbols_before_skipping_upload() {
    let state = test_state("4459-check-symbols").await;
    let hash = "4459-check";
    let seed = cache_key_from_parts(hash, OpeningFilterMode::Default, TessellationQuality::default());
    let geometry = parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    state.cache.set_bytes(&geometry, b"unchanged geometry").await.unwrap();
    seed_current_metadata(&state, hash, OpeningFilterMode::Default).await;
    state.cache.set_bytes(&data_model_cache_key(&seed), b"current data model").await.unwrap();
    // Retired: v1 (#4459, no fill provenance), v2 (#4665, pre mesh-frame
    // rebase), v3 (#4706, pre the site tier's translation and rotation coming
    // out of the stream). The list has to keep up with `symbolic_cache_key`:
    // a suffix missing here is a bump this guard cannot catch.
    for retired in ["-symbolic-v1", "-symbolic-v2", "-symbolic-v3"] {
        state.cache.set_bytes(&format!("{seed}{retired}"), b"{}").await.unwrap();
    }
    assert_eq!(get(&state, &format!("/api/v1/cache/check/{hash}")).await.status(), StatusCode::NOT_FOUND);
    seed_current_data_model(&state, hash, OpeningFilterMode::Default).await;
    assert_eq!(get(&state, &format!("/api/v1/cache/check/{hash}")).await.status(), StatusCode::OK);
    assert_eq!(state.cache.get_bytes(&geometry).await.unwrap().unwrap(), b"unchanged geometry");
}

/// #5542: this is the warm path of the client's `parseParquet()` (cache check,
/// then this fetch). The stored header is the one the live parse wrote, so
/// its stats say `from_cache: false`; replaying it verbatim told a warm caller
/// its model had just been parsed, and `docs/guide/server.md` prints exactly
/// that field. The replayed header must report the hit and keep everything
/// else as stored.
#[tokio::test]
async fn issue_5542_get_cached_geometry_reports_from_cache() {
    let state = test_state("5542-geometry-from-cache").await;
    let hash = "fromcachehash";
    let parquet_key = parquet_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default(), ParquetLayout::Flat);
    let metadata_key =
        parquet_metadata_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::default());
    let stored = super::parquet::ParquetMetadataHeader {
        cache_key: cache_key_from_parts(hash, OpeningFilterMode::Default, TessellationQuality::default()),
        metadata: crate::types::ModelMetadata::default(),
        stats: crate::types::ProcessingStats { total_meshes: 5, ..Default::default() },
        mesh_coordinate_space: None,
        site_transform: None,
        building_transform: None,
        data_model_stats: None,
    };
    assert!(!stored.stats.from_cache, "seeded as the live parse writes it");
    state.cache.set_bytes(&parquet_key, b"parquet-bytes").await.unwrap();
    state
        .cache
        .set_bytes(&metadata_key, &serde_json::to_vec(&stored).unwrap())
        .await
        .unwrap();

    let response = get(&state, &format!("/api/v1/cache/geometry/{hash}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let header: serde_json::Value = serde_json::from_str(
        response.headers().get("X-IFC-Metadata").unwrap().to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(header["stats"]["from_cache"], true, "replayed header: {header}");
    let mut expected = serde_json::to_value(&stored).unwrap();
    expected["stats"]["from_cache"] = serde_json::Value::Bool(true);
    assert_eq!(header, expected, "only from_cache may differ from what was stored");
}
