// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache-key builders and symbolic-data cache helpers shared by the parse endpoints.

use super::ParseQuery;
use crate::services::cache::DiskCache;
use crate::services::OpeningFilterMode;
use ifc_lite_processing::{SymbolicData, TessellationQuality};

/// Cache-key segment for a tessellation level. Empty for the default level so
/// every pre-existing cache entry (all written at implicit `medium`) stays
/// valid; non-default levels get distinct entries.
fn quality_cache_suffix(quality: TessellationQuality) -> String {
    if quality == TessellationQuality::default() {
        String::new()
    } else {
        format!("-q{}", quality.label())
    }
}

/// Request-level cache key: file hash + opening-filter suffix + quality suffix.
pub(crate) fn request_cache_key(data: &[u8], query: &ParseQuery, quality: TessellationQuality) -> String {
    format!(
        "{}-{}{}",
        DiskCache::generate_key(data),
        query.opening_filter.cache_key_suffix(),
        quality_cache_suffix(quality)
    )
}

/// Build the parquet geometry cache key for a given file hash and opening filter.
///
/// Must stay in sync with the writer in `parse_parquet` / `parse_parquet_stream`,
/// which derives the same suffix from `OpeningFilterMode::cache_key_suffix()`.
///
/// Version bumped `v2` → `v3` with issue #900 (symbolic sidecar), and `v3` → `v4`
/// with the alignment audit: the server default path switched to per-item
/// sub-meshes, streamed geometry now comes from the canonical pipeline
/// (material chain + indexed colours + aggregate void propagation), and
/// native builds compute normals — entries cached by the old pipelines
/// would serve visibly different meshes.
pub(crate) fn parquet_cache_key(
    hash: &str,
    opening_filter: OpeningFilterMode,
    quality: TessellationQuality,
) -> String {
    format!(
        "{}-{}{}-parquet-v4",
        hash,
        opening_filter.cache_key_suffix(),
        quality_cache_suffix(quality)
    )
}

/// Build the parquet metadata cache key for a given file hash and opening filter.
pub(crate) fn parquet_metadata_cache_key(
    hash: &str,
    opening_filter: OpeningFilterMode,
    quality: TessellationQuality,
) -> String {
    format!(
        "{}-{}{}-parquet-metadata-v4",
        hash,
        opening_filter.cache_key_suffix(),
        quality_cache_suffix(quality)
    )
}

/// Build the symbolic-data cache key for a given file cache key.
///
/// The 2D symbol stream (`IfcAnnotation` + `IfcGrid`) is cached separately
/// from geometry so binary-transport endpoints (Parquet, optimized Parquet,
/// cached geometry) can expose it via `GET /api/v1/parse/symbolic/{cache_key}`,
/// mirroring how the data model is cached and fetched (issue #900). `cache_key`
/// is the full `{hash}-{opening_filter}` key, matching the value embedded in
/// each response's metadata header.
pub(crate) fn symbolic_cache_key(cache_key: &str) -> String {
    format!("{}-symbolic-v1", cache_key)
}

/// Serialize symbolic data and write it to the cache under `{cache_key}-symbolic-v1`.
///
/// Always stores the JSON (even when empty) so the fetch endpoint can return a
/// definitive `200` with empty arrays rather than looping on `202`.
pub(crate) async fn cache_symbolic_data(cache: &DiskCache, cache_key: &str, symbolic: &SymbolicData) {
    match serde_json::to_vec(symbolic) {
        Ok(bytes) => {
            let key = symbolic_cache_key(cache_key);
            if let Err(e) = cache.set_bytes(&key, &bytes).await {
                tracing::error!(error = %e, cache_key = %cache_key, "Failed to cache symbolic data");
            } else {
                tracing::debug!(cache_key = %key, size = bytes.len(), "Symbolic data cached");
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to serialize symbolic data for caching");
        }
    }
}

/// Load cached symbolic data for `cache_key`, defaulting to empty when the
/// entry is absent or unreadable.
pub(crate) async fn load_cached_symbolic(cache: &DiskCache, cache_key: &str) -> SymbolicData {
    let key = symbolic_cache_key(cache_key);
    match cache.get_bytes(&key).await {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::error!(error = %e, cache_key = %cache_key, "Failed to parse cached symbolic data");
            SymbolicData::default()
        }),
        Ok(None) => SymbolicData::default(),
        Err(e) => {
            tracing::error!(error = %e, cache_key = %cache_key, "Failed to read cached symbolic data");
            SymbolicData::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::streaming::detect_schema_version;

    /// Regression test for #587: the reader (`check_cache`) used to look up
    /// `{hash}-parquet-v4`, while the writer (`parse_parquet`) stored
    /// `{hash}-{opening_filter}-parquet-v4`, so the check always returned 404.
    /// The shared helper must produce the same key the writer stores under.
    #[test]
    fn parquet_cache_key_matches_writer_format() {
        let hash = "0ab20f4e4014";

        // The writer composes `cache_key = format!("{hash}-{suffix}")` and then
        // `format!("{cache_key}-parquet-v4")`. The helper must produce the same string.
        for mode in [
            OpeningFilterMode::Default,
            OpeningFilterMode::IgnoreAll,
            OpeningFilterMode::IgnoreOpaque,
        ] {
            for quality in [
                TessellationQuality::Medium,
                TessellationQuality::Low,
                TessellationQuality::Highest,
            ] {
                let writer_cache_key = format!(
                    "{}-{}{}",
                    hash,
                    mode.cache_key_suffix(),
                    quality_cache_suffix(quality)
                );
                let writer_parquet_key = format!("{}-parquet-v4", writer_cache_key);
                let writer_metadata_key = format!("{}-parquet-metadata-v4", writer_cache_key);

                assert_eq!(parquet_cache_key(hash, mode, quality), writer_parquet_key);
                assert_eq!(
                    parquet_metadata_cache_key(hash, mode, quality),
                    writer_metadata_key
                );
            }
        }
    }

    /// The default (medium) level maps to the LEGACY key shape — pre-existing
    /// cache entries written before the quality knob stay valid.
    #[test]
    fn parquet_cache_key_default_filter_uses_default_suffix() {
        let key = parquet_cache_key("abc", OpeningFilterMode::Default, TessellationQuality::Medium);
        assert_eq!(key, "abc-default-parquet-v4");
        let key = parquet_cache_key("abc", OpeningFilterMode::Default, TessellationQuality::High);
        assert_eq!(key, "abc-default-qhigh-parquet-v4");
    }

    /// The symbolic cache key (issue #900) is derived from the full
    /// `{hash}-{opening_filter}` cache key the writers store under, and the
    /// `get_symbolic` reader composes the same string from the path param.
    #[test]
    fn symbolic_cache_key_matches_writer_format() {
        let hash = "0ab20f4e4014";
        for mode in [
            OpeningFilterMode::Default,
            OpeningFilterMode::IgnoreAll,
            OpeningFilterMode::IgnoreOpaque,
        ] {
            let writer_cache_key = format!("{}-{}", hash, mode.cache_key_suffix());
            assert_eq!(
                symbolic_cache_key(&writer_cache_key),
                format!("{}-symbolic-v1", writer_cache_key)
            );
        }
    }

    #[test]
    fn symbolic_cache_key_default_filter() {
        let key = symbolic_cache_key("abc-default");
        assert_eq!(key, "abc-default-symbolic-v1");
    }

    #[test]
    fn schema_detection_uses_file_schema_declaration_only() {
        let content = b"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCDOCUMENTINFORMATION('IFC4X3',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);
ENDSEC;";

        assert_eq!(detect_schema_version(content), "IFC2X3");
    }
}
