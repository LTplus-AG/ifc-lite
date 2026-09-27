// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `GET /api/v1/cache/:key` against an entry that is not a JSON
//! `ParseResponse` (issue #5128).
//!
//! Before this, `get_cached` deserialized whatever `DiskCache::get` read as
//! `ParseResponse` unconditionally, via `?`. A binary Parquet body cached
//! under its real key (`-parquet-v5`, `-parquet-v7`, `-parquet-optimized-v2`)
//! is not JSON, so `serde_json::from_slice` fails, `From<serde_json::Error>`
//! turns that into `ApiError::Internal`, and the client sees a `500` on a key
//! that genuinely exists -- the reporter's `GET /cache/{sha}-default-parquet-optimized-v1`
//! reproduction. The fix is a decode failure answers the same `404` a key
//! that was never written already does; the general fixture here (raw
//! non-JSON bytes) stands in for any of those binary entries without needing
//! a real Parquet blob.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-5128-cache-get-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    let mut config = Config::from_env();
    config.api_token = None;
    AppState {
        cache,
        config: Arc::new(config),
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

async fn get_cache(state: &AppState, key: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/cache/{key}"))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

#[tokio::test]
async fn get_cached_answers_404_for_non_json_entry() {
    let state = test_state("non-json").await;
    let key = "2222222222222222222222222222222222222222222222222222222222222222-default";
    // Since #5542 the route reads the JSON response slot for `key`, so a
    // binary Parquet key is simply absent there; seed the undecodable bytes
    // in that slot to keep the decode-failure branch itself under test.
    state
        .cache
        .set_bytes(&crate::routes::parse::cache_keys::json_response_cache_key(key), b"not json")
        .await
        .expect("seed a non-JSON entry");

    let response = get_cache(&state, key).await;
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "an entry present on disk but not a ParseResponse must 404, not 500"
    );

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!("NOT_FOUND"));
}

const BOUNDARY: &str = "ifclite-5542-cache-get-boundary";

/// A minimal but real IFC file, so the JSON parse the test drives succeeds.
const MINIMAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-5542 cache-get fixture'),'2;1');
FILE_NAME('get.ifc','2026-09-24T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// #5542: `getCached(result.cache_key)` is the client's documented call, and
/// it could never hit. `POST /api/v1/parse` returns the request `cache_key`
/// and stores its response under `json_response_cache_key(cache_key)`
/// (`{cache_key}-json-v5`); this route looked the key up unchanged, so it
/// answered 404 for every file the JSON route had cached.
///
/// Driven through both real routes rather than a seeded entry, so it pins the
/// writer and the reader to the same key: a future bump of one without the
/// other fails here.
#[tokio::test]
async fn issue_5542_get_cached_serves_the_cache_key_the_json_parse_returned() {
    let state = test_state("5542-parse-then-get").await;

    let mut multipart = Vec::new();
    multipart.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"get.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    multipart.extend_from_slice(MINIMAL_IFC.as_bytes());
    multipart.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse")
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(multipart))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let parsed: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let cache_key = parsed["cache_key"].as_str().expect("parse returns a cache_key").to_owned();
    assert_eq!(parsed["stats"]["from_cache"], false);

    // The parse route writes its cache entry in a background task, so poll
    // for it rather than racing it. Bounded: a key nobody writes stays 404.
    let mut last = StatusCode::NOT_FOUND;
    for _ in 0..200 {
        let response = get_cache(&state, &cache_key).await;
        last = response.status();
        if last == StatusCode::OK {
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let cached: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(cached["cache_key"], parsed["cache_key"]);
            assert_eq!(cached["stats"]["from_cache"], true);
            assert_eq!(cached["meshes"], parsed["meshes"], "the cached response is the parsed one");
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("GET /api/v1/cache/{cache_key} never hit (last status {last}); the parse route's entry is unreachable by the key it returned");
}

/// `POST /api/v1/parse` for `MINIMAL_IFC`, then poll `GET` until its cache
/// write lands. Returns the parsed response's `cache_key`.
async fn parse_and_wait_for_cache(state: &AppState) -> String {
    parse_and_wait_for_cache_of(state, MINIMAL_IFC).await
}

/// [`parse_and_wait_for_cache`] for chosen file bytes. A test that keys
/// anything process-global by the cache key (the decode gates below) needs
/// bytes no other test parses, or the tests running beside it share its key.
async fn parse_and_wait_for_cache_of(state: &AppState, ifc: &str) -> String {
    let mut multipart = Vec::new();
    multipart.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"get.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    multipart.extend_from_slice(ifc.as_bytes());
    multipart.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse")
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(multipart))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let parsed: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let cache_key = parsed["cache_key"].as_str().expect("parse returns a cache_key").to_owned();
    for _ in 0..200 {
        if get_cache(state, &cache_key).await.status() == StatusCode::OK {
            return cache_key;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the parse route's cache entry for {cache_key} never became readable");
}

async fn delete_cache(state: &AppState, key: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/cache/{key}"))
        .body(Body::empty())
        .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

/// #5750: `GET` and `DELETE /api/v1/cache/{key}` take one key space. The
/// `cache_key` a parse returned hits on `GET`, is accepted by `DELETE` (which
/// used to answer `400` because it wanted the bare file digest), and after
/// the `DELETE` the same `GET` misses: the two routes named the same entry.
#[tokio::test]
async fn issue_5750_get_and_delete_take_the_same_cache_key() {
    let state = test_state("5750-one-key-space").await;
    let cache_key = parse_and_wait_for_cache(&state).await;

    let deleted = delete_cache(&state, &cache_key).await;
    assert_eq!(deleted.status(), StatusCode::OK, "DELETE must accept the key GET just served");
    let body: Value =
        serde_json::from_slice(&to_bytes(deleted.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["key"], Value::from(cache_key.clone()));
    assert!(body["deleted"].as_u64().unwrap() >= 1, "nothing was removed: {body}");

    assert_eq!(
        get_cache(&state, &cache_key).await.status(),
        StatusCode::NOT_FOUND,
        "the entry GET served is the one DELETE removed"
    );
}

/// #5750: the two routes refuse the same keys, with the same body. A bare
/// digest (what `DELETE` used to take) and a storage key (what `GET` used to
/// take, before #5542) are each refused by both, so neither route can drift
/// back into a key space of its own.
#[tokio::test]
async fn issue_5750_get_and_delete_refuse_the_same_keys() {
    let state = test_state("5750-same-refusals").await;
    let digest = "0".repeat(64);
    for key in [digest.clone(), format!("{digest}-default-json-v5"), "not-a-key".to_owned()] {
        let get = get_cache(&state, &key).await;
        let delete = delete_cache(&state, &key).await;
        assert_eq!(get.status(), StatusCode::BAD_REQUEST, "GET {key}");
        assert_eq!(delete.status(), StatusCode::BAD_REQUEST, "DELETE {key}");
        let get_body = to_bytes(get.into_body(), usize::MAX).await.unwrap();
        let delete_body = to_bytes(delete.into_body(), usize::MAX).await.unwrap();
        assert_eq!(get_body, delete_body, "{key}: one resolver, one refusal");
    }
}

/// #5750: a cache `GET` decodes and re-encodes the whole stored model, so it
/// holds a parse admission slot like the parse route. With every slot taken
/// and no queue, a hit is shed with `503` + `Retry-After` instead of starting
/// another whole-model working set; a miss is answered without a slot; and
/// the same hit goes through once the slot is released.
#[tokio::test]
async fn issue_5750_cache_get_takes_a_parse_admission_slot() {
    let mut state = test_state("5750-admission").await;
    let cache_key = parse_and_wait_for_cache(&state).await;

    state.admission = Arc::new(crate::admission::Admission::new(crate::admission::AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 0,
        queue_depth: 0,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct: 85,
    }));
    let held = state.admission.acquire(0).await.expect("the only slot is free");

    let shed = get_cache(&state, &cache_key).await;
    assert_eq!(shed.status(), StatusCode::SERVICE_UNAVAILABLE, "a hit with no free slot must be shed");
    assert!(shed.headers().get(axum::http::header::RETRY_AFTER).is_some());
    let body: Value = serde_json::from_slice(&to_bytes(shed.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["code"], "OVERLOADED");

    let miss = get_cache(&state, &format!("{}-default", "0".repeat(64))).await;
    assert_eq!(miss.status(), StatusCode::NOT_FOUND, "a miss must not need a slot");

    drop(held);
    assert_eq!(get_cache(&state, &cache_key).await.status(), StatusCode::OK);
}

/// One gated decode: `entered` flips when the decode reaches the gate,
/// `open` releases it.
#[derive(Default)]
struct DecodeGate {
    state: std::sync::Mutex<(bool, bool)>, // (entered, open)
    changed: std::sync::Condvar,
}

impl DecodeGate {
    fn open(&self) {
        let mut state = self.state.lock().unwrap();
        state.1 = true;
        self.changed.notify_all();
    }
}

/// Opens and uninstalls a gate when dropped, so a failing assertion cannot
/// leave a blocking decode parked (the runtime would wait on it at shutdown
/// and the test would hang instead of failing).
struct OpenOnDrop(String, Arc<DecodeGate>);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.1.open();
        if let Ok(mut gates) = DECODE_GATES.lock() {
            gates.retain(|(key, _)| key != &self.0);
        }
    }
}

/// Gates installed by tests, keyed by the storage key whose decode they hold.
/// Keyed so that concurrently running tests never block each other's decodes.
static DECODE_GATES: std::sync::Mutex<Vec<(String, Arc<DecodeGate>)>> = std::sync::Mutex::new(Vec::new());

/// Called by `get_cached`'s blocking decode (test builds only): parks until
/// the test opens the gate installed for `response_key`, if there is one.
pub(super) fn hold_decode_if_gated(response_key: &str) {
    let gate = DECODE_GATES
        .lock()
        .unwrap()
        .iter()
        .find(|(key, _)| key == response_key)
        .map(|(_, gate)| Arc::clone(gate));
    let Some(gate) = gate else { return };
    let mut state = gate.state.lock().unwrap();
    state.0 = true;
    gate.changed.notify_all();
    while !state.1 {
        state = gate.changed.wait(state).unwrap();
    }
}

/// Review of #5791: the admission slot must travel with the blocking decode,
/// not with the handler future. A client that disconnects (or the request
/// timeout) drops the handler mid-decode; if the slot dropped with it, the
/// decode would run on unbounded while a fresh request took its slot. So:
/// hold one decode open, drop the request future that started it, and the
/// only slot must still be taken until the decode itself ends.
#[tokio::test]
async fn issue_5750_the_admission_slot_outlives_a_dropped_cache_get() {
    let mut state = test_state("5750-slot-outlives-handler").await;
    // Bytes no other test parses: the gate is keyed by the storage key, and a
    // shared fixture would let a concurrent test's decode park here and
    // report `entered` before this test's own request took its slot.
    let own_fixture = MINIMAL_IFC.replace("issue-5542 cache-get fixture", "issue-5750 slot-outlives-handler fixture");
    assert_ne!(own_fixture, MINIMAL_IFC);
    let cache_key = parse_and_wait_for_cache_of(&state, &own_fixture).await;
    state.admission = Arc::new(crate::admission::Admission::new(crate::admission::AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 0,
        queue_depth: 0,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct: 85,
    }));

    let response_key = crate::routes::parse::cache_keys::json_response_cache_key(&cache_key);
    let gate = Arc::new(DecodeGate::default());
    DECODE_GATES.lock().unwrap().push((response_key.clone(), Arc::clone(&gate)));
    let gate_guard = OpenOnDrop(response_key.clone(), Arc::clone(&gate));

    let request = {
        let state = state.clone();
        let cache_key = cache_key.clone();
        tokio::spawn(async move { get_cache(&state, &cache_key).await })
    };
    // Wait (bounded) for the decode to reach the gate, i.e. with the slot taken.
    let entered = tokio::task::spawn_blocking({
        let gate = Arc::clone(&gate);
        move || {
            let state = gate.state.lock().unwrap();
            let (state, timeout) = gate
                .changed
                .wait_timeout_while(state, std::time::Duration::from_secs(10), |s| !s.0)
                .unwrap();
            state.0 && !timeout.timed_out()
        }
    })
    .await
    .unwrap();
    assert!(entered, "the cache GET never reached its decode");

    // The client hangs up: the handler future is dropped mid-decode.
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());

    let still_held = state.admission.acquire(0).await.is_err();
    // Once the decode itself ends, the slot comes back. Opened before the
    // assertion so a failure reports rather than hangs.
    drop(gate_guard);
    assert!(still_held, "the slot was released with the dropped handler while its decode still runs");
    let mut freed = false;
    for _ in 0..200 {
        if let Ok(guard) = state.admission.acquire(0).await {
            drop(guard);
            freed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(freed, "the slot never came back after the decode finished");
}

/// Review of #5791: the miss pre-filter must not read a broken cache store as
/// "absent". With `CACHE_DIR` replaced by a plain file, every index lookup
/// fails; the GET must answer `500 CACHE_ERROR` (what reading the entry
/// answered before the pre-filter existed), never the `404` a genuine miss
/// gets. The control: the same key on a healthy, empty store is a `404`.
#[tokio::test]
async fn issue_5750_a_cache_lookup_error_is_a_500_not_a_miss() {
    let key = format!("{}-default", "3".repeat(64));

    let healthy = test_state("5750-lookup-error-control").await;
    assert_eq!(get_cache(&healthy, &key).await.status(), StatusCode::NOT_FOUND);

    let broken = test_state("5750-lookup-error").await;
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-5128-cache-get-{}-5750-lookup-error",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(&dir, b"not a cache directory").expect("inject the lookup failure");

    let response = get_cache(&broken, &key).await;
    let _ = std::fs::remove_file(&dir);
    assert_eq!(
        response.status(),
        StatusCode::INTERNAL_SERVER_ERROR,
        "a failed index lookup was reported as a cache miss"
    );
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["code"], "CACHE_ERROR");
}
