// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mutation-audit round 33: `POST /api/v1/parse/parquet-stream` was never
//! driven through the real HTTP route by any existing test — only the
//! underlying `process_streaming` service function was exercised directly
//! (see `parity_tests.rs`). That leaves the route's own event mapping
//! (`StreamEvent` -> `ParquetStreamEvent`, in particular `Batch { mesh_count,
//! batch_number, .. }`) completely uncovered: a mutation that swaps
//! `mesh_count` and `batch_number` compiles cleanly (both are `usize`) and
//! nothing here caught it before this file existed.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

/// Two `IfcWall`s with extruded-solid bodies, small enough to land in a
/// single batch, but with a mesh count (2) distinguishable from the batch
/// number (1) — the property a mesh_count/batch_number swap would break.
const TWO_WALL_FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('round33 parquet-stream fixture'),'2;1');
FILE_NAME('r33.ifc','2026-08-02T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#40=IFCLOCALPLACEMENT($,#5);

#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCAXIS2PLACEMENT2D(#300,$);
#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);
#303=IFCDIRECTION((0.,0.,1.));
#304=IFCEXTRUDEDAREASOLID(#302,#5,#303,3.0);
#305=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#304));
#306=IFCPRODUCTDEFINITIONSHAPE($,$,(#305));
#307=IFCWALL('Wall00000000000000001',$,'W1',$,$,#40,#306,$,$);

#410=IFCCARTESIANPOINT((5.,0.));
#411=IFCAXIS2PLACEMENT3D(#410,$,$);
#412=IFCLOCALPLACEMENT($,#411);
#413=IFCCARTESIANPOINT((0.,0.));
#414=IFCAXIS2PLACEMENT2D(#413,$);
#415=IFCRECTANGLEPROFILEDEF(.AREA.,$,#414,1.0,0.2);
#416=IFCDIRECTION((0.,0.,1.));
#417=IFCEXTRUDEDAREASOLID(#415,#411,#416,3.0);
#418=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#417));
#419=IFCPRODUCTDEFINITIONSHAPE($,$,(#418));
#420=IFCWALL('Wall00000000000000002',$,'W2',$,$,#412,#419,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

const BOUNDARY: &str = "ifclite900r33parquetstreamboundary";

fn multipart_body(content: &[u8]) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"r33.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-parquet-stream-test-{}-{}",
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
                queue_timeout: std::time::Duration::from_millis(200),
                shed_pct: 85,
            },
        )),
    }
}

/// Parses an SSE body (`data: {json}\n\n` frames) into the JSON payloads,
/// in order.
fn parse_sse_events(text: &str) -> Vec<Value> {
    text.split("\n\n")
        .filter_map(|frame| frame.strip_prefix("data: "))
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::from_str(s).unwrap_or_else(|e| panic!("bad SSE JSON {s:?}: {e}")))
        .collect()
}

#[tokio::test]
async fn parquet_stream_batch_reports_actual_mesh_count_and_batch_number() {
    let state = test_state("batch-fields").await;
    let (content_type, body) = multipart_body(TWO_WALL_FIXTURE.as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/parquet-stream")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();

    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        to_bytes(response.into_body(), usize::MAX),
    )
    .await
    .expect("SSE stream should finish")
    .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    let events = parse_sse_events(&text);
    assert!(!events.is_empty(), "expected at least one SSE event");

    // `start` carries the request-level cache key.
    let start = events
        .iter()
        .find(|e| e["type"] == "start")
        .expect("stream should emit a start event");
    assert!(!start["cache_key"].as_str().unwrap_or("").is_empty());

    // Both walls fit in the default batch size, so there is exactly one
    // `batch` event: mesh_count must reflect the 2 meshes actually in it,
    // and batch_number must be 1 (1-indexed) — a swap between the two
    // fields would flip these and still type-check.
    let batches: Vec<&Value> = events.iter().filter(|e| e["type"] == "batch").collect();
    assert_eq!(batches.len(), 1, "expected a single batch for 2 small walls");
    assert_eq!(batches[0]["mesh_count"], serde_json::json!(2));
    assert_eq!(batches[0]["batch_number"], serde_json::json!(1));
    assert!(
        !batches[0]["data"].as_str().unwrap_or("").is_empty(),
        "batch must carry base64 Parquet data"
    );

    // `complete` carries non-trivial stats/metadata for the 2-wall model.
    let complete = events
        .iter()
        .find(|e| e["type"] == "complete")
        .expect("stream should emit a complete event");
    assert!(complete["stats"].is_object());
    assert!(complete["metadata"].is_object());
}
