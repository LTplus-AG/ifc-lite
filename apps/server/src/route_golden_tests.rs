// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Route body golden hashes (#7671, charter #7670 §2 T3, gate G8).
//!
//! The route tests assert shapes; nothing pinned a whole response body. Each
//! route's body is pinned per fixture in `tests/golden/route-<route>.json`,
//! driven in-process through the same `oneshot` helpers as `parity_tests`.
//! Wall-clock fields (every JSON key ending in `_ms`, in a JSON body or an
//! SSE `data:` payload) are zeroed before hashing: they are the one part of a
//! body that is not a function of the input. The SSE batch boundaries are
//! pinned as they are; they were measured identical under
//! `RAYON_NUM_THREADS` 1, 2, 4 and the default. The hash, the file format and the re-pin rule are shared with the
//! export corpus (`rust/export/tests/support/golden.rs`), and the fixture rule
//! with the export unit tests (`IFC_LITE_REQUIRE_FIXTURES`).

#[path = "../../../rust/export/src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;
#[path = "../../../rust/export/tests/support/golden.rs"]
#[allow(dead_code)] // shared helper; this binary uses `check`, not `finish`
mod golden;

use std::path::Path;

use axum::body::to_bytes;
use axum::http::StatusCode;
use golden::Golden;
use serde_json::Value;

use crate::parity_tests::{get, post_content, test_state, FIXTURE};

/// `(key, catalogued path)`; `None` is the in-tree parity fixture, which
/// carries an annotation, a grid and a wall, so every route has content.
const FIXTURES: &[(&str, Option<&str>)] = &[
    ("parity-fixture", None),
    ("IfcOpenHouse_IFC4", Some("ara3d/IfcOpenHouse_IFC4.ifc")),
];

/// Every route whose body is a function of the uploaded file. Health, cache
/// and metrics bodies describe the server, not the model.
const ROUTES: &[&str] =
    &["stream", "parquet-stream", "parse", "metadata", "parquet", "parquet-optimized", "symbolic", "data-model"];

fn fixtures() -> Vec<(&'static str, Vec<u8>)> {
    FIXTURES
        .iter()
        .filter_map(|(key, path)| match path {
            None => Some((*key, FIXTURE.as_bytes().to_vec())),
            Some(path) => test_support::fixture_opt(path).map(|b| (*key, b)),
        })
        .collect()
}

/// Zero every `*_ms` number, recursively: timings, not output.
fn zero_timings(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if key.ends_with("_ms") && v.is_number() {
                    *v = Value::from(0);
                } else {
                    zero_timings(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(zero_timings),
        _ => {}
    }
}

fn normalised_json(bytes: &[u8]) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(bytes).expect("route body is JSON");
    zero_timings(&mut value);
    serde_json::to_vec(&value).unwrap()
}

/// An SSE body with each JSON `data:` payload normalised like a JSON body.
fn normalised_sse(bytes: &[u8]) -> Vec<u8> {
    let text = std::str::from_utf8(bytes).expect("SSE is UTF-8");
    let lines: Vec<String> = text
        .lines()
        .map(|line| match line.strip_prefix("data: ").map(serde_json::from_str::<Value>) {
            Some(Ok(mut value)) => {
                zero_timings(&mut value);
                format!("data: {value}")
            }
            _ => line.to_string(),
        })
        .collect();
    lines.join("\n").into_bytes()
}

/// The status and body of `response`, after `200 OK` is asserted.
async fn ok_body(response: axum::response::Response, what: &str) -> (axum::http::HeaderMap, Vec<u8>) {
    assert_eq!(response.status(), StatusCode::OK, "{what}");
    let headers = response.headers().clone();
    (headers, to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
}

fn cache_key(headers: &axum::http::HeaderMap) -> String {
    let header = headers.get("X-IFC-Metadata").expect("X-IFC-Metadata").to_str().unwrap();
    let meta: Value = serde_json::from_str(header).unwrap();
    meta["cache_key"].as_str().expect("cache_key").to_string()
}

/// Every route, one fixture, each on a fresh cache so no body is a replay.
async fn route_bodies(key: &str, content: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let state = test_state(&format!("golden-parse-{key}")).await;
    let (_, parse) = ok_body(post_content(&state, "/api/v1/parse", content).await, "parse").await;
    let (_, metadata) = ok_body(post_content(&state, "/api/v1/parse/metadata", content).await, "metadata").await;

    let state = test_state(&format!("golden-parquet-{key}")).await;
    let (headers, parquet) = ok_body(post_content(&state, "/api/v1/parse/parquet", content).await, "parquet").await;
    let symbolic_uri = format!("/api/v1/parse/symbolic/{}", cache_key(&headers));
    let (_, symbolic) = ok_body(get(&state, &symbolic_uri).await, "symbolic").await;

    let state = test_state(&format!("golden-optimized-{key}")).await;
    let (headers, optimized) =
        ok_body(post_content(&state, "/api/v1/parse/parquet/optimized", content).await, "optimized").await;
    let data_model_uri = format!("/api/v1/parse/data-model/{}", cache_key(&headers));
    let (_, data_model) = ok_body(get(&state, &data_model_uri).await, "data-model").await;

    let state = test_state(&format!("golden-stream-{key}")).await;
    let (_, stream) = ok_body(post_content(&state, "/api/v1/parse/stream", content).await, "stream").await;
    let state = test_state(&format!("golden-pstream-{key}")).await;
    let (_, pstream) =
        ok_body(post_content(&state, "/api/v1/parse/parquet-stream", content).await, "parquet-stream").await;
    vec![
        ("stream", normalised_sse(&stream)),
        ("parquet-stream", normalised_sse(&pstream)),
        ("parse", normalised_json(&parse)),
        ("metadata", normalised_json(&metadata)),
        ("parquet", parquet),
        ("parquet-optimized", optimized),
        ("symbolic", normalised_json(&symbolic)),
        ("data-model", data_model),
    ]
}

#[tokio::test]
async fn route_bodies_match_their_pins() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let repin = "cargo test -p ifc-lite-server route_golden_tests";
    let mut goldens: Vec<Golden> = ROUTES
        .iter()
        .map(|route| Golden::new(&dir, &format!("route-{route}"), repin))
        .collect();
    for (key, content) in fixtures() {
        for (route, body) in route_bodies(key, &content).await {
            let i = ROUTES.iter().position(|r| *r == route).unwrap();
            goldens[i].record(key, &body);
        }
    }
    let expected: Vec<String> = FIXTURES.iter().map(|(k, _)| k.to_string()).collect();
    // Every route that moved is named, not only the first.
    let report: String = goldens.into_iter().map(|golden| golden.check(&expected)).collect();
    assert!(report.is_empty(), "{report}");
}
