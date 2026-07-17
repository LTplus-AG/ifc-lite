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
pub(crate) async fn extract_file(
    multipart: &mut Multipart,
    max_file_size_mb: usize,
) -> Result<bytes::Bytes, ApiError> {
    let max_bytes = max_file_size_mb.saturating_mul(1024 * 1024);

    while let Some(field) = multipart.next_field().await? {
        let field_name = field.name().unwrap_or_default();
        tracing::debug!(field_name = %field_name, "Processing multipart field");

        if field_name == "file" {
            let bytes = field.bytes().await?;
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
                if bytes.len() > max_bytes {
                    return Err(ApiError::FileTooLarge {
                        max_mb: max_file_size_mb,
                    });
                }
                // Already-buffered multipart Bytes: hand back the same
                // allocation instead of a full `.to_vec()` copy.
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
mod ifczip_tests {
    use super::*;
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};

    const STEP: &str = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    // Deliberately larger than the raw/gzip max the server would apply, so
    // callers can pass a real ceiling.
    const BIG: usize = 512 * 1024 * 1024;

    /// Build an in-memory zip from `(name, content)` pairs (Stored so declared
    /// uncompressed sizes are exact for the zip-bomb test).
    fn make_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, content) in entries {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(content.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn extracts_the_single_model_entry() {
        let zip = make_zip(&[("model.ifc", STEP)]);
        let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
        assert_eq!(String::from_utf8(out.to_vec()).unwrap(), STEP);
    }

    #[test]
    fn matches_ifcxml_case_insensitively_from_a_nested_path() {
        let zip = make_zip(&[("nested/dir/Model.IFCXML", "<ifcXML/>")]);
        let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
        assert_eq!(String::from_utf8(out.to_vec()).unwrap(), "<ifcXML/>");
    }

    #[test]
    fn ignores_referenced_resources_alongside_the_model() {
        let zip = make_zip(&[("model.ifc", STEP), ("resources/texture.png", "not-a-png")]);
        let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
        assert_eq!(String::from_utf8(out.to_vec()).unwrap(), STEP);
    }

    #[test]
    fn rejects_an_archive_with_no_model_entry() {
        let zip = make_zip(&[("readme.txt", "hello")]);
        let err = unwrap_ifczip(&zip, BIG, 512).unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(m) if m.contains("no .ifc/.ifcxml entry")));
    }

    #[test]
    fn rejects_an_archive_with_multiple_model_entries() {
        let zip = make_zip(&[("a.ifc", STEP), ("b.ifc", STEP)]);
        let err = unwrap_ifczip(&zip, BIG, 512).unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(m) if m.contains("expected exactly one")));
    }

    #[test]
    fn rejects_an_entry_over_the_size_ceiling() {
        // model.ifc is ~60 bytes; a 10-byte ceiling trips the zip-bomb guard
        // on the declared uncompressed size before decompressing.
        let zip = make_zip(&[("model.ifc", STEP)]);
        let err = unwrap_ifczip(&zip, 10, 1).unwrap_err();
        assert!(matches!(err, ApiError::FileTooLarge { max_mb: 1 }));
    }

    #[test]
    fn extracts_a_deflate_compressed_model_entry() {
        // Real buildingSMART .ifcZIP containers are DEFLATE-compressed, not
        // Stored. This exercises the actual `deflate` feature path so a
        // mis-wired Cargo.toml feature fails here instead of only in production
        // (UnsupportedArchive at decode time).
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("model.ifc", opts).unwrap();
            zip.write_all(STEP.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        let zip = buf.into_inner();
        let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
        assert_eq!(String::from_utf8(out.to_vec()).unwrap(), STEP);
    }
}
