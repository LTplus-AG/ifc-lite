// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parse endpoints for IFC file processing.

mod cache_keys;
mod cached_replay;
mod fetch;
mod json;
mod parquet;
mod parquet_stream;

pub use fetch::{check_cache, get_cached_geometry, get_data_model, get_symbolic};
pub use json::{parse_full, parse_metadata, parse_stream};
pub use parquet::{parse_parquet, parse_parquet_optimized};
pub use parquet_stream::parse_parquet_stream;

use crate::error::ApiError;
use crate::services::OpeningFilterMode;
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
        if lower.ends_with(".ifc") || lower.ends_with(".ifcxml") {
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
mod resolved_tessellation_quality_tests {
    use super::*;
    use crate::error::ApiError;

    /// Omitting the query parameter must resolve to the documented default
    /// (`Medium`, byte-identical to pre-enum behavior) — not silently to some
    /// other level. Coverage gap found via mutation testing: swapping this arm
    /// to `TessellationQuality::Highest` survived the full `ifc-lite-server`
    /// suite (83/83 passed) with zero test hitting this code path.
    #[test]
    fn none_resolves_to_medium_default() {
        let query = ParseQuery {
            tessellation_quality: None,
            ..Default::default()
        };
        assert_eq!(
            query.resolved_tessellation_quality().unwrap(),
            TessellationQuality::Medium
        );
    }

    /// Every documented label round-trips through `resolved_tessellation_quality`,
    /// case-insensitively.
    #[test]
    fn every_documented_label_parses() {
        let cases = [
            ("lowest", TessellationQuality::Lowest),
            ("Low", TessellationQuality::Low),
            ("MEDIUM", TessellationQuality::Medium),
            ("high", TessellationQuality::High),
            ("Highest", TessellationQuality::Highest),
        ];
        for (label, expected) in cases {
            let query = ParseQuery {
                tessellation_quality: Some(label.to_string()),
                ..Default::default()
            };
            assert_eq!(
                query.resolved_tessellation_quality().unwrap(),
                expected,
                "label {label:?} should resolve to {expected:?}"
            );
        }
    }

    /// An unknown level must be rejected as a client error (`400 BadRequest`),
    /// not swallowed or reported as a server-side `Internal` error — the two
    /// map to different HTTP statuses and log at different severities.
    /// Coverage gap found via mutation testing: replacing `ApiError::BadRequest`
    /// with `ApiError::Internal` on this arm survived the full suite (83/83
    /// passed) — no test asserted the error path at all, let alone which variant.
    #[test]
    fn unknown_label_is_bad_request_not_internal() {
        let query = ParseQuery {
            tessellation_quality: Some("ultra".to_string()),
            ..Default::default()
        };
        let err = query.resolved_tessellation_quality().unwrap_err();
        match err {
            ApiError::BadRequest(msg) => {
                assert!(
                    msg.contains("ultra"),
                    "error message should name the rejected value, got: {msg}"
                );
            }
            other => panic!("expected ApiError::BadRequest, got {other:?}"),
        }
    }
}
