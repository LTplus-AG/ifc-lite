// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Route-level tests for `?data_model_entities=rooted` (issue #6034): the
//! parse routes write the rooted-only data model under its own key, the fetch
//! route serves it only to a client that asks for it, and a warm cache of
//! either variant never answers for the other.

use super::cache_keys::{data_model_cache_key, parquet_optimized_cache_key, request_cache_key};
use super::ParseQuery;
use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::services::DataModelEntities;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use ifc_lite_processing::TessellationQuality;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use std::sync::Arc;
use tower::ServiceExt;

const BOUNDARY: &str = "ifclite-6034-boundary";
const ROOTED: &str = "data_model_entities=rooted";
const SENTINEL_BODY: &[u8] = b"SENTINEL-6034-BODY-NOT-PARQUET";

/// Objects plus plumbing: a wall with a property value, a material layer set,
/// and geometry points nothing in the data model points at.
fn fixture(tag: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-6034 {tag}'),'2;1');
FILE_NAME('rooted.ifc','2026-09-27T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#10=IFCBUILDINGSTOREY('Stor00000000000000001',$,'L1',$,$,$,$,$,.ELEMENT.,0.);
#11=IFCRELAGGREGATES('Agg0000000000000000001',$,$,$,#1,(#10));
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000001',$,$,$,(#28),#10);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F90'),$);
#21=IFCPROPERTYSET('Pset000000000000000001',$,'Pset_WallCommon',$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('Def0000000000000000001',$,$,$,(#28),#21);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#30=IFCMATERIAL('Concrete',$,'Mineral');
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,$,$);
#34=IFCMATERIALLAYERSET((#32),'WallSet',$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
#80=IFCCARTESIANPOINT((0.,0.,0.));
#81=IFCCARTESIANPOINT((1.,0.,0.));
#82=IFCPOLYLOOP((#80,#81));
ENDSEC;
END-ISO-10303-21;
"#
    )
}

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-6034-{}-{}",
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
        data_model_in_flight: Arc::new(crate::in_flight::InFlightKeys::default()),
    }
}

/// POST `content` as a multipart upload; `(status, X-IFC-Metadata, body)`.
async fn post(state: &AppState, uri: &str, content: &[u8]) -> (StatusCode, String, Vec<u8>) {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let metadata = response
        .headers()
        .get("X-IFC-Metadata")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, metadata, body.to_vec())
}

async fn get(state: &AppState, uri: &str) -> (StatusCode, Vec<u8>) {
    let request = Request::builder().method("GET").uri(uri).body(Body::empty()).unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, body.to_vec())
}

fn key_for(content: &[u8]) -> String {
    request_cache_key(content, &ParseQuery::default(), TessellationQuality::default())
}

/// `(entity ids of the entities section, every byte after that section)`.
fn split_entities(payload: &[u8]) -> (Vec<u32>, Vec<u8>) {
    let len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
    let section = bytes::Bytes::copy_from_slice(&payload[4..4 + len]);
    let reader = ParquetRecordBatchReaderBuilder::try_new(section).unwrap().build().unwrap();
    let mut ids = Vec::new();
    for batch in reader {
        let batch = batch.unwrap();
        let col = batch
            .column_by_name("entity_id")
            .unwrap()
            .as_any()
            .downcast_ref::<arrow::array::UInt32Array>()
            .unwrap()
            .clone();
        ids.extend(col.values().iter().copied());
    }
    (ids, payload[4 + len..].to_vec())
}

/// The headline: a rooted optimized parse writes ONLY the rooted entry, the
/// fetch route serves it only to a client that asks for it, and the payload
/// differs from the default one in the entities section alone. The geometry
/// response is the same bytes either way.
#[tokio::test]
async fn issue_6034_optimized_rooted_parse_writes_and_serves_only_the_rooted_entry() {
    let state = test_state("optimized").await;
    let content = fixture("optimized");
    let content = content.as_bytes();
    let key = key_for(content);

    let (status, rooted_meta, rooted_body) =
        post(&state, &format!("/api/v1/parse/parquet/optimized?{ROOTED}"), content).await;
    assert_eq!(status, StatusCode::OK);
    let rooted_key = data_model_cache_key(&key, DataModelEntities::Rooted);
    let all_key = data_model_cache_key(&key, DataModelEntities::All);
    let stored = state.cache.get_bytes(&rooted_key).await.unwrap().expect("rooted entry written");
    assert!(
        state.cache.get_bytes(&all_key).await.unwrap().is_none(),
        "a rooted request must not write the full entry"
    );

    let (status, served) =
        get(&state, &format!("/api/v1/parse/data-model/{key}?{ROOTED}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(served, stored);
    let (status, _) = get(&state, &format!("/api/v1/parse/data-model/{key}")).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the full table was never written; the rooted one must not answer for it"
    );

    // The default request finds the geometry warm but no full data model, so
    // it re-parses and writes one.
    let (status, all_meta, all_body) =
        post(&state, "/api/v1/parse/parquet/optimized", content).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all_body, rooted_body, "the variant must not touch the geometry payload");
    // Timings differ run to run; the data-model stats must not: they describe
    // the model, so the metadata entry both variants share holds one value.
    let stats = |m: &str| serde_json::from_str::<serde_json::Value>(m).unwrap()["data_model_stats"].clone();
    assert_eq!(stats(&all_meta), stats(&rooted_meta));
    assert!(stats(&rooted_meta)["entity_count"].as_u64().unwrap() > 0);
    let (status, full) = get(&state, &format!("/api/v1/parse/data-model/{key}")).await;
    assert_eq!(status, StatusCode::OK);

    let (rooted_ids, rooted_rest) = split_entities(&served);
    let (full_ids, full_rest) = split_entities(&full);
    assert_eq!(rooted_rest, full_rest, "every table after entities must be byte-identical");
    // Dropped: the property value and the geometry plumbing. Kept: the
    // objects, and the material + layer set the materials table names.
    for id in [1, 10, 11, 12, 21, 22, 28, 30, 34, 35] {
        assert!(rooted_ids.contains(&id), "#{id} missing from {rooted_ids:?}");
    }
    for id in [20, 32, 80, 81, 82] {
        assert!(full_ids.contains(&id), "#{id} missing from the full table");
        assert!(!rooted_ids.contains(&id), "#{id} must be dropped: {rooted_ids:?}");
    }
    assert!(rooted_ids.windows(2).all(|w| full_ids.iter().position(|&i| i == w[0]) < full_ids.iter().position(|&i| i == w[1])),
        "kept rows stay in file order");
}

/// A warm DEFAULT cache must not answer a rooted request: the body replay
/// would leave the client polling a rooted key nobody writes. Once the
/// rooted entry exists, the rooted request replays like any other.
#[tokio::test]
async fn issue_6034_a_default_warm_cache_re_parses_for_a_rooted_request() {
    let state = test_state("warm-default").await;
    let content = fixture("warm-default");
    let content = content.as_bytes();
    let key = key_for(content);
    let body_key = parquet_optimized_cache_key(&key);

    let (status, _, _) = post(&state, "/api/v1/parse/parquet/optimized", content).await;
    assert_eq!(status, StatusCode::OK);
    state.cache.set_bytes(&body_key, SENTINEL_BODY).await.unwrap();

    let uri = format!("/api/v1/parse/parquet/optimized?{ROOTED}");
    let (status, _, body) = post(&state, &uri, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(body, SENTINEL_BODY, "no rooted data model behind the body: must re-parse");
    assert!(state
        .cache
        .get_bytes(&data_model_cache_key(&key, DataModelEntities::Rooted))
        .await
        .unwrap()
        .is_some());

    state.cache.set_bytes(&body_key, SENTINEL_BODY).await.unwrap();
    let (status, _, body) = post(&state, &uri, content).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, SENTINEL_BODY, "with the rooted entry present, the request replays");
}

/// The flat route honours the parameter too, and `/cache/check` asks about the
/// variant the client will fetch: a hit there makes the client skip the
/// upload, so it must not report one for a data model that was never written.
#[tokio::test]
async fn issue_6034_flat_route_and_cache_check_follow_the_variant() {
    let state = test_state("flat").await;
    let content = fixture("flat");
    let content = content.as_bytes();
    let key = key_for(content);
    let hash = key.strip_suffix("-default").expect("default request key");

    let (status, _, _) = post(&state, "/api/v1/parse/parquet", content).await;
    assert_eq!(status, StatusCode::OK);
    // The flat route writes its geometry in the background; wait for it.
    let mut hit = StatusCode::NOT_FOUND;
    for _ in 0..100 {
        hit = get(&state, &format!("/api/v1/cache/check/{hash}")).await.0;
        if hit == StatusCode::OK {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(hit, StatusCode::OK);
    assert_eq!(
        get(&state, &format!("/api/v1/cache/check/{hash}?{ROOTED}")).await.0,
        StatusCode::NOT_FOUND,
        "only the full data model exists; a rooted client must upload"
    );

    let (status, _, _) = post(&state, &format!("/api/v1/parse/parquet?{ROOTED}"), content).await;
    assert_eq!(status, StatusCode::OK);
    let (status, rooted) = get(&state, &format!("/api/v1/parse/data-model/{key}?{ROOTED}")).await;
    assert_eq!(status, StatusCode::OK);
    let (_, full) = get(&state, &format!("/api/v1/parse/data-model/{key}")).await;
    assert!(split_entities(&rooted).0.len() < split_entities(&full).0.len());
    assert_eq!(
        get(&state, &format!("/api/v1/cache/check/{hash}?{ROOTED}")).await.0,
        StatusCode::OK
    );
}

/// In-flight markers name the data-model ENTRY: a running fill of the full
/// table answers 202 to a poll for it, and 404 to a poll for the rooted
/// table, which that fill will never write.
#[tokio::test]
async fn issue_6034_in_flight_is_per_variant() {
    let state = test_state("in-flight").await;
    let key = "somehash-default";
    let guard = state
        .data_model_in_flight
        .begin(data_model_cache_key(key, DataModelEntities::All));
    assert_eq!(get(&state, &format!("/api/v1/parse/data-model/{key}")).await.0, StatusCode::ACCEPTED);
    assert_eq!(
        get(&state, &format!("/api/v1/parse/data-model/{key}?{ROOTED}")).await.0,
        StatusCode::NOT_FOUND
    );
    drop(guard);
    assert_eq!(
        get(&state, &format!("/api/v1/parse/data-model/{key}?data_model_entities=bogus")).await.0,
        StatusCode::BAD_REQUEST,
        "an unknown variant is refused, not silently read as the default"
    );
}

/// The streaming route's background fill writes the variant the request
/// named, and marks THAT entry in flight.
#[tokio::test]
async fn issue_6034_stream_route_fills_the_rooted_entry() {
    let state = test_state("stream").await;
    let content = fixture("stream");
    let content = content.as_bytes();
    let key = key_for(content);

    let (status, _, _) = post(&state, &format!("/api/v1/parse/parquet-stream?{ROOTED}"), content).await;
    assert_eq!(status, StatusCode::OK);
    let uri = format!("/api/v1/parse/data-model/{key}?{ROOTED}");
    let mut status = StatusCode::ACCEPTED;
    for _ in 0..250 {
        status = get(&state, &uri).await.0;
        if status != StatusCode::ACCEPTED {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(status, StatusCode::OK);
    assert!(state
        .cache
        .get_bytes(&data_model_cache_key(&key, DataModelEntities::All))
        .await
        .unwrap()
        .is_none());
}
