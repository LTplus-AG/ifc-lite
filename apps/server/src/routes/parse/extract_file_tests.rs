// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `extract_file`'s streaming size enforcement (issue #1842).

use super::*;
use axum::body::Body;
use axum::extract::FromRequest;
use axum::http::{header, Request};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const BOUNDARY: &str = "extractfileboundary";

/// Build an `axum::extract::Multipart` carrying a single `file` field with
/// `content`, mirroring a real POST body.
async fn multipart_of(content: &[u8]) -> Multipart {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"model.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

    let request = Request::builder()
        .method("POST")
        .uri("/")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(body))
        .unwrap();

    Multipart::from_request(request, &()).await.unwrap()
}

/// Like `multipart_of`, but delivers the body as a real multi-frame stream
/// that goes `Poll::Pending` between chunks (via `yield_now`), the way a
/// socket does. `Body::from(Vec<u8>)` hands multer a single always-ready
/// frame, so multer drains the whole field before `extract_file` ever sees
/// a chunk boundary — meaning the single-frame `multipart_of` helper can
/// never observe early rejection, only that a reject eventually happens.
/// The returned counter tracks how many `file`-payload bytes the stream
/// actually yielded, so a test can assert `extract_file` stopped pulling
/// before the whole field arrived.
async fn streaming_multipart(content_len: usize, chunk: usize) -> (Multipart, Arc<AtomicUsize>) {
    let pulled = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&pulled);
    let preamble = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"model.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    );
    let trailer = format!("\r\n--{BOUNDARY}--\r\n");

    let body_stream = async_stream::stream! {
        yield Ok::<_, std::io::Error>(bytes::Bytes::from(preamble.into_bytes()));
        let mut sent = 0;
        while sent < content_len {
            // Force the body to return Pending so multer can only pull what
            // `extract_file` demands, instead of racing ahead to EOF.
            tokio::task::yield_now().await;
            let n = chunk.min(content_len - sent);
            sent += n;
            counter.fetch_add(n, Ordering::SeqCst);
            yield Ok(bytes::Bytes::from(vec![0u8; n]));
        }
        yield Ok(bytes::Bytes::from(trailer.into_bytes()));
    };

    let request = Request::builder()
        .method("POST")
        .uri("/")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from_stream(body_stream))
        .unwrap();

    let multipart = Multipart::from_request(request, &()).await.unwrap();
    (multipart, pulled)
}

#[tokio::test]
async fn rejects_an_oversized_file_before_reading_the_whole_body() {
    // The headline property, and the one the single-frame test below
    // cannot prove: with a 1 MB ceiling and a 1.5 MB upload delivered as a
    // real Pending-between-chunks stream, `extract_file` must reject
    // *before* the whole field has been pulled off the wire.
    //
    // This is the test that actually guards the invariant. Revert the
    // chunked loop to `let bytes = field.bytes().await?;` (with the size
    // check moved after it) and the first assert still passes but this one
    // fails: `bytes()` drains the field first, so `pulled` reaches the full
    // 1.5 MB. Kept under axum's 2 MB default `DefaultBodyLimit` (the real
    // router raises it, see `main.rs`) so this exercises `extract_file`'s
    // own check, not the framework's raw body limit.
    const CHUNK: usize = 64 * 1024;
    const TOTAL: usize = 1536 * 1024;
    let (mut multipart, pulled) = streaming_multipart(TOTAL, CHUNK).await;

    let err = extract_file(&mut multipart, 1).await.unwrap_err();
    assert!(matches!(err, ApiError::FileTooLarge { max_mb: 1 }));

    let pulled = pulled.load(Ordering::SeqCst);
    assert!(
        pulled < TOTAL,
        "expected early rejection, but the whole body was pulled: {pulled} of {TOTAL} bytes"
    );
}

#[tokio::test]
async fn rejects_an_oversized_file() {
    // Smoke test over the simple single-frame body: a 1.5 MB upload against
    // a 1 MB ceiling is rejected. This proves the reject fires, but NOT
    // that it fires early — the body is one always-ready frame, so multer
    // buffers it whole regardless. Early rejection is proven by
    // `rejects_an_oversized_file_before_reading_the_whole_body` above.
    let content = vec![0u8; 1536 * 1024];
    let mut multipart = multipart_of(&content).await;

    let err = extract_file(&mut multipart, 1).await.unwrap_err();
    assert!(matches!(err, ApiError::FileTooLarge { max_mb: 1 }));
}

#[tokio::test]
async fn accepts_a_file_within_the_ceiling() {
    // Also exercises the non-gzip/non-zip branch under the new
    // chunk-by-chunk read (previously a single `Field::bytes()` call).
    let content = vec![0u8; 512 * 1024];
    let mut multipart = multipart_of(&content).await;

    let bytes = extract_file(&mut multipart, 1).await.unwrap();
    assert_eq!(bytes.len(), content.len());
}
