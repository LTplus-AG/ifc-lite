// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reading an upload: admission, the multipart body, and its decompression.
//! Split out of `mod.rs` when #7676 moved the decode off the async runtime
//! and bounded how long a client may take to send the body.

use crate::admission::AdmissionGuard;
use crate::error::ApiError;
use crate::AppState;
use axum::extract::Multipart;
use flate2::read::GzDecoder;
use ifc_lite_processing::TessellationQuality;
use std::io::{Cursor, Read};
use std::time::Duration;
use tokio::time::Instant;

/// Admit an upload and read it: the one sequence every upload route runs
/// (#7676).
///
/// Admission comes BEFORE the body is buffered: N concurrent large uploads
/// each buffering the whole file is the outage it exists to prevent. Multipart
/// rarely declares a length, so the reservation is `MAX_FILE_SIZE_MB`, and it
/// is held for the request's whole lifetime. (Shrinking it to the upload's
/// size was tried and withdrawn: measured parse peaks are 20-33x the upload,
/// far above any multiplier that would make a smaller charge safe. That half
/// of SERVER-24 is deferred to L-server.)
///
/// The guard rides the blocking decode (see [`extract_file_holding`]), so a
/// cancelled handler cannot free the slot while the inflate still runs.
pub(crate) async fn admit_upload(
    state: &AppState,
    multipart: &mut Multipart,
) -> Result<(AdmissionGuard, bytes::Bytes), ApiError> {
    let max_file_size_mb = state.config.max_file_size_mb;
    let admission = state.admission.acquire(max_file_size_mb as u64 * 1024 * 1024).await?;
    let (file, admission) = extract_file_holding(multipart, max_file_size_mb, admission).await?;
    Ok((admission, file))
}

/// [`request_cache_key`](super::cache_keys::request_cache_key) on the blocking pool, which is where every upload
/// route computes it: a SHA-256 over up to `MAX_FILE_SIZE_MB` is a second or
/// so of CPU, and on an async worker it stalls every connection multiplexed
/// there, the same defect as the upload decode (#7676, SERVER-10).
///
/// The admission guard moves INTO the task and comes back with the key, as it
/// does for the parse itself: if the handler is cancelled mid-hash, the task
/// still holds a clone of the whole upload, so it must still hold the slot.
pub(crate) async fn request_cache_key_off_runtime(
    data: &bytes::Bytes,
    query: &super::ParseQuery,
    quality: TessellationQuality,
    admission: AdmissionGuard,
) -> Result<(String, AdmissionGuard), ApiError> {
    let (data, query) = (data.clone(), query.clone());
    Ok(tokio::task::spawn_blocking(move || {
        let key = super::cache_keys::request_cache_key(&data, &query, quality);
        tracing::debug!(cache_key = %key, size = data.len(), "Upload hashed");
        (key, admission)
    })
    .await?)
}

/// Longest an upload may go without delivering a byte (#7676, SERVER-29).
const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long an upload may run before [`UPLOAD_MIN_BYTES_PER_SEC`] applies, so
/// a slow start (TLS, a congested first second) is not judged on its rate.
const UPLOAD_RATE_GRACE: Duration = Duration::from_secs(15);

/// The slowest average rate an upload may fall to once the grace has passed:
/// 64 kbit/s, below any real uplink and far above a trickle.
const UPLOAD_MIN_BYTES_PER_SEC: u64 = 8 * 1024;

/// When an upload that has delivered `received` bytes since `started` must
/// have delivered its next one: never more than [`UPLOAD_IDLE_TIMEOUT`] from
/// now, and never later than the moment its average rate would fall below
/// [`UPLOAD_MIN_BYTES_PER_SEC`] (counted from the end of the grace).
///
/// Admission is taken before the body is read, so without this a client that
/// trickles one byte a second held a parse slot and its reservation for the
/// whole 300 s request timeout, and `max_concurrent_parses` such clients
/// locked every parse route. An idle timer alone does not catch a trickle,
/// hence the rate floor; the floor alone does not catch a stall after a fast
/// start, hence the idle cap. A chunk already waiting is always taken: the
/// deadline only bounds how long the server WAITS.
fn next_byte_deadline(started: Instant, received: usize) -> Instant {
    let on_schedule = Duration::from_secs_f64(received as f64 / UPLOAD_MIN_BYTES_PER_SEC as f64);
    let rate_floor = started + UPLOAD_RATE_GRACE.max(on_schedule);
    rate_floor.min(Instant::now() + UPLOAD_IDLE_TIMEOUT)
}

/// Await the next piece of the upload, or refuse it with `408`.
async fn next_piece<T>(
    started: Instant,
    received: usize,
    piece: impl std::future::Future<Output = Result<T, axum::extract::multipart::MultipartError>>,
) -> Result<T, ApiError> {
    match tokio::time::timeout_at(next_byte_deadline(started, received), piece).await {
        Ok(piece) => Ok(piece?),
        Err(_) => {
            tracing::warn!(received, elapsed_ms = started.elapsed().as_millis() as u64, "Refusing a stalled or trickled upload");
            Err(ApiError::UploadTimeout(format!(
                "the upload stalled or fell below {} KiB/s ({received} bytes in {}s)",
                UPLOAD_MIN_BYTES_PER_SEC / 1024,
                started.elapsed().as_secs()
            )))
        }
    }
}

/// Extract file data from multipart request.
/// Automatically decompresses gzip-compressed files and unwraps `.ifcZIP`
/// containers, refusing inputs whose decompressed size would exceed
/// `max_file_size_mb`.
///
/// Reads the `file` field one chunk at a time (rather than buffering the
/// whole field via `Field::bytes()`) so an oversized upload is caught and
/// rejected — with a clean `FileTooLarge` -> 413, logged in
/// `ApiError::into_response` — as soon as the running total crosses
/// `max_file_size_mb`, instead of only after the entire body has been
/// received. This also means the raw framework body limit
/// (`DefaultBodyLimit`, set well above this ceiling in `main.rs`) is a
/// defense-in-depth backstop, not the thing actually enforcing the limit.
/// Each chunk is awaited under [`next_byte_deadline`].
///
/// The decompression runs on the blocking pool (#7676, SERVER-10): up to
/// 500 MB of inflate on an async worker stalls every connection multiplexed
/// on it, `/health` and `/ready` included.
pub(crate) async fn extract_file(
    multipart: &mut Multipart,
    max_file_size_mb: usize,
) -> Result<bytes::Bytes, ApiError> {
    Ok(extract_file_holding(multipart, max_file_size_mb, ()).await?.0)
}

/// [`extract_file`] for a caller that holds something the decode must outlive
/// (the admission guard). `held` moves INTO the blocking decode and comes back
/// with the file, the same pattern `parse_full` uses: if the handler future is
/// cancelled (the `TimeoutLayer`, a disconnect), the detached inflate keeps
/// running - and keeps `held` - until it actually exits, so a replacement is
/// never admitted on top of it (#7676).
pub(crate) async fn extract_file_holding<H: Send + 'static>(
    multipart: &mut Multipart,
    max_file_size_mb: usize,
    held: H,
) -> Result<(bytes::Bytes, H), ApiError> {
    let max_bytes = max_file_size_mb.saturating_mul(1024 * 1024);
    let started = Instant::now();

    while let Some(mut field) = next_piece(started, 0, multipart.next_field()).await? {
        let field_name = field.name().unwrap_or_default();
        tracing::debug!(field_name = %field_name, "Processing multipart field");

        if field_name == "file" {
            let mut buf = Vec::new();
            while let Some(chunk) = next_piece(started, buf.len(), field.chunk()).await? {
                if buf.len() + chunk.len() > max_bytes {
                    return Err(ApiError::FileTooLarge {
                        max_mb: max_file_size_mb,
                    });
                }
                buf.extend_from_slice(&chunk);
            }
            let bytes = bytes::Bytes::from(buf);
            tracing::debug!(size = bytes.len(), "Extracted file from multipart");
            return tokio::task::spawn_blocking(move || {
                decode_upload(bytes, max_bytes, max_file_size_mb).map(|file| (file, held))
            })
            .await?;
        }
    }

    tracing::warn!("No 'file' field found in multipart request");
    Err(ApiError::MissingFile)
}

/// Undo the upload's transport compression, if any: a `.ifcZIP` container or
/// a gzip stream, recognised by their magic bytes. Blocking; call it on the
/// blocking pool. A stream that does not decode is the client's error, `400`
/// (#7676, SERVER-35), as a corrupt zip directory already was.
fn decode_upload(bytes: bytes::Bytes, max_bytes: usize, max_file_size_mb: usize) -> Result<bytes::Bytes, ApiError> {
    let original_size = bytes.len();
    // A zip container (.ifcZIP; local-file-header magic: 50 4b 03 04).
    if bytes.starts_with(&[0x50, 0x4b, 0x03, 0x04]) {
        tracing::debug!("Detected .ifcZIP container, unwrapping...");
        return unwrap_ifczip(&bytes, max_bytes, max_file_size_mb);
    }
    // ...or gzip (magic bytes: 1f 8b).
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        // The chunked read loop already enforced max_bytes.
        return Ok(bytes);
    }

    tracing::debug!("Detected gzip compression, decompressing...");
    // Bound the decompressed stream: read at most max_bytes + 1. If the cap
    // is hit, treat as oversized rather than allocating unbounded output for
    // a small compressed input.
    let mut decoder = GzDecoder::new(bytes.as_ref()).take(max_bytes as u64 + 1);
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .map_err(|e| ApiError::BadRequest(format!("Failed to decompress gzip: {e}")))?;
    if decompressed.len() > max_bytes {
        return Err(ApiError::FileTooLarge {
            max_mb: max_file_size_mb,
        });
    }
    tracing::info!(
        original_size = original_size,
        decompressed_size = decompressed.len(),
        compression_ratio = format!("{:.1}x", original_size as f64 / decompressed.len() as f64),
        "File decompressed successfully"
    );
    Ok(bytes::Bytes::from(decompressed))
}

/// Unwrap a buildingSMART `.ifcZIP` container (issue #1494): a plain zip
/// archive wrapping a single `.ifc`/`.ifcxml` model file (optionally alongside
/// referenced resources like textures — those are ignored, not extracted).
/// Returns the model entry's bytes so the rest of the pipeline never has to
/// know zip existed. Mirrors the TypeScript `unwrapIfcZip` semantics
/// (`packages/parser/src/ifczip.ts`): rejects an archive with zero or more than
/// one candidate rather than silently guessing which model to load, and bounds
/// the decompressed size (zip-bomb guard) against the same `max_bytes` ceiling
/// the raw/gzip paths use.
/// Whether an archive entry is a macOS AppleDouble sidecar rather than content.
///
/// Compressing in macOS Finder writes `__MACOSX/._<name>` beside each entry,
/// carrying resource forks and extended attributes. It keeps the original
/// extension, so `__MACOSX/._model.ifc` counted as a second model and every
/// Mac-made archive was rejected as ambiguous (#2812, reported from
/// production).
///
/// The test is the BASENAME, not the directory. `._` is what makes a file a
/// sidecar; `__MACOSX/` is merely where macOS puts them, so matching on it is
/// redundant (every entry inside is already `._`-prefixed) and wrong for a user
/// whose archive genuinely contains a folder of that name. The basename form
/// also covers a sidecar left beside its original by a rezip that flattens the
/// directory away.
///
/// Mirrors `APPLE_DOUBLE_RE` in `packages/parser/src/ifczip.ts`. The two must
/// agree, or an archive the browser accepts is rejected by the server.
fn is_apple_double(name: &str) -> bool {
    name.rsplit('/')
        .next()
        .is_some_and(|base| base.starts_with("._"))
}

fn unwrap_ifczip(
    bytes: &[u8],
    max_bytes: usize,
    max_file_size_mb: usize,
) -> Result<bytes::Bytes, ApiError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ApiError::BadRequest(format!("Failed to read .ifcZIP archive: {e}")))?;

    // Collect the model-file entries (case-insensitive .ifc/.ifcxml, non-dir).
    // Owned names so the >1 error can list them without holding a borrow of the
    // archive across iterations.
    let mut candidates: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| ApiError::BadRequest(format!("Corrupt .ifcZIP entry: {e}")))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name();
        let lower = name.to_ascii_lowercase();
        if (lower.ends_with(".ifc") || lower.ends_with(".ifcxml")) && !is_apple_double(name) {
            candidates.push((i, name.to_string()));
        }
    }

    match candidates.len() {
        0 => {
            return Err(ApiError::BadRequest(
                "This .ifcZIP archive contains no .ifc/.ifcxml entry — nothing to parse."
                    .to_string(),
            ))
        }
        1 => {}
        n => {
            let names = candidates
                .iter()
                .map(|(_, name)| name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ApiError::BadRequest(format!(
                "This .ifcZIP archive contains {n} model files ({names}) — expected exactly one."
            )));
        }
    }

    let index = candidates[0].0;
    let mut entry = archive
        .by_index(index)
        .map_err(|e| ApiError::BadRequest(format!("Corrupt .ifcZIP entry: {e}")))?;

    // Reject up front on the uncompressed size declared in the central
    // directory (no decompression yet), then bound the actual read as a
    // belt-and-braces guard against a lying header — same shape as the gzip
    // path above.
    if entry.size() > max_bytes as u64 {
        return Err(ApiError::FileTooLarge {
            max_mb: max_file_size_mb,
        });
    }

    let mut model = Vec::new();
    entry
        .by_ref()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut model)
        .map_err(|e| ApiError::BadRequest(format!("Failed to decompress .ifcZIP entry: {e}")))?;
    if model.len() > max_bytes {
        return Err(ApiError::FileTooLarge {
            max_mb: max_file_size_mb,
        });
    }

    tracing::info!(
        entry = %candidates[0].1,
        compressed_size = bytes.len(),
        model_size = model.len(),
        "Unwrapped .ifcZIP container"
    );
    Ok(bytes::Bytes::from(model))
}

#[cfg(test)]
#[path = "extract_file_tests.rs"]
mod extract_file_tests;

#[cfg(test)]
#[path = "ifczip_tests.rs"]
mod ifczip_tests;

#[cfg(test)]
#[path = "apple_double_tests.rs"]
mod apple_double_tests;

#[cfg(test)]
#[path = "upload_7676_tests.rs"]
mod upload_7676_tests;
