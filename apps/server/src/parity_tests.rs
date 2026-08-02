// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Endpoint-parity integration tests for issue #900.
//!
//! Issue #843 added the 2D symbol stream (`IfcAnnotation` + `IfcGrid`) to the
//! synchronous `POST /api/v1/parse` JSON response. Issue #900 reported that the
//! other geometry/parse endpoints still omitted it. These tests drive the full
//! route table in-process (via `tower`'s `oneshot`, no socket) against a
//! synthetic IFC that carries both an `IfcAnnotation` circle and an `IfcGrid`,
//! and assert every endpoint now surfaces the same symbolic stream — inline for
//! the JSON/SSE transports, and via `GET /api/v1/parse/symbolic/{cache_key}`
//! for the binary Parquet transports.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::services::process_streaming;
use crate::types::StreamEvent;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use futures::StreamExt;
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

/// Minimal IFC4 model carrying one `IfcAnnotation` (a full-circle disk), one
/// `IfcGrid` with two axes, and one extruded-solid `IfcWall`. The wall gives the
/// geometry endpoints a real mesh; the annotation + grid populate `circles` and
/// `grid_axes` in the symbolic stream.
const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-900 parity fixture'),'2;1');
FILE_NAME('parity.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#40=IFCLOCALPLACEMENT($,#5);

/* IfcAnnotation with a full-circle disk */
#100=IFCCARTESIANPOINT((5.,3.));
#101=IFCAXIS2PLACEMENT2D(#100,$);
#102=IFCCIRCLE(#101,2.0);
#103=IFCSHAPEREPRESENTATION(#2,'Annotation','GeometricCurveSet',(#102));
#104=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#105=IFCANNOTATION('AnnoCircle0000000000001',$,'Bubble',$,$,#40,#104);

/* IfcGrid with two axes */
#200=IFCCARTESIANPOINT((0.,0.));
#201=IFCCARTESIANPOINT((0.,10.));
#202=IFCPOLYLINE((#200,#201));
#203=IFCGRIDAXIS('A',#202,.T.);
#204=IFCCARTESIANPOINT((0.,0.));
#205=IFCCARTESIANPOINT((10.,0.));
#206=IFCPOLYLINE((#204,#205));
#207=IFCGRIDAXIS('1',#206,.T.);
#208=IFCGRID('Grid00000000000000001',$,'MainGrid',$,$,#40,$,(#203),(#207),$);

/* IfcWall with an extruded-solid body so the geometry endpoints emit a mesh */
#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCAXIS2PLACEMENT2D(#300,$);
#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);
#303=IFCDIRECTION((0.,0.,1.));
#304=IFCEXTRUDEDAREASOLID(#302,#5,#303,3.0);
#305=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#304));
#306=IFCPRODUCTDEFINITIONSHAPE($,$,(#305));
#307=IFCWALL('Wall00000000000000001',$,'W1',$,$,#40,#306,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

const BOUNDARY: &str = "ifclite900parityboundary";

/// Build a `multipart/form-data` body with a single `file` field, returning the
/// `(content_type, body_bytes)` pair.
fn multipart_body(content: &[u8]) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"parity.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

/// Construct an `AppState` backed by a fresh temp cache directory unique to
/// `label` so tests don't share cache entries.
async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-test-900-{}-{}",
        std::process::id(),
        label
    ));
    // Start clean — best effort.
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    AppState {
        cache,
        config: Arc::new(Config::from_env()),
        admission: test_admission(8),
    }
}

/// Admission sized for tests: `n` CPU slots, no byte budget, tiny queue wait.
fn test_admission(n: usize) -> Arc<crate::admission::Admission> {
    Arc::new(crate::admission::Admission::new(crate::admission::AdmissionCfg {
        max_concurrent_parses: n,
        mem_budget_bytes: 0,
        queue_depth: 2 * n,
        queue_timeout: std::time::Duration::from_millis(100),
        shed_pct: 85,
    }))
}

#[tokio::test]
async fn saturated_admission_returns_503_with_retry_after() {
    let mut state = test_state("admission-503").await;
    state.admission = test_admission(1);
    // Hold the single CPU slot so the route-level request must be rejected -
    // deterministic, no timing race.
    let _held = state
        .admission
        .acquire(1)
        .await
        .expect("first admit takes the only slot");

    let response = post_fixture(&state, "/api/v1/parse/metadata").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let retry_after = response
        .headers()
        .get(header::RETRY_AFTER)
        .expect("503 carries Retry-After");
    assert!(retry_after.to_str().unwrap().parse::<u64>().unwrap() >= 1);
}

#[tokio::test]
async fn admission_slot_release_readmits() {
    let mut state = test_state("admission-readmit").await;
    state.admission = test_admission(1);
    let held = state.admission.acquire(1).await.expect("take the slot");
    drop(held);
    let response = post_fixture(&state, "/api/v1/parse/metadata").await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn metrics_endpoint_gated_by_config() {
    // Disabled (default): 404.
    let state = test_state("metrics-disabled").await;
    let off = get(&state, "/api/v1/metrics").await;
    assert_eq!(off.status(), StatusCode::NOT_FOUND);

    // Enabled: 200 with the Prometheus text body.
    let mut state = test_state("metrics-enabled").await;
    let mut config = (*state.config).clone();
    config.metrics_enabled = true;
    state.config = Arc::new(config);
    state.admission.set_resident_bytes(4321);
    let on = get(&state, "/api/v1/metrics").await;
    assert_eq!(on.status(), StatusCode::OK);
    let body = axum::body::to_bytes(on.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("ifc_server_resident_bytes 4321"));
    assert!(text.contains("ifc_server_admission_in_flight"));
}

#[tokio::test]
async fn ready_endpoint_reflects_shedding() {
    let mut state = test_state("readiness").await;
    state.admission = Arc::new(crate::admission::Admission::new(crate::admission::AdmissionCfg {
        max_concurrent_parses: 2,
        mem_budget_bytes: 100 * 1024 * 1024,
        queue_depth: 4,
        queue_timeout: std::time::Duration::from_millis(100),
        shed_pct: 85,
    }));
    let ok = get(&state, "/api/v1/ready").await;
    assert_eq!(ok.status(), StatusCode::OK);
    state.admission.set_resident_bytes(95 * 1024 * 1024);
    let shed = get(&state, "/api/v1/ready").await;
    assert_eq!(shed.status(), StatusCode::SERVICE_UNAVAILABLE);
    // Liveness stays static and open regardless of load.
    let health = get(&state, "/api/v1/health").await;
    assert_eq!(health.status(), StatusCode::OK);
}

/// POST the fixture as multipart to `uri`, returning the response.
async fn post_fixture(state: &AppState, uri: &str) -> axum::response::Response {
    post_content(state, uri, FIXTURE.as_bytes()).await
}

async fn post_content(state: &AppState, uri: &str, content: &[u8]) -> axum::response::Response {
    let (content_type, body) = multipart_body(content);
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

#[tokio::test]
async fn issue_1023_parse_endpoints_accept_non_utf8_string_bytes() {
    let state = test_state("issue-1023").await;
    let mut bytes = FIXTURE.as_bytes().to_vec();
    let name = bytes
        .windows(b"MainGrid".len())
        .position(|window| window == b"MainGrid")
        .unwrap();
    bytes[name] = 0xe9;

    let metadata = post_content(&state, "/api/v1/parse/metadata", &bytes).await;
    assert_eq!(metadata.status(), StatusCode::OK);

    let full = post_content(&state, "/api/v1/parse", &bytes).await;
    assert_eq!(full.status(), StatusCode::OK);
}

/// GET `uri` and return the response.
async fn get(state: &AppState, uri: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// Assert a `SymbolicData`-shaped JSON value carries both the grid axes and the
/// annotation circle from the fixture.
fn assert_symbolic_populated(symbolic: &Value, context: &str) {
    let grid_axes = symbolic["grid_axes"]
        .as_array()
        .unwrap_or_else(|| panic!("{context}: symbolic_data.grid_axes missing"));
    assert!(
        !grid_axes.is_empty(),
        "{context}: expected IfcGrid axes in symbolic data, got none"
    );
    let circles = symbolic["circles"]
        .as_array()
        .unwrap_or_else(|| panic!("{context}: symbolic_data.circles missing"));
    assert!(
        !circles.is_empty(),
        "{context}: expected IfcAnnotation circle in symbolic data, got none"
    );
}

/// `POST /api/v1/parse` (JSON) carries `symbolic_data` inline — the issue #843
/// baseline, re-asserted here as the parity reference.
#[tokio::test]
async fn parse_full_includes_symbolic_data_inline() {
    let state = test_state("parse-full").await;
    let response = post_fixture(&state, "/api/v1/parse").await;
    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_symbolic_populated(&json["symbolic_data"], "parse_full");
}

/// `POST /api/v1/parse/parquet` (binary) caches the symbol stream synchronously;
/// `GET /api/v1/parse/symbolic/{cache_key}` then returns it.
#[tokio::test]
async fn parquet_endpoint_exposes_symbolic_via_fetch() {
    let state = test_state("parquet").await;
    let response = post_fixture(&state, "/api/v1/parse/parquet").await;
    assert_eq!(response.status(), StatusCode::OK);

    // The cache key is carried in the X-IFC-Metadata header.
    let metadata_header = response
        .headers()
        .get("X-IFC-Metadata")
        .expect("parquet response must carry X-IFC-Metadata")
        .to_str()
        .unwrap()
        .to_string();
    let metadata: Value = serde_json::from_str(&metadata_header).unwrap();
    let cache_key = metadata["cache_key"].as_str().unwrap().to_string();

    let symbolic_response = get(&state, &format!("/api/v1/parse/symbolic/{cache_key}")).await;
    assert_eq!(symbolic_response.status(), StatusCode::OK);
    let symbolic = body_json(symbolic_response).await;
    assert_symbolic_populated(&symbolic, "parquet symbolic fetch");
}

/// `POST /api/v1/parse/parquet/optimized` likewise caches symbolic data for the
/// fetch endpoint.
#[tokio::test]
async fn optimized_endpoint_exposes_symbolic_via_fetch() {
    let state = test_state("optimized").await;
    let response = post_fixture(&state, "/api/v1/parse/parquet/optimized").await;
    assert_eq!(response.status(), StatusCode::OK);

    let metadata_header = response
        .headers()
        .get("X-IFC-Metadata")
        .expect("optimized parquet response must carry X-IFC-Metadata")
        .to_str()
        .unwrap()
        .to_string();
    let metadata: Value = serde_json::from_str(&metadata_header).unwrap();
    let cache_key = metadata["cache_key"].as_str().unwrap().to_string();

    let symbolic_response = get(&state, &format!("/api/v1/parse/symbolic/{cache_key}")).await;
    assert_eq!(symbolic_response.status(), StatusCode::OK);
    let symbolic = body_json(symbolic_response).await;
    assert_symbolic_populated(&symbolic, "optimized symbolic fetch");
}

/// The symbolic fetch endpoint returns `202 Accepted` for an unknown cache key
/// (mirrors `get_data_model`) rather than erroring.
#[tokio::test]
async fn symbolic_endpoint_pending_for_unknown_key() {
    let state = test_state("symbolic-unknown").await;
    let response = get(&state, "/api/v1/parse/symbolic/does-not-exist-default").await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
}

/// `process_streaming` (the source for both `/parse/stream` and
/// `/parse/parquet-stream`) attaches `symbolic_data` to its `Complete` event.
#[tokio::test]
async fn streaming_complete_event_carries_symbolic_data() {
    let events: Vec<StreamEvent> = process_streaming(
        bytes::Bytes::from_static(FIXTURE.as_bytes()),
        100,
        1000,
        ifc_lite_processing::OpeningFilterMode::Default,
        ifc_lite_processing::TessellationQuality::default(),
        None,
    )
        .collect()
        .await;

    let symbolic = events
        .iter()
        .find_map(|event| match event {
            StreamEvent::Complete { symbolic_data, .. } => Some(symbolic_data),
            _ => None,
        })
        .expect("stream should emit a Complete event");

    assert!(
        !symbolic.grid_axes.is_empty(),
        "streaming Complete should include IfcGrid axes"
    );
    assert!(
        !symbolic.circles.is_empty(),
        "streaming Complete should include IfcAnnotation circle"
    );
}

#[tokio::test]
async fn streaming_zero_batch_sizes_still_complete() {
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        process_streaming(
            bytes::Bytes::from_static(FIXTURE.as_bytes()),
            0,
            0,
            ifc_lite_processing::OpeningFilterMode::Default,
            ifc_lite_processing::TessellationQuality::default(),
            None,
        )
        .collect::<Vec<_>>(),
    )
    .await
    .expect("zero batch sizes must not stall streaming");

    assert!(
        events
            .iter()
            .any(|event| matches!(event, StreamEvent::Complete { .. })),
        "stream should emit a Complete event"
    );
}
