// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mutation-audit round 33: the health/readiness/info bodies were previously
//! only exercised through their HTTP status codes (`parity_tests.rs`); the
//! JSON payload fields (`status`, `service`, endpoint table) were never
//! asserted, so a wrong string or a dropped/mis-mapped endpoint entry would
//! pass silently.

use super::*;
use crate::admission::{Admission, AdmissionCfg};
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::AppState;
use axum::body::to_bytes;
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

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-health-tests-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    AppState {
        cache,
        config: Arc::new(Config::from_env()),
        admission: test_admission(8),
    }
}

/// `check()`'s whole reason to exist is to report `"healthy"` — the liveness
/// probe consumer keys off that literal string, not just the 200 status.
#[tokio::test]
async fn check_reports_healthy_status_and_service_name() {
    let body = check().await.0;
    assert_eq!(body.status, "healthy");
    assert_eq!(body.service, "ifc-lite-server");
    assert_eq!(body.version, env!("CARGO_PKG_VERSION"));
}

/// `ready()` must flip BOTH the HTTP status code and the JSON `status` field
/// together on each side of the shedding boundary — not just the code, which
/// `parity_tests::ready_endpoint_reflects_shedding` already pins.
#[tokio::test]
async fn ready_body_matches_shedding_state_on_both_sides() {
    let mut state = test_state("ready-body").await;
    state.admission = test_admission(2);

    // Not shedding: 200 + `"status":"ready"`.
    let ok = ready(axum::extract::State(state.clone())).await;
    assert_eq!(ok.status(), axum::http::StatusCode::OK);
    let ok_body = to_bytes(ok.into_body(), usize::MAX).await.unwrap();
    let ok_text = String::from_utf8(ok_body.to_vec()).unwrap();
    assert!(
        ok_text.contains("\"status\":\"ready\""),
        "expected ready status in body, got: {ok_text}"
    );

    // Shedding: 503 + `"status":"shedding"`.
    state.admission.set_resident_bytes(95 * 1024 * 1024);
    let shed = ready(axum::extract::State(state.clone())).await;
    assert_eq!(shed.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    let shed_body = to_bytes(shed.into_body(), usize::MAX).await.unwrap();
    let shed_text = String::from_utf8(shed_body.to_vec()).unwrap();
    assert!(
        shed_text.contains("\"status\":\"shedding\""),
        "expected shedding status in body, got: {shed_text}"
    );
}

/// `info()` advertises the actual route table; a dropped or mis-described
/// entry (e.g. the cache-retrieval route) would previously go unnoticed
/// because nothing ever hit `GET /`.
#[tokio::test]
async fn info_lists_service_metadata_and_every_documented_endpoint() {
    let body = info().await.0;
    assert_eq!(body.service, "ifc-lite-server");
    assert_eq!(body.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(body.description, "High-performance IFC processing server");
    assert_eq!(body.endpoints.len(), 5);

    let has = |method: &str, path: &str| {
        body.endpoints
            .iter()
            .any(|e| e.method == method && e.path == path)
    };
    assert!(has("GET", "/api/v1/health"));
    assert!(has("POST", "/api/v1/parse"));
    assert!(has("POST", "/api/v1/parse/stream"));
    assert!(has("POST", "/api/v1/parse/metadata"));
    assert!(has("GET", "/api/v1/cache/:key"));
}
