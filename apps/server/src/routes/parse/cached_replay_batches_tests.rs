// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Multi-batch replay-shape tests for `cached_replay.rs` (issue #3895): a
//! cache hit built from more than one live stream batch must replay as
//! Start / (Batch, Progress) x N / Complete, matching the live path's event
//! shape, instead of one oversized batch and zero progress events. Split out
//! of `cached_replay_tests.rs` (rather than growing it) to keep both files
//! under the 400-line ratchet.

use super::cached_replay::try_cached_replay;
use crate::admission::{Admission, AdmissionCfg};
use crate::config::Config;
use crate::routes::parse::parquet::ParquetMetadataHeader;
use crate::services::cache::DiskCache;
use crate::services::parquet::{serialize_to_parquet, StreamingParquetCacheWriter};
use crate::types::{MeshData, ModelMetadata, ProcessingStats};
use crate::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::sync::Arc;

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-test-cached-replay-batches-{}-{}",
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

fn test_mesh(id: u32, verts: usize) -> MeshData {
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    for i in 0..verts {
        positions.extend_from_slice(&[i as f32, 0.0, 0.0]);
        normals.extend_from_slice(&[0.0, 1.0, 0.0]);
    }
    let indices: Vec<u32> = (0..verts.min(3) as u32).collect();
    MeshData::new(id, "IfcWall".to_string(), positions, normals, indices, [
        0.2, 0.4, 0.6, 1.0,
    ])
}

/// Parse an SSE body's `data: {...}` lines into their JSON payloads, in
/// stream order.
fn sse_payloads(text: &str) -> Vec<serde_json::Value> {
    text.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

async fn seed_cache_from_batches(
    state: &AppState,
    cache_key: &str,
    batches: &[Vec<MeshData>],
    total_meshes: usize,
) {
    let mut writer = StreamingParquetCacheWriter::new().unwrap();
    for batch in batches {
        writer.append(batch).unwrap();
    }
    let combined = writer.finish_combined().unwrap();

    let metadata_bytes = serde_json::to_vec(&sample_metadata_header(cache_key, total_meshes)).unwrap();
    state
        .cache
        .set_bytes(&format!("{cache_key}-parquet-metadata-v4"), &metadata_bytes)
        .await
        .unwrap();
    state
        .cache
        .set_bytes(&format!("{cache_key}-parquet-v5"), &combined)
        .await
        .unwrap();
    seed_current_data_model(state, cache_key).await;
}

async fn replay_sse_payloads(state: &AppState, cache_key: &str) -> Vec<serde_json::Value> {
    let response = match try_cached_replay(state, cache_key).await {
        Ok(Some(response)) => response,
        other => panic!("expected a cache hit, got {:?}", other.map(|r| r.is_some())),
    };
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    sse_payloads(&text)
}

/// The core #3895 regression check: a cache built from TWO live stream
/// batches must replay as Start / (Batch, Progress) x2 / Complete, with
/// `processed` climbing monotonically to `total`, and each batch's payload
/// matching, byte for byte, what the live per-batch serializer would have
/// sent for that same slice of meshes.
#[tokio::test]
async fn cache_hit_replays_multiple_batches_matching_the_live_shape() {
    let batch_a = vec![test_mesh(1, 3), test_mesh(2, 4)];
    let batch_b = vec![test_mesh(3, 2), test_mesh(4, 5), test_mesh(5, 1)];

    let state = test_state("multi-batch").await;
    let cache_key = "multi-batch-key";
    seed_cache_from_batches(&state, cache_key, &[batch_a.clone(), batch_b.clone()], 5).await;

    let events = replay_sse_payloads(&state, cache_key).await;

    let batches: Vec<&serde_json::Value> = events.iter().filter(|e| e["type"] == "batch").collect();
    let progresses: Vec<&serde_json::Value> =
        events.iter().filter(|e| e["type"] == "progress").collect();
    assert_eq!(batches.len(), 2, "expected two batch events, got {events:?}");
    // One progress before the first batch (matching the live path's initial
    // `processed: 0`) plus one per batch.
    assert_eq!(progresses.len(), 3, "expected three progress events, got {events:?}");

    let processed: Vec<i64> = progresses.iter().map(|p| p["processed"].as_i64().unwrap()).collect();
    assert_eq!(processed, vec![0, 2, 5], "processed must climb monotonically to total");

    let expected_a = serialize_to_parquet(&batch_a).unwrap();
    let expected_b = serialize_to_parquet(&batch_b).unwrap();
    let decode = |e: &serde_json::Value| STANDARD.decode(e["data"].as_str().unwrap()).unwrap();
    assert_eq!(decode(batches[0]), expected_a.to_vec(), "batch 1 payload must match the live encoding");
    assert_eq!(decode(batches[1]), expected_b.to_vec(), "batch 2 payload must match the live encoding");
}

/// A cache built from a single live stream batch has no boundary to recover,
/// so the replay falls back to one whole-geometry batch — but it must STILL
/// carry the live event shape around it. Asserted as the exact sequence: the
/// pre-fix code emitted start / batch / complete with no progress at all, so
/// an "at least one of each" check would not have failed on it.
#[tokio::test]
async fn small_cache_hit_still_yields_the_live_event_sequence() {
    let meshes = vec![test_mesh(1, 3)];

    let state = test_state("small-cache-hit").await;
    let cache_key = "small-cache-hit-key";
    seed_cache_from_batches(&state, cache_key, &[meshes], 1).await;

    let events = replay_sse_payloads(&state, cache_key).await;

    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        vec!["start", "progress", "batch", "progress", "complete"],
        "got {events:?}"
    );
    let progresses: Vec<i64> = events
        .iter()
        .filter(|e| e["type"] == "progress")
        .map(|p| p["processed"].as_i64().unwrap())
        .collect();
    assert_eq!(progresses, vec![0, 1], "processed must still reach total");
}
