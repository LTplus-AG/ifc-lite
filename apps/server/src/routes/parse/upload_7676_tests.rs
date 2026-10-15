// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reading an upload (#7676: SERVER-10, SERVER-29, SERVER-35): where its
//! decompression runs, who holds the admission slot while it does, how long a
//! client may take to send it, and what a corrupt compressed upload answers.

use crate::routes::parse::worker_thread_tests::{
    assert_off_the_worker, await_threads_that_logged, record_event_threads,
};
use super::*;
use crate::admission::{Admission, AdmissionCfg};
use axum::body::Body;
use axum::extract::FromRequest;
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use futures::StreamExt;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

const BOUNDARY: &str = "upload7676boundary";

fn preamble() -> bytes::Bytes {
    bytes::Bytes::from(format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"model.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    ))
}

fn trailer() -> bytes::Bytes {
    bytes::Bytes::from(format!("\r\n--{BOUNDARY}--\r\n"))
}

/// A multipart request whose body arrives as `stream` does, the way a socket
/// delivers it.
async fn multipart_from<S>(stream: S) -> Multipart
where
    S: futures::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send + 'static,
{
    let request = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from_stream(stream))
        .unwrap();
    Multipart::from_request(request, &()).await.unwrap()
}

async fn multipart_of(content: &[u8]) -> Multipart {
    let parts = [preamble(), bytes::Bytes::copy_from_slice(content), trailer()];
    multipart_from(futures::stream::iter(parts.map(Ok))).await
}

fn gzip(content: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(content).unwrap();
    encoder.finish().unwrap()
}

/// A one-entry `.ifcZIP`, DEFLATE-compressed like a real one.
fn ifczip(content: &[u8]) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buffer);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("model.ifc", options).unwrap();
    zip.write_all(content).unwrap();
    zip.finish().unwrap();
    buffer.into_inner()
}

/// SERVER-10 (#7676): a gzip upload inflates on the blocking pool. Up to
/// 500 MB of inflate on an async worker stalls every connection multiplexed
/// on it, `/health` and `/ready` included. The decoded size is unique to this
/// test, which is how the recorder tells its decode apart.
#[tokio::test]
async fn server_10_a_gzip_upload_inflates_off_the_async_worker() {
    record_event_threads();
    let content = vec![b'x'; 7_676_010];
    let decoded = extract_file(&mut multipart_of(&gzip(&content)).await, 64).await.unwrap();
    assert_eq!(decoded.len(), content.len());
    let threads = await_threads_that_logged("File decompressed successfully", "decompressed_size=7676010").await;
    assert_off_the_worker(&threads, "the gzip inflate");
}

/// SERVER-10 (#7676): the same for an `.ifcZIP` container.
#[tokio::test]
async fn server_10_an_ifczip_upload_inflates_off_the_async_worker() {
    record_event_threads();
    let content = vec![b'y'; 7_676_020];
    let decoded = extract_file(&mut multipart_of(&ifczip(&content)).await, 64).await.unwrap();
    assert_eq!(decoded.len(), content.len());
    let threads = await_threads_that_logged("Unwrapped .ifcZIP container", "model_size=7676020").await;
    assert_off_the_worker(&threads, "the .ifcZIP inflate");
}

/// SERVER-35 (#7676): a gzip upload whose stream does not inflate is the
/// client's error (400), not a server failure (500).
#[tokio::test]
async fn server_35_a_corrupt_gzip_upload_is_a_bad_request() {
    let mut body = gzip(&vec![b'z'; 4096]);
    // Keep the 10-byte header (and its magic); ruin the DEFLATE stream.
    let end = body.len() - 8;
    body[10..end].fill(0xff);
    let err = extract_file(&mut multipart_of(&body).await, 64).await.unwrap_err();
    assert_eq!(err.into_response().status(), StatusCode::BAD_REQUEST);
}

/// SERVER-35 (#7676): the same for an `.ifcZIP` entry, which already
/// answered 400 for a corrupt directory but 500 for a corrupt entry.
#[tokio::test]
async fn server_35_a_corrupt_ifczip_entry_is_a_bad_request() {
    let mut body = ifczip(&vec![b'z'; 4096]);
    // The entry's data starts after its 30-byte local header, its name, and
    // its extra field.
    let name_len = u16::from_le_bytes([body[26], body[27]]) as usize;
    let extra_len = u16::from_le_bytes([body[28], body[29]]) as usize;
    let start = 30 + name_len + extra_len;
    body[start..start + 8].fill(0xff);
    let err = extract_file(&mut multipart_of(&body).await, 64).await.unwrap_err();
    assert_eq!(err.into_response().status(), StatusCode::BAD_REQUEST);
}

/// SERVER-29 (#7676): an upload that stops sending gives up its admission
/// slot well before the 300 s request timeout. Admission is taken before the
/// body is read, so a client that stalls mid-upload held a parse slot and a
/// `MAX_FILE_SIZE_MB` reservation for the whole request timeout, and
/// `max_concurrent_parses` such clients locked every parse route.
#[tokio::test(start_paused = true)]
async fn server_29_a_stalled_upload_is_refused() {
    let stalled = futures::stream::iter([Ok(preamble()), Ok(bytes::Bytes::from_static(b"ISO-10303-21;"))])
        .chain(futures::stream::pending());
    let mut multipart = multipart_from(stalled).await;

    let started = tokio::time::Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(3600), extract_file(&mut multipart, 64)).await;
    let err = outcome
        .expect("a stalled upload was waited on for an hour")
        .unwrap_err();
    assert_eq!(err.into_response().status(), StatusCode::REQUEST_TIMEOUT);
    assert!(started.elapsed() < Duration::from_secs(60), "gave up only after {:?}", started.elapsed());
}

/// SERVER-29 (#7676): a client trickling one byte a second never stalls, so
/// an idle timer alone cannot catch it. It is refused once its average rate
/// falls below the floor.
#[tokio::test(start_paused = true)]
async fn server_29_a_trickled_upload_is_refused() {
    let trickle = async_stream::stream! {
        yield Ok::<_, std::io::Error>(preamble());
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            yield Ok(bytes::Bytes::from_static(b"x"));
        }
    };
    let mut multipart = multipart_from(trickle).await;

    let started = tokio::time::Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(3600), extract_file(&mut multipart, 64)).await;
    let err = outcome
        .expect("a 1 B/s upload was read for an hour")
        .unwrap_err();
    assert_eq!(err.into_response().status(), StatusCode::REQUEST_TIMEOUT);
    assert!(started.elapsed() < Duration::from_secs(60), "gave up only after {:?}", started.elapsed());
}

/// SERVER-29 (#7676), the other side: a slow but real upload (32 KiB/s for
/// 40 s, well under a phone's uplink) is not cut off. Kept under the
/// extractor's 2 MB default body limit, which this test does not raise.
#[tokio::test(start_paused = true)]
async fn server_29_a_slow_steady_upload_is_accepted() {
    const SECONDS: usize = 40;
    const PER_SECOND: usize = 32 * 1024;
    let steady = async_stream::stream! {
        yield Ok::<_, std::io::Error>(preamble());
        for _ in 0..SECONDS {
            tokio::time::sleep(Duration::from_secs(1)).await;
            yield Ok(bytes::Bytes::from(vec![b's'; PER_SECOND]));
        }
        yield Ok(trailer());
    };
    let mut multipart = multipart_from(steady).await;
    let file = extract_file(&mut multipart, 64).await.unwrap();
    assert_eq!(file.len(), SECONDS * PER_SECOND);
}

/// SERVER-29 (#7676), the idle cap: a client that starts fast and then goes
/// silent is refused after [`UPLOAD_IDLE_TIMEOUT`], not when its rate floor
/// finally expires. 1.5 MB in the first second puts the rate floor ~3 minutes
/// out, so only the idle cap can end this stall at ~30 s. (The stall test above
/// stalls at once, where the 15 s grace fires first and the cap is unseen.)
#[tokio::test(start_paused = true)]
async fn server_29_an_upload_that_starts_fast_then_stalls_is_refused_at_the_idle_cap() {
    let fast_then_silent = async_stream::stream! {
        yield Ok::<_, std::io::Error>(preamble());
        tokio::time::sleep(Duration::from_secs(1)).await;
        yield Ok(bytes::Bytes::from(vec![b'f'; 1_500_000]));
        futures::future::pending::<()>().await;
    };
    let mut multipart = multipart_from(fast_then_silent).await;

    let started = tokio::time::Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(3600), extract_file(&mut multipart, 64)).await;
    let err = outcome.expect("a stalled upload was waited on for an hour").unwrap_err();
    assert_eq!(err.into_response().status(), StatusCode::REQUEST_TIMEOUT);
    let waited = started.elapsed();
    assert!(
        waited >= UPLOAD_IDLE_TIMEOUT && waited < UPLOAD_IDLE_TIMEOUT + Duration::from_secs(5),
        "a stall after a fast start should be refused at the {UPLOAD_IDLE_TIMEOUT:?} idle cap, took {waited:?}"
    );
}

fn one_slot_admission() -> Arc<Admission> {
    Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 1024 * 1024 * 1024,
        queue_depth: 0,
        queue_timeout: Duration::from_millis(20),
        shed_pct: 0,
    }))
}

/// Cancel `work` (the handler future) after `after`, as a `TimeoutLayer` or a
/// disconnect does, and wait until it is really dropped.
async fn cancel_after<F: std::future::Future + Send + 'static>(work: F, after: Duration)
where
    F::Output: Send + 'static,
{
    let handle = tokio::spawn(work);
    tokio::time::sleep(after).await;
    handle.abort();
    assert!(matches!(handle.await, Err(e) if e.is_cancelled()), "the work finished before it could be cancelled");
}

/// Poll until the one slot is free again, panicking after `limit`.
async fn slot_frees_within(admission: &Arc<Admission>, limit: Duration) -> Duration {
    let started = std::time::Instant::now();
    loop {
        if admission.acquire(1).await.is_ok() {
            return started.elapsed();
        }
        assert!(started.elapsed() < limit, "the slot was never released");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// SERVER-10 / #7676 review: the admission guard rides the upload hash. The
/// hash holds a clone of the whole upload, so a
/// cancelled handler must not free the slot under it.
#[tokio::test]
async fn the_admission_slot_outlives_a_cancelled_upload_hash() {
    let admission = one_slot_admission();
    let data = bytes::Bytes::from(vec![7u8; 128 * 1024 * 1024]);
    let guard = admission.acquire(1).await.unwrap();
    cancel_after(
        async move {
            let query = crate::routes::parse::ParseQuery::default();
            request_cache_key_off_runtime(&data, &query, TessellationQuality::default(), guard).await.map(|(key, _)| key)
        },
        Duration::from_millis(5),
    )
    .await;

    assert!(
        admission.acquire(1).await.is_err(),
        "the slot was re-admitted while the cancelled request's hash was still running"
    );
    slot_frees_within(&admission, Duration::from_secs(60)).await;
}
