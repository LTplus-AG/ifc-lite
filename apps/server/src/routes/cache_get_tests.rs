// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `GET /api/v1/cache/:key` against an entry that is not a JSON
//! `ParseResponse` (issue #5128).
//!
//! Before this, `get_cached` deserialized whatever `DiskCache::get` read as
//! `ParseResponse` unconditionally, via `?`. A binary Parquet body cached
//! under its real key (`-parquet-v5`, `-parquet-v6`, `-parquet-optimized-v1`)
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
    let key = "some-hash-default-parquet-optimized-v1";
    state
        .cache
        .set_bytes(key, b"not json")
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
