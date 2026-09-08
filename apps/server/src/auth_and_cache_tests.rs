// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Integration tests for the optional bearer-token auth layer
//! (`middleware::auth::require_bearer_token`) and the `GET /api/v1/cache/:key`
//! route (`routes::cache::get_cached`).
//!
//! Neither had any test coverage before this file: `require_bearer_token`
//! gates every parse/cache/metrics route and was exercised by zero request in
//! the suite (allow or deny direction), and `get_cached` was likewise never
//! driven through the router in either the hit or the miss case.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::types::ParseResponse;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::Value;
use std::sync::Arc;

/// Build an `AppState` backed by a fresh temp cache directory unique to
/// `label`, mirroring `parity_tests::test_state`.
async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-test-auth-cache-{}-{}",
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
                max_concurrent_parses: 8,
                mem_budget_bytes: 0,
                queue_depth: 16,
                queue_timeout: std::time::Duration::from_millis(100),
                shed_pct: 85,
            },
        )),
    }
}

/// GET `uri` with an optional `Authorization: Bearer <token>` header.
async fn get_with_token(
    state: &AppState,
    uri: &str,
    token: Option<&str>,
) -> axum::response::Response {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(t) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let request = builder.body(Body::empty()).unwrap();
    use tower::ServiceExt;
    build_router(state.clone()).oneshot(request).await.unwrap()
}

/// A minimal but structurally complete `ParseResponse`, built from the
/// `Default` impls of its fields (all of which derive `Default` except
/// `cache_key`, which is required).
fn minimal_parse_response(cache_key: &str) -> ParseResponse {
    ParseResponse {
        cache_key: cache_key.to_string(),
        meshes: Vec::new(),
        mesh_coordinate_space: None,
        site_transform: None,
        building_transform: None,
        metadata: Default::default(),
        stats: Default::default(),
        symbolic_data: Default::default(),
    }
}

// ---------------------------------------------------------------------
// Auth: default (unconfigured) is a pass-through.
// ---------------------------------------------------------------------

#[tokio::test]
async fn auth_disabled_by_default_lets_protected_route_through_without_a_header() {
    let state = test_state("auth-off").await;
    assert!(
        state.config.api_token.is_none(),
        "test assumes IFC_SERVER_API_TOKEN/API_TOKEN are unset in the test environment"
    );
    // No Authorization header at all. If auth were somehow on, this would be
    // 401; with it off, the request reaches `get_cached`, which 404s because
    // the key was never cached - the diagnostic proof the layer let it through.
    let response = get_with_token(&state, "/api/v1/cache/missing-key", None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------
// Auth: configured token enforces the deny direction.
// ---------------------------------------------------------------------

#[tokio::test]
async fn auth_rejects_missing_header_when_token_configured() {
    let mut state = test_state("auth-missing-header").await;
    let mut config = (*state.config).clone();
    config.api_token = Some("s3cr3t".to_string());
    state.config = Arc::new(config);

    let response = get_with_token(&state, "/api/v1/cache/missing-key", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_rejects_wrong_token_when_token_configured() {
    let mut state = test_state("auth-wrong-token").await;
    let mut config = (*state.config).clone();
    config.api_token = Some("s3cr3t".to_string());
    state.config = Arc::new(config);

    let response = get_with_token(&state, "/api/v1/cache/missing-key", Some("nope")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// A token that shares the configured token's length but differs only in the
/// last byte. This specifically exercises the byte-by-byte fold in
/// `constant_time_eq` rather than the length short-circuit.
#[tokio::test]
async fn auth_rejects_same_length_token_differing_in_last_byte() {
    let mut state = test_state("auth-same-length-wrong").await;
    let mut config = (*state.config).clone();
    config.api_token = Some("s3cr3t".to_string());
    state.config = Arc::new(config);

    let response = get_with_token(&state, "/api/v1/cache/missing-key", Some("s3cr3x")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------
// Auth: configured token enforces the allow direction too.
// ---------------------------------------------------------------------

#[tokio::test]
async fn auth_accepts_correct_token_when_token_configured() {
    let mut state = test_state("auth-correct-token").await;
    let mut config = (*state.config).clone();
    config.api_token = Some("s3cr3t".to_string());
    state.config = Arc::new(config);

    // The request must reach `get_cached` (404, not 401) to prove the
    // matching-token path actually runs `next.run(request)`.
    let response = get_with_token(&state, "/api/v1/cache/missing-key", Some("s3cr3t")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------
// Auth: the open routes stay open even when a token is configured.
// ---------------------------------------------------------------------

#[tokio::test]
async fn auth_leaves_health_route_open_even_when_token_configured() {
    let mut state = test_state("auth-health-open").await;
    let mut config = (*state.config).clone();
    config.api_token = Some("s3cr3t".to_string());
    state.config = Arc::new(config);

    let response = get_with_token(&state, "/api/v1/health", None).await;
    assert_eq!(response.status(), StatusCode::OK);
}

// ---------------------------------------------------------------------
// GET /api/v1/cache/:key
// ---------------------------------------------------------------------

#[tokio::test]
async fn get_cached_returns_404_for_a_key_never_written() {
    let state = test_state("cache-miss").await;
    let response = get_with_token(&state, "/api/v1/cache/does-not-exist", None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_cached_returns_the_stored_response_and_sets_from_cache() {
    let state = test_state("cache-hit").await;
    let key = "hit-key-1";
    let mut stored = minimal_parse_response(key);
    // Stored with from_cache = false, as a freshly-processed response would be.
    stored.stats.from_cache = false;
    state.cache.set(key, &stored).await.expect("seed the cache");

    let response = get_with_token(&state, &format!("/api/v1/cache/{key}"), None).await;
    assert_eq!(response.status(), StatusCode::OK);

    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["cache_key"], key);
    // The handler must flip `from_cache` to true on a hit, regardless of the
    // stored value - this is the one piece of behaviour `get_cached` adds
    // beyond a plain cache lookup.
    assert_eq!(json["stats"]["from_cache"], true);
}
