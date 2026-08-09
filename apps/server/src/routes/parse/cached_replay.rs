// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cached-replay fast path for the SSE Parquet streaming endpoint: when a
//! request's geometry + metadata are already cached, replay them as a
//! three-event stream (Start / one Batch / Complete) without re-parsing.

use super::cache_keys::load_cached_symbolic;
use super::parquet::ParquetMetadataHeader;
use super::parquet_stream::ParquetStreamEvent;
use crate::error::ApiError;
use crate::AppState;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::convert::Infallible;

/// Return the geometry slice from a cached combined-Parquet blob, framed as
/// `[geometry_len: u32-LE][geometry_data][data_model_len: u32]...`. Returns
/// `None` (rather than panicking) when the blob is too short to hold the length
/// header or declares a geometry length that runs past the buffer — the caller
/// treats that as a cache miss and re-parses.
fn cached_geometry_slice(cached: &[u8]) -> Option<&[u8]> {
    let header = cached.get(0..4)?;
    let geometry_len = u32::from_le_bytes(header.try_into().ok()?) as usize;
    let end = 4usize.checked_add(geometry_len)?;
    cached.get(4..end)
}

/// Try to serve a `parse_parquet_stream` request from the cache. Returns
/// `Ok(Some(response))` on a usable cache hit (the caller drops its admission
/// guard and returns the response as-is), `Ok(None)` on a miss or a
/// short/corrupt cached blob (the caller falls through to the live parse,
/// which overwrites the bad entry).
pub(super) async fn try_cached_replay(
    state: &AppState,
    cache_key: &str,
) -> Result<Option<axum::response::Response>, ApiError> {
    let parquet_cache_key = format!("{}-parquet-v4", cache_key);
    let metadata_cache_key = format!("{}-parquet-metadata-v4", cache_key);

    let (Some(cached_parquet), Some(cached_metadata_json)) = (
        state.cache.get_bytes(&parquet_cache_key).await?,
        state.cache.get_bytes(&metadata_cache_key).await?,
    ) else {
        return Ok(None);
    };

    tracing::info!(
        cache_key = %cache_key,
        parquet_size = cached_parquet.len(),
        "Streaming cache HIT - returning cached data as fast stream"
    );

    // Parse cached metadata
    let metadata_header: ParquetMetadataHeader = serde_json::from_slice(&cached_metadata_json)
        .map_err(|e| ApiError::Internal(format!("Failed to parse cached metadata: {}", e)))?;

    // Load the cached symbolic stream so the Complete event reaches parity
    // even on the cache fast-path (issue #900).
    let symbolic_data = load_cached_symbolic(&state.cache, cache_key).await;

    // Extract + base64-encode the geometry blob from the cached buffer.
    // The blob is framed `[geometry_len: u32-LE][geometry_data]...`. Slice
    // WITHOUT `.unwrap()` panicking on a short/corrupt cached blob, and run
    // the copy/encode off the async worker via `block_in_place` (matching
    // the live path in `parse_parquet_stream`) so a large replay doesn't
    // stall other polls. (Guarded by runtime flavor: `block_in_place` panics
    // on current_thread, which the `#[tokio::test]` harness uses.)
    let encode_geometry = || -> Option<String> {
        let geometry = cached_geometry_slice(&cached_parquet)?;
        Some(STANDARD.encode(geometry))
    };
    let base64_data = if tokio::runtime::Handle::current().runtime_flavor()
        == tokio::runtime::RuntimeFlavor::MultiThread
    {
        tokio::task::block_in_place(encode_geometry)
    } else {
        encode_geometry()
    };

    let Some(base64_data) = base64_data else {
        // Short/corrupt cached blob: don't panic, don't serve garbage.
        // Fall through to the normal parse path (treat as a cache miss);
        // the re-parse overwrites the bad cache entry.
        tracing::warn!(
            cache_key = %cache_key,
            parquet_size = cached_parquet.len(),
            "Cached parquet blob is short/corrupt; ignoring cache and re-parsing"
        );
        return Ok(None);
    };

    // Create fast stream with cached data
    let cache_key_for_stream = cache_key.to_string();
    let fast_stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>,
    > = Box::pin(futures::stream::iter(vec![
        // Start event
        Ok::<_, Infallible>(
            Event::default().data(
                serde_json::to_string(&ParquetStreamEvent::Start {
                    total_estimate: metadata_header.stats.total_meshes,
                    cache_key: cache_key_for_stream.clone(),
                })
                .unwrap(),
            ),
        ),
        // Single batch with all cached geometry
        Ok(Event::default().data(
            serde_json::to_string(&ParquetStreamEvent::Batch {
                data: base64_data,
                mesh_count: metadata_header.stats.total_meshes,
                batch_number: 1,
            })
            .unwrap(),
        )),
        // Complete event
        Ok(Event::default().data(
            serde_json::to_string(&ParquetStreamEvent::Complete {
                stats: metadata_header.stats,
                metadata: metadata_header.metadata,
                symbolic_data,
            })
            .unwrap(),
        )),
    ]));

    Ok(Some(
        Sse::new(fast_stream)
            .keep_alive(KeepAlive::default())
            .into_response(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{cached_geometry_slice, try_cached_replay};
    use crate::admission::{Admission, AdmissionCfg};
    use crate::config::Config;
    use crate::routes::parse::parquet::ParquetMetadataHeader;
    use crate::services::cache::DiskCache;
    use crate::types::{ModelMetadata, ProcessingStats};
    use crate::AppState;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::sync::Arc;

    /// Construct an `AppState` backed by a fresh temp cache directory unique to
    /// `label`, mirroring `parity_tests::test_state`.
    async fn test_state(label: &str) -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "ifc-lite-server-test-cached-replay-{}-{}",
            std::process::id(),
            label
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
        AppState {
            cache,
            config: Arc::new(Config::from_env()),
            admission: Arc::new(Admission::new(AdmissionCfg {
                max_concurrent_parses: 8,
                mem_budget_bytes: 0,
                queue_depth: 16,
                queue_timeout: std::time::Duration::from_millis(100),
                shed_pct: 85,
            })),
        }
    }

    /// A well-framed geometry blob: `[len=n][n geometry bytes][data_model_len=0]`.
    fn well_framed_blob(geometry: &[u8]) -> Vec<u8> {
        let mut blob = (geometry.len() as u32).to_le_bytes().to_vec();
        blob.extend_from_slice(geometry);
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob
    }

    fn sample_metadata_header(cache_key: &str, total_meshes: usize) -> ParquetMetadataHeader {
        ParquetMetadataHeader {
            cache_key: cache_key.to_string(),
            metadata: ModelMetadata::default(),
            stats: ProcessingStats {
                total_meshes,
                ..Default::default()
            },
            mesh_coordinate_space: None,
            site_transform: None,
            building_transform: None,
            data_model_stats: None,
        }
    }

    #[tokio::test]
    async fn miss_when_neither_key_is_cached() {
        let state = test_state("miss-neither").await;
        let result = try_cached_replay(&state, "no-such-key").await;
        assert!(matches!(result, Ok(None)), "expected a plain cache miss");
    }

    #[tokio::test]
    async fn miss_when_only_parquet_key_is_cached() {
        // Partial state: parquet present, metadata absent — must still be a miss,
        // not an attempt to serve with missing metadata.
        let state = test_state("miss-only-parquet").await;
        let cache_key = "only-parquet";
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-v4"), &well_framed_blob(&[1, 2, 3]))
            .await
            .unwrap();
        let result = try_cached_replay(&state, cache_key).await;
        assert!(matches!(result, Ok(None)), "expected a miss with only parquet cached");
    }

    #[tokio::test]
    async fn miss_when_only_metadata_key_is_cached() {
        // Partial state: metadata present, parquet absent — must still be a miss.
        let state = test_state("miss-only-metadata").await;
        let cache_key = "only-metadata";
        let metadata_bytes = serde_json::to_vec(&sample_metadata_header(cache_key, 1)).unwrap();
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-metadata-v4"), &metadata_bytes)
            .await
            .unwrap();
        let result = try_cached_replay(&state, cache_key).await;
        assert!(matches!(result, Ok(None)), "expected a miss with only metadata cached");
    }

    #[tokio::test]
    async fn corrupt_parquet_blob_falls_back_to_miss_not_error() {
        // Both keys present, but the parquet blob is too short to hold even the
        // length header: the corrupt-blob fallback must yield `Ok(None)` (a
        // miss the caller re-parses), NOT an `Err`.
        let state = test_state("corrupt-blob").await;
        let cache_key = "corrupt-blob-key";
        let metadata_bytes = serde_json::to_vec(&sample_metadata_header(cache_key, 5)).unwrap();
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-metadata-v4"), &metadata_bytes)
            .await
            .unwrap();
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-v4"), &[1, 2, 3]) // < 4 bytes
            .await
            .unwrap();

        let result = try_cached_replay(&state, cache_key).await;
        assert!(
            matches!(result, Ok(None)),
            "a corrupt cached blob must be treated as a miss, got {:?}",
            result.map(|r| r.is_some())
        );
    }

    #[tokio::test]
    async fn corrupt_metadata_json_is_an_error_not_a_miss() {
        // A cached-but-unparseable metadata entry is a DIFFERENT failure mode
        // than a corrupt parquet blob: it must surface as `Err`, not silently
        // fall through as `Ok(None)`.
        let state = test_state("corrupt-metadata").await;
        let cache_key = "corrupt-metadata-key";
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-metadata-v4"), b"not valid json")
            .await
            .unwrap();
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-v4"), &well_framed_blob(&[9, 9]))
            .await
            .unwrap();

        let result = try_cached_replay(&state, cache_key).await;
        assert!(result.is_err(), "unparseable cached metadata must be an error");
    }

    #[tokio::test]
    async fn valid_cache_hit_round_trips_the_geometry_in_the_sse_body() {
        // Control: a genuinely valid cache entry must still be served as a real
        // hit (not swallowed into the corrupt-blob miss path), and the exact
        // geometry bytes must reach the client base64-encoded in the Batch event.
        let state = test_state("valid-hit").await;
        let cache_key = "valid-hit-key";
        let geometry = [0xDE, 0xAD, 0xBE, 0xEF, 0x42];
        let metadata_bytes = serde_json::to_vec(&sample_metadata_header(cache_key, 7)).unwrap();
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-metadata-v4"), &metadata_bytes)
            .await
            .unwrap();
        state
            .cache
            .set_bytes(&format!("{cache_key}-parquet-v4"), &well_framed_blob(&geometry))
            .await
            .unwrap();

        let result = try_cached_replay(&state, cache_key).await;
        let response = match result {
            Ok(Some(response)) => response,
            other => panic!("expected a cache hit response, got {:?}", other.map(|r| r.is_some())),
        };
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();

        // Batch event carries the exact base64-encoded geometry bytes.
        let expected_data = STANDARD.encode(geometry);
        assert!(
            text.contains(&expected_data),
            "SSE body did not contain the expected batch payload: {text}"
        );
        // Start/Complete events carry the cache key and mesh count through.
        // Checked independently (not `||`) so a wrong Start.total_estimate
        // can't hide behind a correct Batch.mesh_count, or vice versa.
        assert!(text.contains(cache_key));
        assert!(
            text.contains("\"total_estimate\":7"),
            "Start event missing total_estimate:7: {text}"
        );
        assert!(
            text.contains("\"mesh_count\":7"),
            "Batch event missing mesh_count:7: {text}"
        );
    }

    #[test]
    fn decodes_a_well_framed_geometry_blob() {
        // [len=3][A B C][trailing data-model framing]
        let mut blob = 3u32.to_le_bytes().to_vec();
        blob.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
        blob.extend_from_slice(&[0, 0, 0, 0]); // data_model_len = 0
        assert_eq!(cached_geometry_slice(&blob), Some(&[0xAA, 0xBB, 0xCC][..]));
    }

    #[test]
    fn returns_none_for_a_blob_too_short_for_the_length_header() {
        // Fewer than 4 bytes: previously `cached_parquet[0..4]` panicked here.
        assert_eq!(cached_geometry_slice(&[]), None);
        assert_eq!(cached_geometry_slice(&[1, 2, 3]), None);
    }

    #[test]
    fn returns_none_when_declared_length_exceeds_the_buffer() {
        // Declares 1e9 geometry bytes but only 4 header bytes are present:
        // must not panic slicing `[4..4 + geometry_len]`.
        let blob = 1_000_000_000u32.to_le_bytes().to_vec();
        assert_eq!(cached_geometry_slice(&blob), None);
        // Off-by-a-little: length one past the available body.
        let mut blob = 3u32.to_le_bytes().to_vec();
        blob.extend_from_slice(&[0xAA, 0xBB]); // only 2 body bytes, need 3
        assert_eq!(cached_geometry_slice(&blob), None);
    }

    #[test]
    fn decodes_a_blob_of_exactly_four_bytes_as_an_empty_slice() {
        // len=0 with no body and no trailing framing: `[4..4]` is a valid
        // (empty) slice, not a panic.
        assert_eq!(cached_geometry_slice(&0u32.to_le_bytes()), Some(&[][..]));
    }

    #[test]
    fn returns_none_for_a_u32_max_declared_length() {
        // geometry_len = u32::MAX: `4 + len` must not overflow or slice past
        // the buffer on any pointer width.
        let mut blob = u32::MAX.to_le_bytes().to_vec();
        blob.extend_from_slice(&[0xAA; 16]);
        assert_eq!(cached_geometry_slice(&blob), None);
    }

    #[test]
    fn decodes_a_length_exactly_matching_the_remaining_body() {
        // No trailing data-model framing at all: len == body bytes available.
        let mut blob = 5u32.to_le_bytes().to_vec();
        blob.extend_from_slice(&[1, 2, 3, 4, 5]);
        assert_eq!(cached_geometry_slice(&blob), Some(&[1, 2, 3, 4, 5][..]));
    }
}
