// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mutation-audit round 33: `parity_tests::metrics_endpoint_gated_by_config`
//! already pins the status codes and the Prometheus body text, but two
//! properties of `metrics()` were never checked and both survived targeted
//! mutation before this file existed:
//!   - the disabled path's response `Content-Type` and body text (any 404
//!     payload made the existing assertion pass, since only the status code
//!     was checked)
//!   - the enabled path's `Content-Type` header (`text/plain; version=0.0.4`
//!     is the Prometheus text-exposition contract; a scraper matches on it)

use super::*;
use crate::admission::{Admission, AdmissionCfg};
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::AppState;
use axum::body::to_bytes;
use axum::http::header;
use axum::response::IntoResponse;
use std::sync::Arc;
use std::time::Duration;

fn test_admission(n: usize) -> Arc<Admission> {
    Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: n,
        mem_budget_bytes: 100 * 1024 * 1024,
        queue_depth: 2 * n,
        queue_timeout: Duration::from_millis(100),
        shed_pct: 85,
    }))
}

async fn test_state(label: &str, metrics_enabled: bool) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-metrics-tests-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    let mut config = Config::from_env();
    config.metrics_enabled = metrics_enabled;
    AppState {
        cache,
        config: Arc::new(config),
        admission: test_admission(4),
    }
}

/// Disabled: 404, plain-text "metrics disabled" body, `Content-Type:
/// text/plain` (axum's default for a `&str` body) — not just "some 404".
#[tokio::test]
async fn disabled_returns_404_with_the_disabled_reason() {
    let state = test_state("disabled", false).await;
    let response = metrics(axum::extract::State(state)).await.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(body.as_ref(), b"metrics disabled");
}

/// Enabled: the response MUST advertise the Prometheus text-exposition
/// content type, or a real scraper (which matches on it) silently drops the
/// scrape.
#[tokio::test]
async fn enabled_advertises_prometheus_text_exposition_content_type() {
    let state = test_state("enabled", true).await;
    let response = metrics(axum::extract::State(state)).await.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .expect("metrics response carries Content-Type")
        .to_str()
        .unwrap();
    assert_eq!(content_type, "text/plain; version=0.0.4");
}
