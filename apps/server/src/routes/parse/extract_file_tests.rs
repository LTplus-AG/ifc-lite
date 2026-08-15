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

/// The size guard is `>`, not `>=`: a file of EXACTLY `max_file_size_mb` must
/// be accepted. The pre-existing tests sat 512 KB under a 1 MB ceiling and
/// 512 KB over it, so tightening the comparison to `>=` — which rejects every
/// upload landing exactly on the advertised limit with a `413` naming that very
/// limit — left the whole suite green.
#[tokio::test]
async fn a_file_of_exactly_the_ceiling_is_accepted() {
    const MAX_MB: usize = 1;
    let exactly = vec![0u8; MAX_MB * 1024 * 1024];
    let mut multipart = multipart_of(&exactly).await;
    let bytes = extract_file(&mut multipart, MAX_MB)
        .await
        .expect("a file of exactly max_file_size_mb must be accepted");
    assert_eq!(bytes.len(), exactly.len());

    // ...and one byte over is rejected. Both sides of the boundary.
    let one_over = vec![0u8; MAX_MB * 1024 * 1024 + 1];
    let mut multipart = multipart_of(&one_over).await;
    let err = extract_file(&mut multipart, MAX_MB).await.unwrap_err();
    assert!(matches!(err, ApiError::FileTooLarge { max_mb: MAX_MB }));
}

/// A `max_file_size_mb` of 0 admits nothing but an empty body — the degenerate
/// configuration must not wrap around into "unlimited".
///
/// Pins BOTH sides of the boundary. Previously only the one-byte rejection
/// was asserted, so a mutant that rejected every upload unconditionally
/// (including a genuinely empty one, which a `max_bytes == 0` ceiling must
/// still admit) survived: it still rejected the one byte this test sent.
/// The empty-body admission below is what catches that mutant.
#[tokio::test]
async fn a_zero_ceiling_rejects_any_payload() {
    let mut multipart = multipart_of(b"").await;
    let bytes = extract_file(&mut multipart, 0)
        .await
        .expect("an empty body must be admitted even under a zero ceiling");
    assert!(bytes.is_empty());

    let mut multipart = multipart_of(b"x").await;
    let err = extract_file(&mut multipart, 0).await.unwrap_err();
    assert!(matches!(err, ApiError::FileTooLarge { max_mb: 0 }));
}

/// Build a gzip stream whose DECOMPRESSED size is `len` but whose compressed
/// form is tiny — the classic decompression bomb.
fn gzip_bomb(len: usize) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(&vec![b'A'; len]).unwrap();
    encoder.finish().unwrap()
}

/// The gzip path must bound the DECOMPRESSED size, not just the uploaded
/// bytes. Disabling that check survived the suite: a ~2 KB upload expanding to
/// hundreds of megabytes would be buffered in full, which is exactly the
/// single-request OOM the admission byte budget exists to prevent — and the
/// budget reserves against the COMPRESSED size, so it cannot catch this.
#[tokio::test]
async fn a_gzip_bomb_is_rejected_on_its_decompressed_size() {
    const MAX_MB: usize = 1;
    let bomb = gzip_bomb(4 * 1024 * 1024); // 4 MB out of a 1 MB ceiling
    assert!(
        bomb.len() < MAX_MB * 1024 * 1024,
        "the compressed payload must itself be within the ceiling ({} bytes), \
         otherwise the raw read guard would catch it and this proves nothing",
        bomb.len()
    );
    assert_eq!(&bomb[..2], &[0x1f, 0x8b], "gzip magic, so the gzip branch runs");

    let mut multipart = multipart_of(&bomb).await;
    let err = extract_file(&mut multipart, MAX_MB).await.unwrap_err();
    assert!(
        matches!(err, ApiError::FileTooLarge { max_mb: MAX_MB }),
        "expected FileTooLarge on the decompressed size, got {err:?}"
    );
}

/// The other direction: a gzip payload that decompresses to within the ceiling
/// is accepted and yields the ORIGINAL bytes, so the bomb guard above is not
/// simply rejecting everything gzipped.
#[tokio::test]
async fn a_gzip_payload_within_the_ceiling_round_trips() {
    const MAX_MB: usize = 1;
    let plain = vec![b'A'; 256 * 1024];
    let mut multipart = multipart_of(&gzip_bomb(plain.len())).await;
    let bytes = extract_file(&mut multipart, MAX_MB)
        .await
        .expect("a small gzip payload must decompress and be accepted");
    assert_eq!(bytes.len(), plain.len());
    assert_eq!(bytes.as_ref(), plain.as_slice());
}

/// A multipart body with no `file` field is a `MissingFile` (400), not a
/// silently-empty parse.
#[tokio::test]
async fn a_body_without_a_file_field_is_missing_file() {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"notfile\"\r\n\r\nx\r\n--{BOUNDARY}--\r\n")
            .as_bytes(),
    );
    let request = Request::builder()
        .method("POST")
        .uri("/")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(body))
        .unwrap();
    let mut multipart = Multipart::from_request(request, &()).await.unwrap();
    let err = extract_file(&mut multipart, 1).await.unwrap_err();
    assert!(matches!(err, ApiError::MissingFile), "got {err:?}");
}
