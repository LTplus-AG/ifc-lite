// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parse endpoints for IFC file processing.

mod cache_keys;
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
use std::io::Read;

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
