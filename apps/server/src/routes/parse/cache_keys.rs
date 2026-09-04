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
pub(super) fn quality_cache_suffix(quality: TessellationQuality) -> String {
    if quality == TessellationQuality::default() {
        String::new()
    } else {
        format!("-q{}", quality.label())
    }
}

/// The seed every derived key is built on: file hash + opening-filter suffix +
/// quality suffix. Endpoints that receive a bare hash (the cache-check and
/// cached-geometry routes) rebuild it from the query rather than from bytes
/// they do not have.
pub(crate) fn cache_key_from_parts(
    hash: &str,
    opening_filter: OpeningFilterMode,
    quality: TessellationQuality,
) -> String {
    format!(
        "{}-{}{}",
        hash,
        opening_filter.cache_key_suffix(),
        quality_cache_suffix(quality)
    )
}

/// Request-level cache key: file hash + opening-filter suffix + quality suffix.
pub(crate) fn request_cache_key(data: &[u8], query: &ParseQuery, quality: TessellationQuality) -> String {
    cache_key_from_parts(
        &DiskCache::generate_key(data),
        query.opening_filter,
        quality,
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

/// The flat Parquet geometry entry for a request cache key.
///
/// THE definition of that suffix. It used to be a `format!` literal repeated in
/// `parse_parquet` (twice), `parse_parquet_stream`, `try_cached_replay` and
/// here, kept equal by a comment saying they bump together -- four writers and
/// readers of one cache slot held together by prose, where a missed bump gives
/// a reader looking up a key nobody writes, or worse a writer storing under a
/// version an old reader still serves.
///
/// `v6`, not `v5`: #3888 gave the flat mesh table rotation-aware SHAPE SHARING
/// -- several rows point at one block of vertices, placed by `origin + R * p`,
/// with `rot0..rot8` added to carry the R (see `mesh_schema()` in
/// `services/parquet_schema.rs` for the layout). A v5 blob decodes cleanly
/// under a v6 decoder, which is exactly why the key has to move: the two
/// layouts are indistinguishable on the wire, so nothing else can stop a
/// pre-#3888 client being handed a v6 blob and drawing every occurrence of a
/// shared shape at the template's coordinates. `v5`, not `v4`, was #3215
/// adding the two source-id columns, where absence read exactly like success.
///
/// ONE key covers the non-streaming and the streaming route. Only the
/// non-streaming one SHARES shapes -- the streaming writer serializes one
/// batch at a time, where sharing would be batch-local -- but it emits the
/// same v6 schema with identity rotations, so either route's entry is a valid
/// v6 payload for the other to replay.
pub(crate) fn parquet_geometry_key(cache_key: &str) -> String {
    format!("{cache_key}-parquet-v6")
}

/// The flat Parquet metadata entry (the `X-IFC-Metadata` header) for a request
/// cache key. THE definition of that suffix, for the same reason as above.
///
/// NOT versioned in lockstep with [`parquet_geometry_key`]: it holds the
/// metadata header, whose shape #3888 did not touch. A hit needs both entries,
/// so a v5-era header left beside a missing v6 body simply misses and both get
/// rewritten.
pub(crate) fn parquet_metadata_key(cache_key: &str) -> String {
    format!("{cache_key}-parquet-metadata-v4")
}

/// Build the parquet geometry cache key from a file hash and opening filter,
/// for the endpoints that receive a bare hash rather than the bytes.
pub(crate) fn parquet_cache_key(
    hash: &str,
    opening_filter: OpeningFilterMode,
    quality: TessellationQuality,
) -> String {
    parquet_geometry_key(&cache_key_from_parts(hash, opening_filter, quality))
}

/// Build the parquet metadata cache key for a given file hash and opening filter.
pub(crate) fn parquet_metadata_cache_key(
    hash: &str,
    opening_filter: OpeningFilterMode,
    quality: TessellationQuality,
) -> String {
    parquet_metadata_key(&cache_key_from_parts(hash, opening_filter, quality))
}

/// Build the optimized-Parquet body cache key for a given file cache key.
///
/// `POST /api/v1/parse/parquet/optimized` was added without a key of its own,
/// so its response had nowhere to be stored and every request re-parsed the
/// file while the flat route beside it replayed from disk (issue #3889). This
/// is that key.
///
/// Deliberately a DIFFERENT namespace from `-parquet-v6`: the two routes emit
/// different payloads (quantized vertices, deduplicated shapes, byte colours),
/// so a hit on one must never satisfy the other.
///
/// `v1` is the ara3d BOS payload as it stands after #3595 (rotation-aware
/// instancing). Bump on EVERY change to the optimized payload's columns, to
/// what one of them means, OR to the geometry pipeline behind them -- this key
/// covers `process_geometry_filtered_with_quality` output just as
/// [`parquet_cache_key`] does, and that key's own `v3` -> `v4` bump was a
/// pipeline change with no column change at all. In practice: a bump of
/// `-parquet-v6` almost always needs a bump here too. Otherwise a warm cache
/// replays a pre-change blob that the decoder reads cleanly, and the change is
/// silently absent.
pub(crate) fn parquet_optimized_cache_key(cache_key: &str) -> String {
    format!("{cache_key}-parquet-optimized-v1")
}

/// Build the optimized-Parquet metadata cache key for a given file cache key.
///
/// Holds the serialized `X-IFC-Metadata` header, `optimization_stats` included,
/// so a replay carries the same stats the live parse reported. Versioned in
/// lockstep with [`parquet_optimized_cache_key`], and distinct from the flat
/// route's `-parquet-metadata-v4` for the same reason the bodies are.
pub(crate) fn parquet_optimized_metadata_cache_key(cache_key: &str) -> String {
    format!("{cache_key}-parquet-optimized-metadata-v1")
}

/// Build the data-model cache key for a given file cache key.
///
/// One definition for the writers (`parse_parquet`, `parse_parquet_stream`) and
/// the reader (`get_data_model`): three separate literals could disagree, and a
/// reader looking up a key nobody writes answers `202` forever.
///
/// The suffix bumps on EVERY change to the data-model payload's columns. `v6`
/// with issue #3860: the relationships table gained `rel_id`. Without the bump
/// a warm `CACHE_DIR` replays the pre-bump blob verbatim, the column is absent,
/// the decoder correctly omits it, and the viewer's server path is back to
/// `RelId = 0` on every exported relationship row with nothing saying so.
pub(crate) fn data_model_cache_key(cache_key: &str) -> String {
    format!("{cache_key}-datamodel-v6")
}

/// Whether a data model at the CURRENT payload version is cached for
/// `cache_key`.
///
/// Geometry and the data model are versioned separately, so a geometry entry
/// outlives a data-model bump. Every geometry short-circuit must ask this
/// before returning early: without it a deployment holding pre-bump entries
/// reports a geometry hit, the client skips the upload (or the replay path
/// skips the parse), nothing ever writes the current data-model key, and
/// `fetchDataModel` polls a key nobody writes until it times out — geometry on
/// screen with no properties and no error (issue #3869). Answering `false`
/// costs one re-parse and rewrites both entries.
///
/// A cache read error answers `false`: re-parsing is the safe direction.
pub(crate) async fn has_current_data_model(cache: &DiskCache, cache_key: &str) -> bool {
    has_entry(cache, &data_model_cache_key(cache_key)).await
}

/// Whether `key` has a readable entry.
///
/// Reads the value rather than asking `DiskCache::has`, which is an index
/// lookup only: an index row whose content is gone would answer `true` here
/// while every real reader still gets nothing, and a gate that reports present
/// for an entry nobody can read is worse than no gate.
///
/// A read error answers `false`: re-parsing is the safe direction.
async fn has_entry(cache: &DiskCache, key: &str) -> bool {
    matches!(cache.get_bytes(key).await, Ok(Some(_)))
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

/// Whether symbolic data is cached for `cache_key`.
///
/// The optimized-Parquet route's parse is what writes the symbolic sidecar, so
/// a replay that skips the parse must first check the sidecar is there. Without
/// this, a body entry that outlived its symbolic entry replays forever and
/// `GET /api/v1/parse/symbolic/{cache_key}` answers `202` to a key nobody
/// writes -- the same shape as the geometry/data-model trap in #3869.
///
/// [`load_cached_symbolic`] cannot stand in: it answers `SymbolicData::default()`
/// for an absent entry and for a model with no 2D symbols alike, so absence
/// there is indistinguishable from success.
pub(crate) async fn has_cached_symbolic(cache: &DiskCache, cache_key: &str) -> bool {
    has_entry(cache, &symbolic_cache_key(cache_key)).await
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
