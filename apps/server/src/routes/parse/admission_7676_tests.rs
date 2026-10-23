// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Upload admission (#7676: SERVER-8, and the upload hash beside SERVER-10),
//! driven through the real router.

use super::*;
use crate::admission::{Admission, AdmissionCfg};
use std::io::Write;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

async fn send(state: &AppState, method: &str, uri: &str, file: Option<&str>) -> axum::response::Response {
    let builder = Request::builder().method(method).uri(uri);
    let request = match file {
        Some(content) => {
            let (content_type, body) = multipart_body(content.as_bytes());
            builder.header(header::CONTENT_TYPE, content_type).body(Body::from(body))
        }
        None => builder.body(Body::empty()),
    }
    .unwrap();
    build_router(state.clone()).oneshot(request).await.unwrap()
}

async fn drain(response: axum::response::Response) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(10), to_bytes(response.into_body(), usize::MAX))
        .await
        .expect("body should finish")
        .unwrap()
        .to_vec()
}

/// SERVER-8 (#7676): the stream's data-model fill is part of the same
/// request, so it runs under the stream's own admission, not a second slot.
///
/// On a one-slot host (WORKER_THREADS=1) the fill waited for a slot its own
/// stream held, gave up after the queue timeout, and never wrote the data
/// model, so `GET /parse/data-model` answered the terminal 404 and properties
/// never loaded. The response is held undrained past the queue timeout to
/// make that window certain.
#[tokio::test]
async fn server_8_the_stream_fills_its_data_model_on_a_one_slot_host() {
    let mut state = test_state("7676-one-slot-data-model").await;
    state.admission = Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 0,
        queue_depth: 4,
        queue_timeout: Duration::from_millis(100),
        shed_pct: 0,
    }));
    let key = format!("{}-default", DiskCache::generate_key(JOBS_NE_MESHES_FIXTURE.as_bytes()));

    let response = send(&state, "POST", "/api/v1/parse/parquet-stream", Some(JOBS_NE_MESHES_FIXTURE)).await;
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(400)).await;
    drain(response).await;

    let uri = format!("/api/v1/parse/data-model/{key}");
    for _ in 0..400 {
        let status = send(&state, "GET", &uri, None).await.status();
        match status {
            StatusCode::OK => return,
            StatusCode::ACCEPTED | StatusCode::SERVICE_UNAVAILABLE => {
                tokio::time::sleep(Duration::from_millis(25)).await
            }
            other => panic!("the stream never wrote its data model: GET {uri} answered {other}"),
        }
    }
    panic!("the data model was still not readable after 10 s");
}

/// SERVER-10 sibling (#7676): every upload route hashes the whole upload for
/// its cache key, a second or so of SHA-256 at `MAX_FILE_SIZE_MB`. That ran
/// on the async worker too, stalling every connection multiplexed there.
#[tokio::test]
async fn server_10_the_upload_hash_runs_off_the_async_worker() {
    use crate::routes::parse::worker_thread_tests::{
        assert_off_the_worker, await_threads_that_logged, record_event_threads,
    };
    record_event_threads();
    let state = test_state("7676-hash-off-worker").await;
    // Bytes no other test hashes, so the recorder's key is this test's own.
    let content = JOBS_NE_MESHES_FIXTURE.replace("p3897.ifc", "s4-7676-hash.ifc");
    let live = stream_once(&state, &content).await;
    let key = live.iter().find(|e| e["type"] == "start").unwrap()["cache_key"].as_str().unwrap().to_string();
    let threads = await_threads_that_logged("Upload hashed", &key).await;
    assert_off_the_worker(&threads, "the upload hash");
}

/// SERVER-10 / #7676 review: the admission guard rides the blocking decode. A
/// request cancelled mid-inflate (the `TimeoutLayer`, a disconnect) used to
/// free its slot and budget at once while the detached inflate (up to
/// `MAX_FILE_SIZE_MB` of output) went on unreserved, and the next upload was
/// admitted on top of it. One slot, a gzip that inflates for a while, a cancel
/// mid-inflate: the slot stays taken until the inflate has ended.
#[tokio::test]
async fn the_admission_slot_outlives_a_cancelled_gzip_decode() {
    let mut state = test_state("7676-cancelled-decode").await;
    let admission = Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 1024 * MIB,
        queue_depth: 0,
        queue_timeout: Duration::from_millis(20),
        shed_pct: 0,
    }));
    state.admission = admission.clone();

    // 96 MiB of zeros: about 100 KB on the wire, a long inflate.
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&vec![0u8; 96 * MIB as usize]).unwrap();
    let (content_type, body) = multipart_body(&encoder.finish().unwrap());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let handler = tokio::spawn(build_router(state).oneshot(request));

    // Mid-inflate: the 96 MiB of output takes far longer than this.
    tokio::time::sleep(Duration::from_millis(15)).await;
    handler.abort();
    assert!(
        matches!(handler.await, Err(e) if e.is_cancelled()),
        "the request finished before it could be cancelled"
    );

    assert!(
        admission.acquire(1).await.is_err(),
        "the slot was re-admitted while the cancelled request's inflate was still running"
    );
    let released = std::time::Instant::now();
    while admission.acquire(1).await.is_err() {
        assert!(released.elapsed() < Duration::from_secs(60), "the slot was never released");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
