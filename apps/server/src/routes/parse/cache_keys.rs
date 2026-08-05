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

/// Typed `ParseResponse` cache key for the JSON transport.
///
/// Versioned SEPARATELY from [`request_cache_key`], which is the client-facing
/// identifier and the seed for the parquet keys — bumping that would needlessly
/// invalidate every parquet entry too.
///
/// Introduced at `v2` with issue #1841: the JSON route now emits Y-up meshes
/// like every other transport, so the pre-existing (unversioned) entries hold
/// raw IFC Z-up meshes and would silently serve a ROTATED model to a client
/// that rightly expects the uniform wire frame. A new suffix retires them.
/// Bump again on any change to what `ParseResponse` means on the wire.
pub(crate) fn json_response_cache_key(cache_key: &str) -> String {
    format!("{cache_key}-json-v2")
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

    /// The JSON `ParseResponse` cache must NOT be keyed by the bare request key
    /// (issue #1841): entries written before the Y-up switch hold raw IFC Z-up
    /// meshes, and serving one to a client that expects the uniform wire frame
    /// silently renders the model rotated. The version suffix retires them, and
    /// must stay distinct from the client-facing key and the symbolic sidecar.
    #[test]
    fn json_response_cache_key_is_versioned_and_distinct() {
        let request_key = "0ab20f4e4014-default";
        let json_key = json_response_cache_key(request_key);
        assert_eq!(json_key, format!("{request_key}-json-v2"));
        assert_ne!(json_key, request_key, "must retire the unversioned entries");
        assert_ne!(json_key, symbolic_cache_key(request_key));
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

    /// Round-trips a non-empty `SymbolicData` through `cache_symbolic_data` /
    /// `load_cached_symbolic` — the pair's whole job is to persist and
    /// recover the byte-for-byte payload. Neither function was previously
    /// exercised at all (only the key-format helper was tested), so a bug
    /// that silently dropped the payload (e.g. always returning
    /// `SymbolicData::default()` on read) would not have failed any test.
    #[tokio::test]
    async fn cache_symbolic_data_round_trips_through_load_cached_symbolic() {
        let dir = std::env::temp_dir().join(format!(
            "ifc-lite-server-cache-keys-test-{}-round-trip",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = DiskCache::new(dir.to_str().unwrap()).await;

        let mut data = SymbolicData::default();
        data.circles.push(ifc_lite_processing::SymbolicCircle::full(
            42,
            "IFCANNOTATION".to_string(),
            1.5,
            2.5,
            3.0,
            0.0,
            "Annotation".to_string(),
        ));

        cache_symbolic_data(&cache, "roundtrip-key", &data).await;
        let loaded = load_cached_symbolic(&cache, "roundtrip-key").await;

        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&data).unwrap(),
            "loaded symbolic data must match what was cached"
        );
    }

    /// A cache-key with no cached entry must default to empty symbolic
    /// data rather than erroring or panicking (fetch endpoints rely on this
    /// to answer definitively instead of looping on a pending status).
    #[tokio::test]
    async fn load_cached_symbolic_defaults_to_empty_when_absent() {
        let dir = std::env::temp_dir().join(format!(
            "ifc-lite-server-cache-keys-test-{}-absent",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = DiskCache::new(dir.to_str().unwrap()).await;

        let loaded = load_cached_symbolic(&cache, "never-written").await;
        assert!(loaded.is_empty());
    }

    /// `request_cache_key` is the seed for EVERY other key (parquet, parquet
    /// metadata, JSON response, symbolic sidecar) and the identifier handed
    /// back to the client. Nothing tested it: dropping the quality segment
    /// from it left the suite green, even though that makes a
    /// `?tessellation_quality=high` request read back the entry a previous
    /// `medium` request wrote — the client silently gets a coarser mesh than
    /// it asked for, and no cache bust ever fixes it.
    #[test]
    fn request_cache_key_separates_content_filter_and_quality() {
        let data = b"ISO-10303-21;";
        let hash = DiskCache::generate_key(data);
        let default_query = ParseQuery::default();

        // The default level keeps the LEGACY (unsuffixed) shape.
        assert_eq!(
            request_cache_key(data, &default_query, TessellationQuality::default()),
            format!("{hash}-default")
        );
        // A non-default level gets its own distinct entry.
        assert_eq!(
            request_cache_key(data, &default_query, TessellationQuality::High),
            format!("{hash}-default-qhigh")
        );

        // Every (filter, quality) pair is distinct from every other — measured
        // pairwise, so this cannot pass on one discriminating case.
        let mut seen = std::collections::HashSet::new();
        for mode in [
            OpeningFilterMode::Default,
            OpeningFilterMode::IgnoreAll,
            OpeningFilterMode::IgnoreOpaque,
        ] {
            for quality in [
                TessellationQuality::Lowest,
                TessellationQuality::Low,
                TessellationQuality::Medium,
                TessellationQuality::High,
                TessellationQuality::Highest,
            ] {
                let query = ParseQuery { opening_filter: mode, tessellation_quality: None };
                let key = request_cache_key(data, &query, quality);
                assert!(key.starts_with(&hash), "the file hash must lead the key: {key}");
                assert!(
                    seen.insert(key.clone()),
                    "collision: {mode:?}/{quality:?} reuses an existing key {key}"
                );
            }
        }
        assert_eq!(seen.len(), 15);

        // Different CONTENT under identical options must never collide.
        let other = request_cache_key(b"different bytes", &default_query, TessellationQuality::default());
        assert_ne!(other, request_cache_key(data, &default_query, TessellationQuality::default()));
    }

    /// The derived keys are all distinct namespaces over the same seed, so a
    /// parquet blob can never be served where symbolic JSON or a typed
    /// `ParseResponse` is expected.
    #[test]
    fn derived_keys_never_collide_with_each_other() {
        let seed = "0ab20f4e4014-default";
        let derived = [
            seed.to_string(),
            json_response_cache_key(seed),
            symbolic_cache_key(seed),
            parquet_cache_key("0ab20f4e4014", OpeningFilterMode::Default, TessellationQuality::Medium),
            parquet_metadata_cache_key("0ab20f4e4014", OpeningFilterMode::Default, TessellationQuality::Medium),
        ];
        let unique: std::collections::HashSet<&String> = derived.iter().collect();
        assert_eq!(unique.len(), derived.len(), "derived keys collide: {derived:?}");
    }

    /// The quality suffix uses the level LABEL, so two adjacent levels can
    /// never share an entry, and the default level alone stays unsuffixed.
    #[test]
    fn quality_suffix_is_empty_only_for_the_default_level() {
        assert_eq!(quality_cache_suffix(TessellationQuality::default()), "");
        let mut suffixes = std::collections::HashSet::new();
        for quality in [
            TessellationQuality::Lowest,
            TessellationQuality::Low,
            TessellationQuality::Medium,
            TessellationQuality::High,
            TessellationQuality::Highest,
        ] {
            let suffix = quality_cache_suffix(quality);
            if quality != TessellationQuality::default() {
                assert_eq!(suffix, format!("-q{}", quality.label()));
                assert!(!suffix.is_empty(), "{quality:?} must not reuse the default entry");
            }
            assert!(suffixes.insert(suffix), "two levels share a cache suffix");
        }
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
