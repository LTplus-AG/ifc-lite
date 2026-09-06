// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cached-replay tests for `cached_replay.rs`.
//!
//! Split out of that module's inline `mod tests` to keep it under the
//! 400-line ratchet (`rust/processing/tests/module_size_ratchet.rs`), the same
//! way `cache_keys_symbolic_tests.rs` was split out of `cache_keys.rs`.

use super::cached_replay::{cached_geometry_slice, try_cached_replay};
use crate::admission::{Admission, AdmissionCfg};
use crate::config::Config;
use crate::routes::parse::parquet::ParquetMetadataHeader;
use crate::services::cache::DiskCache;
use crate::services::ParquetLayout;
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
    let result = try_cached_replay(&state, "no-such-key", ParquetLayout::Flat).await;
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
        .set_bytes(&format!("{cache_key}-parquet-v5"), &well_framed_blob(&[1, 2, 3]))
        .await
        .unwrap();
    let result = try_cached_replay(&state, cache_key, ParquetLayout::Flat).await;
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
    let result = try_cached_replay(&state, cache_key, ParquetLayout::Flat).await;
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
        .set_bytes(&format!("{cache_key}-parquet-v5"), &[1, 2, 3]) // < 4 bytes
        .await
        .unwrap();
    seed_current_data_model(&state, cache_key).await;

    let result = try_cached_replay(&state, cache_key, ParquetLayout::Flat).await;
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
        .set_bytes(&format!("{cache_key}-parquet-v5"), &well_framed_blob(&[9, 9]))
        .await
        .unwrap();
    seed_current_data_model(&state, cache_key).await;

    let result = try_cached_replay(&state, cache_key, ParquetLayout::Flat).await;
    assert!(result.is_err(), "unparseable cached metadata must be an error");
}

/// Seed a data-model entry at the CURRENT payload version.
async fn seed_current_data_model(state: &AppState, cache_key: &str) {
    state
        .cache
        .set_bytes(
            &crate::routes::parse::cache_keys::data_model_cache_key(cache_key),
            b"data-model-bytes",
        )
        .await
        .unwrap();
}

/// Geometry and metadata both cached, but the data model beside them
/// predates the current payload version: replaying skips the parse, so
/// nothing would ever write the current data-model key and the client's
/// poll never resolves (issue #3869). Must be a miss, so the live parse
/// rewrites both.
#[tokio::test]
async fn miss_when_the_cached_data_model_predates_the_current_version() {
    let state = test_state("miss-stale-datamodel").await;
    let cache_key = "stale-datamodel-key";
    let metadata_bytes = serde_json::to_vec(&sample_metadata_header(cache_key, 3)).unwrap();
    state
        .cache
        .set_bytes(&format!("{cache_key}-parquet-metadata-v4"), &metadata_bytes)
        .await
        .unwrap();
    state
        .cache
        .set_bytes(&format!("{cache_key}-parquet-v5"), &well_framed_blob(&[7, 7, 7]))
        .await
        .unwrap();
    state
        .cache
        .set_bytes(&format!("{cache_key}-datamodel-v5"), b"pre-rel_id-parquet")
        .await
        .unwrap();

    let result = try_cached_replay(&state, cache_key, ParquetLayout::Flat).await;
    assert!(
        matches!(result, Ok(None)),
        "a geometry hit with a stale data model must re-parse, not replay"
    );
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
        .set_bytes(&format!("{cache_key}-parquet-v5"), &well_framed_blob(&geometry))
        .await
        .unwrap();
    // A replay also requires a current data model beside the geometry (#3869).
    seed_current_data_model(&state, cache_key).await;

    let result = try_cached_replay(&state, cache_key, ParquetLayout::Flat).await;
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


/// #4064: finite geolocation, placement and unit-scale values must survive the
/// JSON cache boundary, including the actual Haus northing that lost one ULP.
#[test]
fn issue_4064_json_preserves_coordinate_and_scale_bits() {
    let values: [f64; 10] = [
        49.100435000000004, 8.436539, -0.0, 0.0, 0.001,
        5_000_000.123456789, -5_000_000.123456789,
        0.9999999999999999, 1.0000000000000002, 1.0e-5,
    ];
    let encoded = serde_json::to_vec(&values).unwrap();
    let decoded: Vec<f64> = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded.len(), values.len());
    for (original, restored) in values.iter().zip(decoded) {
        assert_eq!(original.to_bits(), restored.to_bits(), "changed {original}");
    }
}

/// #4064: exercise the real metadata-cache read and SSE replay, using a real
/// Parquet triangle. Compare the cold Complete payload and the cached payload
/// independently to the original finite values, not only to one another.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue_4064_cached_complete_preserves_georeferencing_bits() {
    use super::stream_event::ParquetStreamEvent;
    use ifc_lite_processing::{Georeferencing, SymbolicData};
    let state = test_state("4064-coordinate-roundtrip").await;
    let key = "4064-coordinate-roundtrip";
    let northing = 49.100435000000004_f64;
    let mut matrix = [0.0; 16];
    matrix[0] = 1.0;
    matrix[5] = 1.0;
    matrix[10] = 1.0;
    matrix[15] = 1.0;
    matrix[12] = 8.436539;
    matrix[13] = northing;
    matrix[14] = 110.0;
    matrix[4] = -0.0;
    let mut header = sample_metadata_header(key, 1);
    header.metadata.georeferencing = Some(Georeferencing {
        northings: northing,
        eastings: 8.436539,
        orthogonal_height: 110.0,
        scale: 1.0,
        transform_matrix: matrix,
        ..Default::default()
    });
    header.metadata.coordinate_info.origin_shift = [5_000_000.123456789, northing, -0.0];
    header.metadata.length_unit_scale = Some(0.001);
    let cold = serde_json::to_string(&ParquetStreamEvent::Complete {
        stats: header.stats.clone(),
        metadata: header.metadata.clone(),
        symbolic_data: SymbolicData::default(),
    }).unwrap();
    let triangle = crate::types::MeshData::new(
        42, "IfcWall".to_string(),
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 1, 2], [0.8, 0.8, 0.8, 1.0],
    );
    let geometry = crate::services::serialize_to_parquet(&[triangle]).unwrap();
    state.cache.set_bytes(&format!("{key}-parquet-v5"), &well_framed_blob(&geometry)).await.unwrap();
    state.cache.set_bytes(&format!("{key}-parquet-metadata-v4"), &serde_json::to_vec(&header).unwrap()).await.unwrap();
    seed_current_data_model(&state, key).await;
    let response = try_cached_replay(&state, key, ParquetLayout::Flat).await.unwrap().expect("cache hit");
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    let complete: Vec<serde_json::Value> = text.lines().filter_map(|line| line.strip_prefix("data: "))
        .map(|json| serde_json::from_str::<serde_json::Value>(json).unwrap())
        .filter(|event| event["type"] == "complete").collect();
    assert_eq!(complete.len(), 1, "replay must contain exactly one Complete");
    let cold: serde_json::Value = serde_json::from_str(&cold).unwrap();
    for event in [&cold, &complete[0]] {
        let metadata: ModelMetadata = serde_json::from_value(event["metadata"].clone()).unwrap();
        let geo = metadata.georeferencing.unwrap();
        assert_eq!(geo.northings.to_bits(), northing.to_bits());
        assert_eq!(geo.transform_matrix.map(f64::to_bits), matrix.map(f64::to_bits));
        assert_eq!(metadata.coordinate_info.origin_shift.map(f64::to_bits), header.metadata.coordinate_info.origin_shift.map(f64::to_bits));
        assert_eq!(metadata.length_unit_scale.unwrap().to_bits(), 0.001_f64.to_bits());
    }
    assert_eq!(cold["metadata"], complete[0]["metadata"]);
}
