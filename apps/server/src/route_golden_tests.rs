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
    // C6-0 (#7783): the data-model routes over every schema family and every
    // data kind, so a data-model refactor is judged on more than two files.
    ("AC20-FZK-Haus", Some("ara3d/AC20-FZK-Haus.ifc")), // IFC4: properties, quantities, materials, spatial
    ("BIMcollab_STR_IFC2X3", Some("various/02_BIMcollab_Example_STR_random_C_ebkp.ifc")), // IFC2X3: quantities, classifications
    ("AB22_IFC4X3", Some("AB22.ifc")),                                  // IFC4X3_RC4: alignment, 336 single values
    ("signal_IFC4X3_ADD2", Some("issues/859_linear_placement_of_signal.ifc")), // IFC4X3_ADD2: typed occurrence
    // In-tree synthetic: lowercase keywords, a repeated #id, every property,
    // quantity and material shape, a double-typed occurrence, `1.E400` values.
    ("c6-synthetic", Some("rust/export/tests/fixtures/c6_data_model_synthetic.ifc")),
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
            Some(path) if path.starts_with("rust/") => {
                let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
                Some((*key, std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}"))))
            }
            Some(path) => test_support::fixture_opt(path).map(|b| (*key, b)),
        })
        .collect()
}

/// The per-thread point-cache counters in `stats`: how often a worker found a
/// point already cached depends on how rayon split the entities, so they differ
/// by a few between runs of the same input (seen on the 458 KB IFC2X3 corpus
/// file, 4568 vs 4566 hits). Like the timings, they are not a function of the
/// model.
const SCHEDULING_COUNTERS: [&str; 2] = ["point_cache_hits", "point_cache_misses"];

/// Zero every `*_ms` number and scheduling counter, recursively: not output.
fn zero_timings(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if (key.ends_with("_ms") || SCHEDULING_COUNTERS.contains(&key.as_str())) && v.is_number() {
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

/// `parity_tests::test_state` with a hermetic config: the shipped defaults
/// with the stream batch sizes stated, never the ambient environment
/// (`INITIAL_BATCH_SIZE` / `MAX_BATCH_SIZE` set in a shell would otherwise move
/// the SSE pins, and `IFC_SERVER_API_TOKEN` would turn every route into a 401).
async fn golden_state(label: &str) -> crate::AppState {
    let mut state = test_state(label).await;
    let mut config = crate::config::Config::from_lookup(|_| None);
    config.initial_batch_size = 100;
    config.max_batch_size = 1000;
    state.config = std::sync::Arc::new(config);
    state
}

/// Every route, one fixture, each on a fresh cache so no body is a replay.
async fn route_bodies(key: &str, content: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let state = golden_state(&format!("golden-parse-{key}")).await;
    let (_, parse) = ok_body(post_content(&state, "/api/v1/parse", content).await, "parse").await;
    let (_, metadata) = ok_body(post_content(&state, "/api/v1/parse/metadata", content).await, "metadata").await;

    let state = golden_state(&format!("golden-parquet-{key}")).await;
    let (headers, parquet) = ok_body(post_content(&state, "/api/v1/parse/parquet", content).await, "parquet").await;
    let symbolic_uri = format!("/api/v1/parse/symbolic/{}", cache_key(&headers));
    let (_, symbolic) = ok_body(get(&state, &symbolic_uri).await, "symbolic").await;

    let state = golden_state(&format!("golden-optimized-{key}")).await;
    let (headers, optimized) =
        ok_body(post_content(&state, "/api/v1/parse/parquet/optimized", content).await, "optimized").await;
    let data_model_uri = format!("/api/v1/parse/data-model/{}", cache_key(&headers));
    let (_, data_model) = ok_body(get(&state, &data_model_uri).await, "data-model").await;

    let state = golden_state(&format!("golden-stream-{key}")).await;
    let (_, stream) = ok_body(post_content(&state, "/api/v1/parse/stream", content).await, "stream").await;
    let state = golden_state(&format!("golden-pstream-{key}")).await;
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
    // One test pins all eight routes, so this rewrites every route file; the
    // routes that did not move are rewritten byte-identically.
    let repin = "cargo test -p ifc-lite-server route_golden_tests  # rewrites all route-*.json; unmoved ones stay byte-identical";
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

/// The in-tree synthetic file's bytes.
fn synthetic() -> Vec<u8> {
    let abs = format!("{}/../../rust/export/tests/fixtures/c6_data_model_synthetic.ifc", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}"))
}

/// What the server's extractor does with the synthetic file today (C6-0,
/// #7783), line by line, for the C6 PRs that move it to the shared data model
/// (C6-5, C6-6). The bytes of every route over this file are pinned above;
/// these are the readable half of that pin, and where an `X` PR changes a
/// line it says why.
#[test]
fn synthetic_extraction_keeps_todays_tokens() {
    let dm = crate::services::data_model::extract_data_model(&synthetic());
    assert_eq!(dm.refused, None);
    let prop = |pset: &str, name: &str| {
        let set = dm.property_sets.iter().find(|p| p.pset_name == pset).unwrap_or_else(|| panic!("{pset}"));
        set.properties.iter().find(|p| p.property_name == name).unwrap_or_else(|| panic!("{pset}.{name}"))
    };

    // Non-finite (D13/D19/D45): `inf` text, kind `real`; the quantity stays an f64.
    assert_eq!((prop("Pset_NonFinite", "HugeReal").property_value.as_str(), prop("Pset_NonFinite", "HugeReal").property_type.as_str()), ("inf", "real"));
    assert_eq!(prop("Pset_NonFinite", "HugeNegativeLength").property_value, "-inf");
    assert_eq!(prop("Pset_NonFinite", "HugeNegativeLength").data_type.as_deref(), Some("IFCLENGTHMEASURE"));
    let huge = &dm.quantity_sets.iter().find(|q| q.qset_name == "Qto_NonFinite").unwrap().quantities[0];
    assert!(huge.quantity_value == f64::INFINITY && huge.quantity_type == "length");

    // All ten property kinds, as the server renders them (TS `parsePropertyValue` parity).
    let kinds: Vec<_> = ["Text", "Flag", "Unknown", "Thickness", "Status", "Range", "Sizes", "Curve", "Ref", "Complex"]
        .iter()
        .map(|n| prop("Pset_AllKinds", n).property_value.as_str())
        .collect();
    assert_eq!(kinds, ["Fire \u{e4} proof", "true", "", "0.2", "NEW, EXISTING", "2 [1 \u{2013} 5]", "1, 2, 3", "Table (2 rows)", "Target", "Inner1: a, Inner2: 2.5"]);
    assert_eq!(prop("Pset_AllKinds", "Unknown").property_type, "logical");
    assert!(prop("Pset_AllKinds", "Curve").data_type_mixed);
    // A repeated `#50`: the later record wins.
    assert_eq!(prop("Pset_Duplicate", "Dup").property_value, "second #50");

    // Quantities keep `Number`; the flat export drops it (C6-14).
    let qto = dm.quantity_sets.iter().find(|q| q.qset_name == "Qto_AllKinds").unwrap();
    let types: Vec<_> = qto.quantities.iter().map(|q| q.quantity_type.as_str()).collect();
    assert_eq!(types, ["length", "area", "volume", "count", "weight", "time", "number"]);

    // Relationships are edges as authored: both `IfcRelDefinesByType` rows of the
    // double-typed #310, a lowercase keyword kept verbatim, and the synthetic
    // type-set links (`rel_id 0`) in type-id order.
    let edges = |ty: &str| -> Vec<(u32, u32, u32)> {
        dm.relationships.iter().filter(|r| r.rel_type == ty).map(|r| (r.rel_id, r.relating_id, r.related_id)).collect()
    };
    assert_eq!(edges("IFCRELDEFINESBYTYPE"), [(352, 350, 310), (352, 350, 320), (353, 351, 310)]);
    assert_eq!(edges("ifcreldefinesbyproperties"), [(604, 400, 330)]);
    assert_eq!(edges("TYPEHASPROPERTYSETS"), [(0, 400, 350), (0, 420, 350), (0, 401, 351)]);

    // Materials: one row per member, every set shape.
    let kinds: Vec<_> = dm.materials.iter().map(|m| (m.element_id, m.kind.as_str(), m.layer_index)).collect();
    assert_eq!(
        kinds,
        [
            (310, "IfcMaterialLayerSet", 0),
            (310, "IfcMaterialLayerSet", 1),
            (320, "IfcMaterialProfileSet", 0),
            (330, "IfcMaterialConstituentSet", 0),
            (350, "IfcMaterialList", 0),
            (350, "IfcMaterialList", 1),
        ]
    );
    assert_eq!(dm.materials[0].thickness, Some(0.15));
    assert_eq!(dm.materials[3].fraction, Some(0.3));

    // Classifications: one row per classified element.
    let classified: Vec<_> = dm.classifications.iter().map(|c| (c.element_id, c.identification.as_deref())).collect();
    assert_eq!(classified, [(310, Some("C 2.1")), (330, Some("C 2.1"))]);
}

/// Peak resident set size of this process in KiB (`VmHWM`), or 0 off Linux.
fn peak_rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("VmHWM:")?.trim().trim_end_matches("kB").trim().parse().ok()))
        .unwrap_or(0)
}

/// Wall time and peak RSS of the server's data-model path (extract, then
/// serialise to the Parquet bundle every route sends), for the C6 PRs that
/// must be neutral within +-2% wall and not raise RSS (C6-0, #7783).
///
/// `apps/server` is a binary crate, so this is an ignored test rather than an
/// example. Run it in release, once per process (RSS is a process high-water
/// mark), three times interleaved base vs branch:
///
/// `DATA_MODEL_PROBE_FILE=<path.ifc> DATA_MODEL_PROBE_ITERS=3 cargo test --release -p ifc-lite-server data_model_probe -- --ignored --nocapture`
///
/// One JSON line: `{"file","bytes","iters","extract_ms","serialize_ms","parquet_bytes","peak_rss_kib"}`
/// with the per-iteration minimum of each phase. Without `DATA_MODEL_PROBE_FILE`
/// it reads the in-tree synthetic file.
#[test]
#[ignore = "timing probe: run explicitly, see the doc comment"]
fn data_model_probe() {
    let path = std::env::var("DATA_MODEL_PROBE_FILE").ok();
    let content = path.as_ref().map_or_else(synthetic, |p| std::fs::read(p).unwrap_or_else(|e| panic!("{p}: {e}")));
    let iters: usize = std::env::var("DATA_MODEL_PROBE_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(3).max(1);
    let (mut extract_ms, mut serialize_ms, mut parquet_bytes) = (f64::MAX, f64::MAX, 0);
    for _ in 0..iters {
        let t = std::time::Instant::now();
        let dm = crate::services::data_model::extract_data_model(&content);
        extract_ms = extract_ms.min(t.elapsed().as_secs_f64() * 1e3);
        let t = std::time::Instant::now();
        let bytes = crate::services::parquet_data_model::serialize_data_model_to_parquet(&dm).expect("serialises");
        serialize_ms = serialize_ms.min(t.elapsed().as_secs_f64() * 1e3);
        parquet_bytes = bytes.len();
    }
    println!(
        "{}",
        serde_json::json!({
            "file": path.unwrap_or_else(|| "c6_data_model_synthetic.ifc".into()),
            "bytes": content.len(), "iters": iters,
            "extract_ms": (extract_ms * 10.0).round() / 10.0,
            "serialize_ms": (serialize_ms * 10.0).round() / 10.0,
            "parquet_bytes": parquet_bytes, "peak_rss_kib": peak_rss_kib(),
        })
    );
}
