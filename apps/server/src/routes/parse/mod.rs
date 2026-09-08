// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parse endpoints for IFC file processing.

mod cache_keys;
mod cached_replay;
mod stream_event;
mod stream_progress;
mod fetch;
mod json;
mod parquet;
mod parquet_optimized;
mod parquet_stream;

pub use fetch::{check_cache, get_cached_geometry, get_data_model, get_symbolic};
pub use json::{parse_full, parse_metadata, parse_stream};
pub use parquet::parse_parquet;
pub use parquet_optimized::parse_parquet_optimized;
pub use parquet_stream::parse_parquet_stream;

use crate::error::ApiError;
use crate::services::{OpeningFilterMode, ParquetLayout};
use axum::extract::Multipart;
use flate2::read::GzDecoder;
use ifc_lite_processing::TessellationQuality;
use std::io::{Cursor, Read};

/// Query parameters shared by all parse endpoints.
#[derive(serde::Deserialize, Default)]
pub struct ParseQuery {
    /// Opening filter mode: "default", "ignore_all", or "ignore_opaque".
    #[serde(default)]
    pub opening_filter: OpeningFilterMode,
    /// Tessellation detail level (#976): "lowest" | "low" | "medium" | "high"
    /// | "highest". Omitted = "medium" (byte-identical to the historical
    /// output — and to what the wasm path produces without
    /// `setTessellationQuality`, keeping client and server meshes in parity).
    #[serde(default)]
    pub tessellation_quality: Option<String>,
    /// Flat-Parquet mesh-table layout (#3888): "flat" (default) or
    /// "shared-shapes" — see [`ParquetLayout`] for why it is opt-in. A query
    /// parameter rather than a header because every endpoint it has to reach
    /// (both parse routes, the cache check, the cached-geometry fetch) already
    /// takes this struct, so the signal travels with the cache identity.
    #[serde(default)]
    pub parquet_layout: ParquetLayout,
    /// SHA-256 of the file the client is asking about, hex, lowercase (#3901).
    ///
    /// Read only by `POST /api/v1/parse/parquet-stream`, and only when the
    /// request carries no multipart body: see
    /// [`cached_replay::replay_by_client_hash`] for what it does and what it
    /// is not allowed to do. It lives on this struct rather than in a header
    /// so it travels with the rest of the cache identity (`opening_filter`,
    /// `tessellation_quality`, `parquet_layout`) through the one place every
    /// parse route already parses. A hash paired with the wrong layout names a
    /// different entry, and splitting one identity across two transports is how
    /// such pairings drift apart.
    #[serde(default)]
    pub sha256: Option<String>,
}

impl ParseQuery {
    /// Resolve and validate the requested tessellation level.
    fn resolved_tessellation_quality(&self) -> Result<TessellationQuality, ApiError> {
        match self.tessellation_quality.as_deref() {
            None => Ok(TessellationQuality::default()),
            Some(s) => TessellationQuality::parse_label(s).ok_or_else(|| {
                ApiError::BadRequest(format!(
                    "Unknown tessellation_quality '{s}' — expected lowest | low | medium | high | highest"
                ))
            }),
        }
    }
}

/// Extract file data from multipart request.
/// Automatically decompresses gzip-compressed files, refusing inputs whose
/// decompressed size would exceed `max_file_size_mb`.
///
/// Reads the `file` field one chunk at a time (rather than buffering the
/// whole field via `Field::bytes()`) so an oversized upload is caught and
/// rejected — with a clean `FileTooLarge` -> 413, logged in
/// `ApiError::into_response` — as soon as the running total crosses
/// `max_file_size_mb`, instead of only after the entire body has been
/// received. This also means the raw framework body limit
/// (`DefaultBodyLimit`, set well above this ceiling in `main.rs`) is a
/// defense-in-depth backstop, not the thing actually enforcing the limit.
pub(crate) async fn extract_file(
    multipart: &mut Multipart,
    max_file_size_mb: usize,
) -> Result<bytes::Bytes, ApiError> {
    let max_bytes = max_file_size_mb.saturating_mul(1024 * 1024);

    while let Some(mut field) = multipart.next_field().await? {
        let field_name = field.name().unwrap_or_default();
        tracing::debug!(field_name = %field_name, "Processing multipart field");

        if field_name == "file" {
            let mut buf = Vec::new();
            while let Some(chunk) = field.chunk().await? {
                if buf.len() + chunk.len() > max_bytes {
                    return Err(ApiError::FileTooLarge {
                        max_mb: max_file_size_mb,
                    });
                }
                buf.extend_from_slice(&chunk);
            }
            let bytes = bytes::Bytes::from(buf);
            let original_size = bytes.len();
            tracing::debug!(size = original_size, "Extracted file from multipart");

            // Check if file is gzip-compressed (magic bytes: 1f 8b)
            let is_gzipped = bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b;
            // ...or a zip container (.ifcZIP; local-file-header magic: 50 4b 03 04).
            let is_zip = bytes.len() >= 4
                && bytes[0] == 0x50
                && bytes[1] == 0x4b
                && bytes[2] == 0x03
                && bytes[3] == 0x04;

            if is_zip {
                tracing::debug!("Detected .ifcZIP container, unwrapping...");
                return unwrap_ifczip(&bytes, max_bytes, max_file_size_mb);
            }

            if is_gzipped {
                tracing::debug!("Detected gzip compression, decompressing...");
                // Bound the decompressed stream: read at most max_bytes + 1.
                // If the cap is hit, treat as oversized rather than allocating
                // unbounded output for a small compressed input.
                let mut decoder = GzDecoder::new(bytes.as_ref()).take(max_bytes as u64 + 1);
                let mut decompressed = Vec::new();
                decoder
                    .read_to_end(&mut decompressed)
                    .map_err(|e| ApiError::Internal(format!("Failed to decompress gzip: {}", e)))?;
                if decompressed.len() > max_bytes {
                    return Err(ApiError::FileTooLarge {
                        max_mb: max_file_size_mb,
                    });
                }
                tracing::info!(
                    original_size = original_size,
                    decompressed_size = decompressed.len(),
                    compression_ratio =
                        format!("{:.1}x", original_size as f64 / decompressed.len() as f64),
                    "File decompressed successfully"
                );
                return Ok(bytes::Bytes::from(decompressed));
            } else {
                // The chunked read loop above already enforces max_bytes.
                return Ok(bytes);
            }
        }
    }

    tracing::warn!("No 'file' field found in multipart request");
    Err(ApiError::MissingFile)
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
        .map_err(|e| ApiError::Internal(format!("Failed to decompress .ifcZIP entry: {e}")))?;
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
mod extract_file_tests;

#[cfg(test)]
mod ifczip_tests;

#[cfg(test)]
mod parquet_tests;

#[cfg(test)]
mod parquet_optimized_tests;

#[cfg(test)]
mod json_tests;

#[cfg(test)]
mod fetch_tests;

#[cfg(test)]
mod cache_keys_symbolic_tests;

#[cfg(test)]
mod cache_keys_tests;

#[cfg(test)]
mod cached_replay_tests;

#[cfg(test)]
mod cached_replay_batches_tests;

#[cfg(test)]
#[path = "resolved_tessellation_quality_tests.rs"]
mod resolved_tessellation_quality_tests;

#[cfg(test)]
#[path = "apple_double_tests.rs"]
mod apple_double_tests;
