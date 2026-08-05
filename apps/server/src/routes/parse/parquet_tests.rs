// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Handler-level tests for the binary Parquet parse endpoint's cache-hit path
//! (`parse_parquet`, `POST /api/v1/parse/parquet`) — never mutation-tested
//! before round 31. The service-level Parquet serializers already have
//! coverage in `services::parquet::parquet_tests`; this file targets the
//! route's own cache lookup, which the service tests can't reach.

use super::cache_keys::request_cache_key;
use super::ParseQuery;
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use ifc_lite_processing::TessellationQuality;
use std::sync::Arc;
use tower::ServiceExt;

const BOUNDARY: &str = "ifclite-r31-parquet-boundary";

fn multipart_body(content: &[u8]) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-r31-parquet-{}-{}",
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
                max_concurrent_parses: 4,
                mem_budget_bytes: 0,
                queue_depth: 8,
                queue_timeout: std::time::Duration::from_millis(100),
                shed_pct: 85,
            },
        )),
    }
}

/// A cache HIT in `parse_parquet` must return the geometry blob as the body
/// and the metadata blob as the `X-IFC-Metadata` header — NOT the other way
/// around. Seeds the two cache entries directly (bypassing the write path
/// entirely, so this is deterministic, no background-task race) with
/// distinguishable payloads, then asserts each lands on the side the client
/// actually reads it from.
#[tokio::test]
async fn parquet_cache_hit_does_not_swap_body_and_metadata() {
    let state = test_state("swap").await;
    let content = b"not-a-real-ifc-file-cache-hit-probe";
    let query = ParseQuery::default();
    let cache_key = request_cache_key(content, &query, TessellationQuality::default());
    let parquet_key = format!("{cache_key}-parquet-v4");
    let metadata_key = format!("{cache_key}-parquet-metadata-v4");

    state
        .cache
        .set_bytes(&parquet_key, b"GEOMETRY-PAYLOAD")
        .await
        .expect("seed geometry cache entry");
    state
        .cache
        .set_bytes(&metadata_key, b"METADATA-PAYLOAD")
        .await
        .expect("seed metadata cache entry");

    let (content_type, body) = multipart_body(content);
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/parquet")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let header_value = response
        .headers()
        .get("X-IFC-Metadata")
        .expect("cache hit must carry X-IFC-Metadata")
        .to_str()
        .unwrap()
        .to_string();
    let body_bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    assert_eq!(header_value, "METADATA-PAYLOAD");
    assert_eq!(&body_bytes[..], b"GEOMETRY-PAYLOAD");
}
