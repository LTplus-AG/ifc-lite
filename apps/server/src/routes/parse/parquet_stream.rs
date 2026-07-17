// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! SSE Parquet-batch streaming parse endpoint.

use super::cache_keys::{cache_symbolic_data, request_cache_key};
use super::parquet::ParquetMetadataHeader;
use super::{extract_file, ParseQuery};
use crate::error::ApiError;
use crate::services::{extract_data_model, process_streaming, serialize_data_model_to_parquet};
use crate::types::{ModelMetadata, ProcessingStats, StreamEvent};
use crate::AppState;
use axum::{
    extract::{Multipart, Query, State},
    response::sse::{Event, KeepAlive, Sse},
};
use ifc_lite_processing::SymbolicData;
use serde::Serialize;
use std::convert::Infallible;

/// SSE event types for Parquet streaming.
// Variant sizes differ because the payload events carry buffers; boxing them
// would complicate the SSE serialization path for no runtime benefit here.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ParquetStreamEvent {
    /// Initial event with estimated totals.
    Start {
        total_estimate: usize,
        cache_key: String,
    },
    /// Progress update.
    Progress { processed: usize, total: usize },
    /// Batch of geometry data as base64-encoded Parquet.
    Batch {
        /// Base64-encoded Parquet data containing this batch's meshes.
        data: String,
        /// Number of meshes in this batch.
        mesh_count: usize,
        /// Batch sequence number (1-indexed).
        batch_number: usize,
    },
    /// Processing complete.
    Complete {
        stats: ProcessingStats,
        metadata: ModelMetadata,
        /// 2D symbol data extracted from `IfcAnnotation` and `IfcGrid`
        /// entities — parity with `POST /api/v1/parse` (issue #900).
        #[serde(default, skip_serializing_if = "SymbolicData::is_empty")]
        symbolic_data: SymbolicData,
    },
    /// Error occurred.
    Error { message: String },
}

/// POST /api/v1/parse/parquet-stream - Streaming parse with Parquet batches.
///
/// Returns SSE events with Parquet-encoded geometry batches for progressive rendering.
/// Each batch can be decoded and rendered immediately without waiting for the full response.
///
/// Events:
/// - `start`: Initial event with `total_estimate` and `cache_key`
/// - `progress`: Progress updates with `processed` and `total` counts
/// - `batch`: Geometry batch with base64-encoded Parquet `data`, `mesh_count`, `batch_number`
/// - `complete`: Final event with `stats` and `metadata`
/// - `error`: Error event with `message`
///
/// After `complete`, client should fetch data model via `/api/v1/data-model/{cache_key}`.
pub async fn parse_parquet_stream(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<axum::response::Response, ApiError> {
    use crate::services::{serialize_to_parquet, StreamingParquetCacheWriter};
    use axum::response::IntoResponse;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use futures::StreamExt;
    use std::sync::{Arc, Mutex};

    // Extract file
    // Admission gate (bounded concurrency + byte budget): acquired BEFORE the
    // upload is buffered, reserving the max upload size since multipart rarely
    // declares a length up front. Held for the request's whole lifetime so a
    // disconnected-but-still-running job keeps its memory slot.
    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key before processing (include opening filter + quality)
    let tessellation_quality = query.resolved_tessellation_quality()?;
    let cache_key = request_cache_key(&data, &query, tessellation_quality);
    let cache_key_clone = cache_key.clone();

    // OPTIMIZATION: Check cache first and fast-path return if available
    // This avoids re-processing files that are already cached (see
    // `cached_replay.rs`; a short/corrupt blob falls through as a miss).
    if let Some(response) = super::cached_replay::try_cached_replay(&state, &cache_key).await? {
        // Cached replay: no parse work runs, so holding the admission
        // guard (and its CPU slot) while a slow client drains the SSE
        // would starve real parses for nothing. The replay blob is
        // already materialized and bounded by cache content, far below
        // a parse working set.
        drop(admission_guard);
        return Ok(response);
    }

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Streaming cache MISS - processing file"
    );

    let content = data;
    let initial_batch_size = state.config.initial_batch_size;
    let max_batch_size = state.config.max_batch_size;
    let cache = state.cache.clone();

    // Incremental cache writer: each batch's columns are appended as Parquet
    // row groups (GLOBAL offsets) and the meshes dropped, replacing the old
    // Arc<Mutex<Vec<MeshData>>> accumulator that held a FULL second copy of
    // the model's geometry until Complete. `None` after a writer error (the
    // cache fill is skipped; the client stream is unaffected).
    let cache_writer: Arc<Mutex<Option<StreamingParquetCacheWriter>>> =
        Arc::new(Mutex::new(match StreamingParquetCacheWriter::new() {
            Ok(w) => Some(w),
            Err(e) => {
                tracing::error!(error = %e, "Failed to create streaming cache writer");
                None
            }
        }));
    let cache_writer_for_stream = cache_writer.clone();
    let cache_for_geometry = cache.clone();
    let cache_key_for_geometry = cache_key.clone();

    // Create streaming response that yields Parquet batches
    let stream = process_streaming(
        content.clone(),
        initial_batch_size,
        max_batch_size,
        query.opening_filter,
        tessellation_quality,
        Some(admission_guard),
    )
    .map(move |event: StreamEvent| {
        let sse_event = match event {
            StreamEvent::Start { total_estimate } => {
                ParquetStreamEvent::Start {
                    total_estimate,
                    cache_key: cache_key_clone.clone(),
                }
            }
            StreamEvent::Progress { processed, total, .. } => {
                ParquetStreamEvent::Progress { processed, total }
            }
            StreamEvent::Batch { meshes, batch_number } => {
                // Per-batch CPU work (client-blob serialization + cache-writer
                // append) runs inside this stream map, i.e. on an async worker.
                // On the multi-thread runtime, step off the async pool for it
                // so other connections' polls are not starved. (Guarded by
                // runtime flavor: block_in_place panics on current_thread,
                // which the #[tokio::test] harness uses.)
                let cpu_work = || {
                    if let Ok(mut slot) = cache_writer_for_stream.lock() {
                        if let Some(writer) = slot.as_mut() {
                            if let Err(e) = writer.append(&meshes) {
                                tracing::error!(error = %e, "Streaming cache writer failed; skipping cache fill");
                                *slot = None;
                            }
                        }
                    }
                    serialize_to_parquet(&meshes)
                };
                let serialized = if tokio::runtime::Handle::current().runtime_flavor()
                    == tokio::runtime::RuntimeFlavor::MultiThread
                {
                    tokio::task::block_in_place(cpu_work)
                } else {
                    cpu_work()
                };

                match serialized {
                    Ok(parquet_bytes) => {
                        let base64_data = STANDARD.encode(&parquet_bytes);
                        ParquetStreamEvent::Batch {
                            data: base64_data,
                            mesh_count: meshes.len(),
                            batch_number,
                        }
                    }
                    Err(e) => {
                        ParquetStreamEvent::Error {
                            message: format!("Failed to serialize batch: {}", e),
                        }
                    }
                }
            }
            StreamEvent::Complete { stats, metadata, mesh_coordinate_space, site_transform, building_transform, symbolic_data, .. } => {
                // Cache the symbolic stream so the cached-geometry fast-path and
                // `GET /api/v1/parse/symbolic/{cache_key}` reach parity (issue #900).
                // Reuses the value already computed inside `process_streaming` —
                // no re-extraction.
                {
                    let cache = cache_for_geometry.clone();
                    let key = cache_key_for_geometry.clone();
                    let symbolic_for_cache = symbolic_data.clone();
                    tokio::spawn(async move {
                        cache_symbolic_data(&cache, &key, &symbolic_for_cache).await;
                    });
                }

                // Finish the incremental writer: the cache blob was built row
                // group by row group as batches streamed, so nothing is
                // re-serialized and no second copy of the geometry exists.
                let cache = cache_for_geometry.clone();
                let key = cache_key_for_geometry.clone();
                let stats_clone = stats.clone();
                let metadata_clone = metadata.clone();
                let writer_for_cache = cache_writer.clone();
                let coord_space = mesh_coordinate_space.clone();
                let site_tf = site_transform.clone();
                let building_tf = building_transform.clone();

                tokio::spawn(async move {
                    // Take the writer (moves out of Arc<Mutex>).
                    let writer = {
                        match writer_for_cache.lock() {
                            Ok(mut guard) => guard.take(),
                            Err(_) => {
                                tracing::error!("Failed to lock streaming cache writer");
                                return;
                            }
                        }
                    };
                    let Some(writer) = writer else {
                        tracing::warn!("Streaming cache writer unavailable; skipping cache fill");
                        return;
                    };
                    if writer.mesh_count() == 0 {
                        tracing::warn!("No meshes streamed; skipping cache fill");
                        return;
                    }

                    tracing::info!(
                        mesh_count = writer.mesh_count(),
                        "Caching streamed geometry (incremental writer, no re-serialization)"
                    );

                    // `finish_combined` writes the outer `[geo_len][geo_bytes]
                    // [dm_len=0]` framing (same as non-streaming endpoint,
                    // format: [geometry_len: u32][geometry_data][data_model_len: u32])
                    // directly, instead of framing the inner geometry blob and
                    // then copying it a second time into an outer buffer.
                    let finish_result =
                        tokio::task::spawn_blocking(move || writer.finish_combined()).await;

                    if let Ok(Ok(combined_parquet)) = finish_result {
                        // Cache geometry (same format as non-streaming)
                        let parquet_cache_key = format!("{}-parquet-v4", key);
                        if let Err(e) = cache.set_bytes(&parquet_cache_key, &combined_parquet).await {
                            tracing::error!(error = %e, "Failed to cache geometry from stream");
                        } else {
                            tracing::info!(
                                cache_key = %parquet_cache_key,
                                size = combined_parquet.len(),
                                "Geometry cached from stream (optimized - no re-processing)"
                            );
                        }

                        // Cache metadata
                        let metadata_header = ParquetMetadataHeader {
                            cache_key: key.clone(),
                            metadata: metadata_clone,
                            stats: stats_clone,
                            mesh_coordinate_space: coord_space,
                            site_transform: site_tf,
                            building_transform: building_tf,
                            data_model_stats: None, // Data model cached separately via data model endpoint
                        };
                        if let Ok(metadata_json) = serde_json::to_vec(&metadata_header) {
                            let metadata_cache_key = format!("{}-parquet-metadata-v4", key);
                            if let Err(e) = cache.set_bytes(&metadata_cache_key, &metadata_json).await {
                                tracing::error!(error = %e, "Failed to cache metadata from stream");
                            } else {
                                tracing::debug!(cache_key = %metadata_cache_key, "Metadata cached from stream");
                            }
                        }
                    } else {
                        tracing::error!("Failed to serialize accumulated meshes for caching");
                    }
                });

                ParquetStreamEvent::Complete { stats, metadata, symbolic_data }
            }
            StreamEvent::Error { message } => {
                ParquetStreamEvent::Error { message }
            }
        };

        let json = serde_json::to_string(&sse_event).unwrap_or_else(|e| {
            serde_json::to_string(&ParquetStreamEvent::Error {
                message: e.to_string(),
            })
            .unwrap()
        });
        Ok(Event::default().data(json))
    });

    // Spawn background task to extract and cache data model
    let content_for_cache = content.clone();
    let cache_key_for_dm = cache_key.clone();
    let cache_for_dm = cache.clone();
    let admission_for_dm = state.admission.clone();
    tokio::spawn(async move {
        // The data-model extraction re-parses the whole upload, so it must
        // pass admission like any parse job. It is a cache-fill optimization:
        // when the server is saturated, skipping it (the next request rebuilds
        // it inline) beats bypassing the gate.
        let _dm_admission = match admission_for_dm
            .acquire(content_for_cache.len() as u64)
            .await
        {
            Ok(guard) => guard,
            Err(_) => {
                tracing::debug!("Skipping data-model cache fill: admission saturated");
                return;
            }
        };
        // Run data model extraction in blocking task
        let dm_result =
            tokio::task::spawn_blocking(move || extract_data_model(&content_for_cache)).await;

        if let Ok(data_model) = dm_result {
            // Serialize and cache
            let serialize_result =
                tokio::task::spawn_blocking(move || serialize_data_model_to_parquet(&data_model))
                    .await;

            if let Ok(Ok(parquet_data)) = serialize_result {
                let dm_key = format!("{}-datamodel-v5", cache_key_for_dm);
                if let Err(e) = cache_for_dm.set_bytes(&dm_key, &parquet_data).await {
                    tracing::error!(error = %e, "Failed to cache data model from stream");
                } else {
                    tracing::info!(cache_key = %dm_key, size = parquet_data.len(), "Data model cached from stream");
                }
            }
        }
    });

    let boxed_stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>,
    > = Box::pin(stream);
    Ok(Sse::new(boxed_stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}
