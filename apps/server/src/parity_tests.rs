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
        data_model_in_flight: Arc::new(crate::in_flight::InFlightKeys::default()),
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
        !symbolic.data().grid_axes.is_empty(),
        "streaming Complete should include IfcGrid axes"
    );
    assert!(
        !symbolic.data().circles.is_empty(),
        "streaming Complete should include IfcAnnotation circle"
    );
}

/// #4706: a model whose `IfcSite` placement is translated and rotated. The
/// pipeline meshes it in the site-local frame; the grid axis runs (0,0)-(4,0)
/// in that frame, along the bottom edge of the 4 x 1 x 2 box, so both streams
/// describe the same two points. Same shape as the processing-crate fixture in
/// `rust/processing/tests/issue_4706_symbolic_shares_the_mesh_frame.rs`,
/// carried here to pin the ROUTES that pass the frame in.
const SITE_LOCAL_FIXTURE: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-4706 site-local fixture'),'2;1');
FILE_NAME('site-local.ifc','2026-09-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
#30=IFCCARTESIANPOINT((500.,300.,0.));
#31=IFCDIRECTION((0.,0.,1.));
#32=IFCDIRECTION((0.866025403784439,0.5,0.));
#33=IFCAXIS2PLACEMENT3D(#30,#31,#32);
#34=IFCLOCALPLACEMENT($,#33);
#35=IFCSITE('1s1tEAnIV5BixApwp1Yzp0',$,'site',$,$,#34,$,$,.ELEMENT.,$,$,$,$,$);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCCARTESIANPOINT((4.,0.));
#10=IFCCARTESIANPOINT((4.,1.));
#11=IFCCARTESIANPOINT((0.,1.));
#12=IFCPOLYLINE((#8,#9,#10,#11,#8));
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);
#14=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCEXTRUDEDAREASOLID(#13,#15,#16,2.);
#18=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#17));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT(#34,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'box',$,$,#22,#19,$,$);
#40=IFCCARTESIANPOINT((0.,0.,0.));
#41=IFCCARTESIANPOINT((4.,0.,0.));
#42=IFCPOLYLINE((#40,#41));
#43=IFCGRIDAXIS('A',#42,.T.);
#50=IFCGRID('2s1tEAnIV5BixApwp1Yzp1',$,'grid',$,$,#34,$,(#43),$,$);
ENDSEC;
END-ISO-10303-21;
"##;

/// The grid axis endpoints of a `SymbolicData`-shaped JSON value, as plan
/// pairs.
fn grid_axis_endpoints(symbolic: &Value, context: &str) -> Vec<[f64; 4]> {
    let axes = symbolic["grid_axes"]
        .as_array()
        .unwrap_or_else(|| panic!("{context}: symbolic_data.grid_axes missing"));
    assert_eq!(axes.len(), 1, "{context}: one axis in the fixture");
    axes.iter()
        .map(|axis| {
            let e = axis["endpoints"].as_array().expect("endpoints");
            [
                e[0].as_f64().unwrap(),
                e[1].as_f64().unwrap(),
                e[2].as_f64().unwrap(),
                e[3].as_f64().unwrap(),
            ]
        })
        .collect()
}

/// Two axis lists agree to within a millimetre. Not `assert_eq!`: the routed
/// responses print their `f32` coordinates as decimal text and parse back as
/// `f64`, while the in-process stream's `serde_json::to_value` widens the same
/// `f32` bit pattern directly, so identical values read as 4.0000086 and
/// 4.000008583068848.
fn assert_axes_match(got: &[[f64; 4]], want: &[[f64; 4]], context: &str) {
    assert_eq!(got.len(), want.len(), "{context}: axis count");
    for (axis, (got, want)) in got.iter().zip(want.iter()).enumerate() {
        for i in 0..4 {
            assert!(
                (got[i] - want[i]).abs() < 1e-3,
                "{context}: axis {axis} component {i}: got {} want {}",
                got[i],
                want[i]
            );
        }
    }
}

/// #4706: the symbols a response carries must be in the frame its MESHES are
/// in. The fixture's grid axis runs along the box's bottom edge in the site
/// frame, so each endpoint has to land on a box vertex of the same response —
/// a shared point, not a coordinate-space flag.
///
/// The JSON route is where both streams are visible together. The three other
/// routes (flat parquet, optimized parquet, SSE streaming) ship their symbols
/// separately, so they are pinned against the JSON route's: each passes the
/// frame in at its own call site, and a route left on the self-resolved
/// overlay frame answers 583 m away from this.
#[tokio::test]
async fn issue_4706_every_route_ships_symbols_in_its_mesh_frame() {
    let state = test_state("4706-site-local").await;
    let response = post_content(&state, "/api/v1/parse", SITE_LOCAL_FIXTURE.as_bytes()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(
        json["mesh_coordinate_space"].as_str(),
        Some("site_local"),
        "a site translated (500, 300) selects the site-local tier"
    );

    // Every box vertex in the wire frame. The JSON transport is Y-up
    // (`services::axis`), so an IFC `(x, y, z)` arrives as `(x, z, -y)` and
    // the symbolic plan pair `(x, -y)` is its first and third components.
    let mut plan_vertices: Vec<(f64, f64)> = Vec::new();
    for mesh in json["meshes"].as_array().expect("meshes") {
        // `origin` is omitted from the wire when it is the zero vector.
        let origin = mesh["origin"].as_array();
        let component = |i: usize| origin.map_or(0.0, |o| o[i].as_f64().unwrap());
        let (ox, oz) = (component(0), component(2));
        let positions = mesh["positions"].as_array().expect("positions");
        for p in positions.chunks_exact(3) {
            plan_vertices.push((
                p[0].as_f64().unwrap() + ox,
                p[2].as_f64().unwrap() + oz,
            ));
        }
    }
    assert!(!plan_vertices.is_empty(), "the box must mesh");

    let endpoints = grid_axis_endpoints(&json["symbolic_data"], "parse_full");
    for point in [
        (endpoints[0][0], endpoints[0][1]),
        (endpoints[0][2], endpoints[0][3]),
    ] {
        let distance = plan_vertices
            .iter()
            .map(|v| ((point.0 - v.0).powi(2) + (point.1 - v.1).powi(2)).sqrt())
            .fold(f64::INFINITY, f64::min);
        assert!(
            distance < 2e-3,
            "grid endpoint {point:?} is {distance} m from the nearest mesh vertex of the \
             same response; the symbols are not in the frame the meshes are in"
        );
    }

    // The binary routes cache the stream; the fetch endpoint returns it.
    for endpoint in ["/api/v1/parse/parquet", "/api/v1/parse/parquet/optimized"] {
        let binary_state = test_state(&format!("4706-{}", endpoint.replace('/', "-"))).await;
        let response = post_content(&binary_state, endpoint, SITE_LOCAL_FIXTURE.as_bytes()).await;
        assert_eq!(response.status(), StatusCode::OK, "{endpoint}");
        let metadata: Value = serde_json::from_str(
            response
                .headers()
                .get("X-IFC-Metadata")
                .expect("X-IFC-Metadata")
                .to_str()
                .unwrap(),
        )
        .unwrap();
        let cache_key = metadata["cache_key"].as_str().unwrap().to_string();
        let fetched = get(&binary_state, &format!("/api/v1/parse/symbolic/{cache_key}")).await;
        assert_eq!(fetched.status(), StatusCode::OK, "{endpoint}");
        assert_axes_match(
            &grid_axis_endpoints(&body_json(fetched).await, endpoint),
            &endpoints,
            endpoint,
        );
    }

    // The SSE stream carries its symbols on the Complete event beside the same
    // `mesh_coordinate_space`.
    let events: Vec<StreamEvent> = process_streaming(
        bytes::Bytes::from_static(SITE_LOCAL_FIXTURE.as_bytes()),
        100,
        1000,
        ifc_lite_processing::OpeningFilterMode::Default,
        ifc_lite_processing::TessellationQuality::default(),
        None,
    )
    .collect()
    .await;
    let streamed = events
        .iter()
        .find_map(|event| match event {
            StreamEvent::Complete { symbolic_data, .. } => Some(symbolic_data),
            _ => None,
        })
        .expect("stream should emit a Complete event");
    assert_axes_match(
        &grid_axis_endpoints(&serde_json::to_value(streamed.data()).unwrap(), "streaming"),
        &endpoints,
        "the SSE stream",
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

#[tokio::test]
async fn issue_4459_old_symbolic_cache_cannot_keep_binary_routes_stale() {
    use crate::routes::parse::cache_keys::{request_cache_key, symbolic_cache_key};
    for endpoint in ["/api/v1/parse/parquet", "/api/v1/parse/parquet/optimized"] {
        let state = test_state(&format!("4459-{}", endpoint.replace('/', "-"))).await;
        let key = request_cache_key(FIXTURE.as_bytes(), &Default::default(), Default::default());
        let current = symbolic_cache_key(&key);
        let first = post_fixture(&state, endpoint).await;
        assert_eq!(first.status(), StatusCode::OK);
        let first_body = to_bytes(first.into_body(), usize::MAX).await.unwrap();
        let symbols = state.cache.get_bytes(&current).await.unwrap().unwrap();
        state.cache.remove(&current).await.unwrap();
        // v1 predates direct fill provenance (#4459); v2 predates the mesh-frame
        // rebase (#4665); v3 predates re-basing by the frame the server's own
        // meshes were baked in, so it keeps the site translation and rotation
        // they dropped (#4706). None may be served or replayed. Planted after
        // the removal, so a reverted bump (where one of them IS `current`)
        // cannot be removed here.
        for retired in ["-symbolic-v1", "-symbolic-v2", "-symbolic-v3"] {
            state.cache.set_bytes(&format!("{key}{retired}"), &symbols).await.unwrap();
        }
        let pending = get(&state, &format!("/api/v1/parse/symbolic/{key}")).await;
        assert_eq!(pending.status(), StatusCode::ACCEPTED, "GET /symbolic must not serve a retired entry");
        let second = post_fixture(&state, endpoint).await;
        assert_eq!(second.status(), StatusCode::OK);
        let second_body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        assert_eq!(first_body, second_body, "symbolic freshness must preserve geometry bytes");
        assert!(state.cache.get_bytes(&current).await.unwrap().is_some(),
            "old sidecar must trigger a parse that writes the current schema");
    }
}

#[tokio::test]
async fn issue_4459_old_json_response_is_reparsed_without_changing_request_identity() {
    use crate::routes::parse::cache_keys::{request_cache_key, json_response_cache_key};
    let state = test_state("4459-old-json").await;
    let key = request_cache_key(FIXTURE.as_bytes(), &Default::default(), Default::default());
    let current = json_response_cache_key(&key);
    let first = post_fixture(&state, "/api/v1/parse").await;
    assert_eq!(first.status(), StatusCode::OK);
    let bytes = to_bytes(first.into_body(), usize::MAX).await.unwrap();
    // The route writes in a spawned cache task; wait until that original write
    // is visible before removing it, so it cannot race the stale-cache control.
    for _ in 0..100 {
        if state.cache.get_bytes(&current).await.unwrap().is_some() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(state.cache.get_bytes(&current).await.unwrap().is_some());
    state.cache.remove(&current).await.unwrap();
    // v2 predates direct fill provenance (#4459); v3 predates the georeference
    // factor fields (#4675); v4 predates the embedded symbols moving into the
    // frame the same response's meshes are in (#4706). None may replay.
    // Planted after the removal, so a reverted bump (where one of them IS
    // `current`) cannot be removed here.
    for retired in ["-json-v2", "-json-v3", "-json-v4"] {
        state.cache.set_bytes(&format!("{key}{retired}"), &bytes).await.unwrap();
    }
    let second = post_fixture(&state, "/api/v1/parse").await;
    assert_eq!(second.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&to_bytes(second.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["cache_key"], key);
    assert_eq!(body["stats"]["from_cache"], false, "must not replay a retired JSON response version");
}

/// #4706, second half: the JSON route answers a warm `CACHE_DIR` from the
/// stored response BEFORE any extraction runs (`json.rs`), and that response
/// carries `symbolic_data` inside it. Bumping the symbolic sidecar alone
/// therefore left every file already on disk serving old-frame symbols from
/// the main endpoint, indefinitely.
///
/// The control is what a pre-change deployment actually wrote: this response
/// with its symbols in the frame the overlay extractor chooses, taken from
/// that extractor (still the browser path's entry point) rather than
/// hand-written. It is planted under the retired `-json-v4` suffix once the
/// current entry is gone, so a reverted bump - where `-json-v4` IS the current
/// key - replays it. That run fails here with the axis at (500, -300) where
/// the live parse puts it at (0, 0).
#[tokio::test]
async fn issue_4706_a_response_cached_before_the_frame_fix_is_not_replayed() {
    use crate::routes::parse::cache_keys::{json_response_cache_key, request_cache_key};
    let state = test_state("4706-json-replay").await;
    let key = request_cache_key(
        SITE_LOCAL_FIXTURE.as_bytes(),
        &Default::default(),
        Default::default(),
    );
    let current = json_response_cache_key(&key);
    let first = post_content(&state, "/api/v1/parse", SITE_LOCAL_FIXTURE.as_bytes()).await;
    assert_eq!(first.status(), StatusCode::OK);
    let live: Value =
        serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await.unwrap()).unwrap();
    let live_axes = grid_axis_endpoints(&live["symbolic_data"], "live parse");
    // The route writes in a spawned cache task; wait for that write before
    // replacing it, so the plant cannot be raced away. Same budget as
    // `json_tests.rs`'s wait on this exact write (400 x 25 ms): a loaded
    // runner with `cargo test`'s thread fan-out does miss a 500 ms one.
    for _ in 0..400 {
        if state.cache.get_bytes(&current).await.unwrap().is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let written = state
        .cache
        .get_bytes(&current)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("the parse must write {current} within 10 s"));
    let mut stale: Value = serde_json::from_slice(&written).unwrap();
    stale["symbolic_data"] = serde_json::to_value(
        ifc_lite_processing::extract_symbolic_data_with_provenance(SITE_LOCAL_FIXTURE),
    )
    .unwrap();
    let stale_axes = grid_axis_endpoints(&stale["symbolic_data"], "the pre-change response");
    assert!(
        (stale_axes[0][0] - live_axes[0][0]).abs() > 100.0,
        "the control must actually differ from the live parse: {stale_axes:?} vs {live_axes:?}"
    );
    // Planted under the RETIRED suffix, after the current entry is gone: with
    // the bump reverted, `-json-v4` IS the current key and this entry is
    // served straight back.
    state.cache.remove(&current).await.unwrap();
    state
        .cache
        .set_bytes(&format!("{key}-json-v4"), &serde_json::to_vec(&stale).unwrap())
        .await
        .unwrap();

    let second = post_content(&state, "/api/v1/parse", SITE_LOCAL_FIXTURE.as_bytes()).await;
    assert_eq!(second.status(), StatusCode::OK);
    let served: Value =
        serde_json::from_slice(&to_bytes(second.into_body(), usize::MAX).await.unwrap()).unwrap();
    // The damage first, so a reverted bump reports the 579 m rather than a
    // bare boolean. `from_cache` after it is the mechanism, and the two are
    // redundant by construction: a response that is not a replay is a fresh
    // parse of these bytes, which is what produced `live_axes`. Both are kept
    // because the frame is what a client suffers and the flag is what the
    // route decides.
    assert_axes_match(
        &grid_axis_endpoints(&served["symbolic_data"], "after the plant"),
        &live_axes,
        "the re-parsed response",
    );
    assert_eq!(
        served["stats"]["from_cache"], false,
        "a response cached under the retired key must not be replayed"
    );
}
