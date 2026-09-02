// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end tests for `DELETE /api/v1/cache/:hash` (issue #3636), driven
//! through the real route table (`build_router` + `tower`'s `oneshot`, no
//! socket) rather than calling `DiskCache` directly, so these pin the
//! observable behaviour a client actually sees: a genuine cache hit before
//! deletion, a genuine re-parse after it, and an unrelated file's cache entry
//! surviving the call.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

const BOUNDARY: &str = "ifclite-3636-cache-delete-boundary";

/// One extruded-solid `IfcWall`, distinguished from `OTHER_FIXTURE` only by
/// the wall's GlobalId so the two hash to different cache prefixes.
const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3636 cache-delete fixture'),'2;1');
FILE_NAME('a.ifc','2026-06-01T00:00:00',(''),(''),'','','');
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
#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCAXIS2PLACEMENT2D(#300,$);
#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);
#303=IFCDIRECTION((0.,0.,1.));
#304=IFCEXTRUDEDAREASOLID(#302,#5,#303,3.0);
#305=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#304));
#306=IFCPRODUCTDEFINITIONSHAPE($,$,(#305));
#307=IFCWALL('WallAAAAAAAAAAAAAAAAAA',$,'W1',$,$,#40,#306,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Byte-different from `FIXTURE` (different `IfcWall` GlobalId), so it hashes
/// to a different cache prefix — the control for "unrelated entries survive".
const OTHER_FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3636 cache-delete control fixture'),'2;1');
FILE_NAME('b.ifc','2026-06-01T00:00:00',(''),(''),'','','');
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
#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCAXIS2PLACEMENT2D(#300,$);
#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);
#303=IFCDIRECTION((0.,0.,1.));
#304=IFCEXTRUDEDAREASOLID(#302,#5,#303,3.0);
#305=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#304));
#306=IFCPRODUCTDEFINITIONSHAPE($,$,(#305));
#307=IFCWALL('WallBBBBBBBBBBBBBBBBBB',$,'W1',$,$,#40,#306,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn multipart_body(content: &[u8], filename: &str) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-3636-cache-delete-{}-{}",
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

async fn parse(state: &AppState, content: &[u8], filename: &str) -> Value {
    let (content_type, body) = multipart_body(content, filename);
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn delete_cache(state: &AppState, hash: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/cache/{hash}"))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

/// The `sha256` content hash `DELETE /api/v1/cache/:hash` is keyed by --
/// exactly what `DiskCache::generate_key` (and every parse route) derives
/// from the file bytes.
fn content_hash(content: &[u8]) -> String {
    DiskCache::generate_key(content)
}

/// `POST /api/v1/parse` caches its result via a detached `tokio::spawn`
/// (the response returns before the write lands, so the very next request
/// can race it) -- poll for the write to land before asserting a HIT,
/// bounded so a genuine caching regression fails the test instead of
/// hanging.
async fn wait_for_cache_hit(state: &AppState, content: &[u8], filename: &str) -> Value {
    for _ in 0..200 {
        let response = parse(state, content, filename).await;
        if response["stats"]["from_cache"] == Value::Bool(true) {
            return response;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("cache write never landed after repeated polling");
}

/// The behaviour a user actually cares about: parse once (cold), parse
/// again (cache HIT, `from_cache: true`), delete the entry, then parse a
/// third time and see a genuine re-parse (`from_cache: false`) rather than a
/// stale cached answer.
#[tokio::test]
async fn delete_forces_the_next_parse_to_genuinely_reparse() {
    let state = test_state("reparse").await;

    let first = parse(&state, FIXTURE.as_bytes(), "a.ifc").await;
    assert_eq!(first["stats"]["from_cache"], Value::Bool(false));

    wait_for_cache_hit(&state, FIXTURE.as_bytes(), "a.ifc").await;

    let hash = content_hash(FIXTURE.as_bytes());
    let delete_response = delete_cache(&state, &hash).await;
    assert_eq!(delete_response.status(), StatusCode::OK);
    let delete_body: Value = serde_json::from_slice(
        &to_bytes(delete_response.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    assert!(
        delete_body["deleted"].as_u64().unwrap() >= 1,
        "expected at least one entry removed, got {delete_body}"
    );

    let third = parse(&state, FIXTURE.as_bytes(), "a.ifc").await;
    assert_eq!(
        third["stats"]["from_cache"],
        Value::Bool(false),
        "post-delete parse must genuinely re-parse, not serve a stale cached answer"
    );
}

/// Deleting a hash nothing was ever cached under does not error -- a client
/// can call this unconditionally ("drop whatever is cached for this model,
/// if anything") without checking existence first, and retry safely.
#[tokio::test]
async fn deleting_an_unknown_hash_is_a_200_no_op() {
    let state = test_state("unknown-hash").await;
    let response = delete_cache(&state, "0000000000000000000000000000000000000000000000000000000000000000").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["deleted"], Value::from(0));
}

/// Control: deleting one file's cache entries must not disturb a DIFFERENT
/// file's entries, which is only exercisable through the real route table
/// (the low-level `remove_by_key_prefix` unit tests in `services::cache`
/// already cover the prefix-matching logic directly).
#[tokio::test]
async fn delete_does_not_disturb_an_unrelated_file_cached_entry() {
    let state = test_state("control").await;

    parse(&state, FIXTURE.as_bytes(), "a.ifc").await;
    parse(&state, OTHER_FIXTURE.as_bytes(), "b.ifc").await;
    wait_for_cache_hit(&state, FIXTURE.as_bytes(), "a.ifc").await;
    wait_for_cache_hit(&state, OTHER_FIXTURE.as_bytes(), "b.ifc").await;

    let hash = content_hash(FIXTURE.as_bytes());
    let delete_response = delete_cache(&state, &hash).await;
    assert_eq!(delete_response.status(), StatusCode::OK);

    // FIXTURE re-parses (its entries are gone).
    let reparsed = parse(&state, FIXTURE.as_bytes(), "a.ifc").await;
    assert_eq!(reparsed["stats"]["from_cache"], Value::Bool(false));

    // OTHER_FIXTURE is untouched and still serves from cache.
    let other_still_cached = parse(&state, OTHER_FIXTURE.as_bytes(), "b.ifc").await;
    assert_eq!(
        other_still_cached["stats"]["from_cache"],
        Value::Bool(true),
        "an unrelated file's cache entry must survive deleting a different file's hash"
    );
}
