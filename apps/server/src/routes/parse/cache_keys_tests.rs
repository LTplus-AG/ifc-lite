// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache-key derivation tests for `cache_keys.rs`.
//!
//! Split out of that module's inline `mod tests` to keep it under the
//! 400-line ratchet (`rust/processing/tests/module_size_ratchet.rs`), the same
//! way `cache_keys_symbolic_tests.rs` already was.

use super::cache_keys::*;
use super::ParseQuery;
use crate::services::cache::DiskCache;
use crate::services::streaming::detect_schema_version;
use crate::services::{OpeningFilterMode, ParquetLayout};
use ifc_lite_processing::{SymbolicData, TessellationQuality};

/// Regression test for #587: the reader (`check_cache`) used to look up
/// `{hash}-parquet-{version}`, while the writer (`parse_parquet`) stored
/// `{hash}-{opening_filter}-parquet-{version}`, so the check always returned 404.
/// The shared helper must produce the same key the writer stores under.
#[test]
fn parquet_cache_key_matches_writer_format() {
    let hash = "0ab20f4e4014";

    // The writer composes `cache_key = format!("{hash}-{suffix}")` and then
    // appends the layout suffix. The helper must produce the same string.
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
            let writer_parquet_key = format!("{}-parquet-v5", writer_cache_key);
            let writer_metadata_key = format!("{}-parquet-metadata-v4", writer_cache_key);

            assert_eq!(
                parquet_cache_key(hash, mode, quality, ParquetLayout::Flat),
                writer_parquet_key
            );
            assert_eq!(
                parquet_metadata_cache_key(hash, mode, quality),
                writer_metadata_key
            );
        }
    }
}

/// The two layouts never share a cache entry (issue #3888).
///
/// This is the whole safety story of the opt-in, so it is asserted rather than
/// argued. The shared-shape layout renders WRONG on a client that predates it
/// -- the flat wire has no version byte to fail loud on, so an old decoder
/// ignores `rot0..rot8` and stacks every occurrence of a shared shape at the
/// template's placement. A default request must therefore be unable to reach a
/// shared entry through any path: not the parse routes, not the cache check,
/// not the cached-geometry fetch. They all build their key here.
///
/// Asserted three ways because each catches a different mistake: the default
/// key must still be the PRE-#3888 string (so entries already on disk still
/// hit, and so a future edit cannot quietly move the default onto the new
/// layout), the opt-in key must differ from it, and neither may be a prefix of
/// the other (a `starts_with` lookup would otherwise cross the namespaces).
#[test]
fn the_two_layouts_never_share_a_cache_entry() {
    for mode in [
        OpeningFilterMode::Default,
        OpeningFilterMode::IgnoreAll,
        OpeningFilterMode::IgnoreOpaque,
    ] {
        for quality in [TessellationQuality::Medium, TessellationQuality::Highest] {
            let flat = parquet_cache_key("deadbeef", mode, quality, ParquetLayout::Flat);
            let shared = parquet_cache_key("deadbeef", mode, quality, ParquetLayout::SharedShapes);
            assert!(
                flat.ends_with("-parquet-v5"),
                "the default layout must keep the pre-#3888 key: {flat}"
            );
            assert!(
                shared.ends_with("-parquet-v6"),
                "the opt-in layout needs its own namespace: {shared}"
            );
            assert_ne!(flat, shared);
            assert!(
                !flat.starts_with(&shared) && !shared.starts_with(&flat),
                "neither key may be a prefix of the other: {flat} / {shared}"
            );
        }
    }
}

/// The default is `Flat`, and it is the default that carries the safety
/// property above: a client that sends no `parquet_layout` at all must get the
/// layout it already understands.
#[test]
fn the_default_parquet_layout_is_the_pre_3888_one() {
    assert_eq!(ParquetLayout::default(), ParquetLayout::Flat);
    // A request that omits the parameter entirely, which is every request from
    // every client that predates #3888.
    let query: ParseQuery = serde_json::from_str("{}").expect("empty query");
    assert_eq!(query.parquet_layout, ParquetLayout::Flat);
    let opted: ParseQuery =
        serde_json::from_str(r#"{"parquet_layout":"shared-shapes"}"#).expect("opt-in query");
    assert_eq!(opted.parquet_layout, ParquetLayout::SharedShapes);
}

/// The default (medium) level maps to the LEGACY key shape — pre-existing
/// cache entries written before the quality knob stay valid.
#[test]
fn parquet_cache_key_default_filter_uses_default_suffix() {
    let key = parquet_cache_key(
        "abc",
        OpeningFilterMode::Default,
        TessellationQuality::Medium,
        ParquetLayout::Flat,
    );
    assert_eq!(key, "abc-default-parquet-v5");
    let key = parquet_cache_key(
        "abc",
        OpeningFilterMode::Default,
        TessellationQuality::High,
        ParquetLayout::Flat,
    );
    assert_eq!(key, "abc-default-qhigh-parquet-v5");
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
            let query = ParseQuery {
                opening_filter: mode,
                tessellation_quality: None,
                parquet_layout: ParquetLayout::Flat,
            };
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

/// The data-model payload's columns changed (issue #3860), so the suffix
/// must have moved off `v5`: a warm cache would otherwise serve a blob
/// written before the `rel_id` column existed, and absence of the column
/// reads to the decoder exactly like an older server — silently correct,
/// silently wrong.
#[test]
fn data_model_cache_key_is_versioned_and_retires_the_previous_payload() {
    let request_key = "0ab20f4e4014-default";
    let key = data_model_cache_key(request_key);
    assert_eq!(key, format!("{request_key}-datamodel-v6"));
    assert_ne!(
        key,
        format!("{request_key}-datamodel-v5"),
        "the v5 entries hold a relationships table with no rel_id column"
    );
    assert_ne!(key, request_key);
    assert_ne!(key, symbolic_cache_key(request_key));
    assert_ne!(key, json_response_cache_key(request_key));
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
        data_model_cache_key(seed),
        parquet_cache_key(
            "0ab20f4e4014",
            OpeningFilterMode::Default,
            TessellationQuality::Medium,
            ParquetLayout::Flat,
        ),
        parquet_metadata_cache_key("0ab20f4e4014", OpeningFilterMode::Default, TessellationQuality::Medium),
        parquet_optimized_cache_key(seed),
        parquet_optimized_metadata_cache_key(seed),
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

/// The optimized-Parquet route got a key of its own with #3889. Its whole
/// point is that it is a DIFFERENT namespace from the flat route's: the two
/// emit different payloads, so a hit on one must never satisfy the other.
/// Deriving the optimized key from the flat one (or reusing `-parquet-v6`)
/// would put a quantized, deduplicated payload where a client expecting flat
/// meshes reads it.
#[test]
fn optimized_parquet_keys_are_a_distinct_namespace_from_the_flat_route() {
    let hash = "0ab20f4e4014";
    let seed = format!("{hash}-default");

    assert_eq!(
        parquet_optimized_cache_key(&seed),
        format!("{seed}-parquet-optimized-v1")
    );
    assert_eq!(
        parquet_optimized_metadata_cache_key(&seed),
        format!("{seed}-parquet-optimized-metadata-v1")
    );

    // Neither optimized key may equal, or be a prefix-shadow of, the flat pair.
    let flat = parquet_cache_key(
        hash,
        OpeningFilterMode::Default,
        TessellationQuality::Medium,
        ParquetLayout::Flat,
    );
    let flat_metadata =
        parquet_metadata_cache_key(hash, OpeningFilterMode::Default, TessellationQuality::Medium);
    for optimized in [
        parquet_optimized_cache_key(&seed),
        parquet_optimized_metadata_cache_key(&seed),
    ] {
        assert_ne!(optimized, flat);
        assert_ne!(optimized, flat_metadata);
        assert_ne!(optimized, symbolic_cache_key(&seed));
        assert_ne!(optimized, data_model_cache_key(&seed));
        assert_ne!(optimized, json_response_cache_key(&seed));
    }
}
