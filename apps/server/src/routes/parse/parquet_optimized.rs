// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `POST /api/v1/parse/parquet/optimized`: the ara3d BOS-optimized Parquet
//! parse endpoint, split out of `parquet.rs` when it gained a cache of its own
//! (issue #3889) so neither module crosses the 400-line ratchet. The cache
//! replay itself (metadata header, read-through-cache, response builder) now
//! lives in `parquet_optimized_replay.rs` (issue #5128) for the same reason.

use super::cache_keys::request_cache_key;
use super::parquet::DataModelStats;
use super::parquet_optimized_replay::{
    cache_data_model, cache_optimized_response, optimized_parquet_response,
    try_cached_optimized_parquet, OptimizedParquetMetadataHeader,
};
use super::{cache_symbolic_data_off_runtime, extract_file, ParseQuery};
use crate::error::ApiError;
use crate::services::{
    baked_basis_zup, extract_data_model, serialize_data_model_to_parquet,
    serialize_to_parquet_optimized_with_stats, VERTEX_MULTIPLIER,
};
use crate::AppState;
use axum::{
    extract::{Multipart, Query, State},
    response::Response,
};
use ifc_lite_processing::{
    extract_symbolic_data_with_provenance_in_frame, process_geometry_filtered_with_quality,
};

/// POST /api/v1/parse/parquet/optimized - Full parse with ara3d BOS-optimized Parquet format.
///
/// Returns highly optimized binary Parquet data with:
/// - Integer quantized vertices (0.1mm precision)
/// - Mesh deduplication (instancing)
/// - Byte colors instead of floats
/// - Optional normals
///
/// Query params:
/// - `normals=true` - Include normals (default: false, compute on client)
///
/// Typical compression: 3-5x smaller than basic Parquet, 50-75x smaller than JSON.
pub async fn parse_parquet_optimized(
    State(state): State<AppState>,
    Query(query): Query<ParseQuery>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    // Extract file from multipart
    // Admission gate (bounded concurrency + byte budget): acquired BEFORE the
    // upload is buffered, reserving the max upload size since multipart rarely
    // declares a length up front. Held for the request's whole lifetime so a
    // disconnected-but-still-running job keeps its memory slot.
    let admission_guard = state
        .admission
        .acquire(state.config.max_file_size_mb as u64 * 1024 * 1024)
        .await?;
    let data = extract_file(&mut multipart, state.config.max_file_size_mb).await?;

    // Generate cache key (include opening filter so different modes get different cache entries)
    let tessellation_quality = query.resolved_tessellation_quality()?;
    let cache_key = request_cache_key(&data, &query, tessellation_quality);

    // Cache first, before any processing (issue #3889). The optimized route is
    // the SMALL payload and the one a viewer opens repeatedly, so re-parsing it
    // on every request was the worst of both shapes.
    if let Some(response) = try_cached_optimized_parquet(&state, &cache_key).await? {
        return Ok(response);
    }

    tracing::info!(
        cache_key = %cache_key,
        size = data.len(),
        "Optimized Parquet cache MISS - processing file (ara3d BOS format)"
    );

    // Parse content
    let content = data;
    let opening_filter = query.opening_filter;

    // The geometry parse, the data model extraction (#5129: this route now
    // produces one the way the flat route does), the 2D symbol stream
    // (IfcAnnotation + IfcGrid, endpoint parity, issue #900) and both
    // serializations all run in this one blocking task, so none of it
    // occupies an async worker. Guard rides the blocking task (see
    // parse_full).
    let cache_key_for_log = cache_key.clone();
    let (result, dm_stats, symbolic_data, parquet_data, dm_parquet, opt_stats, _admission) =
        tokio::task::spawn_blocking(move || -> Result<_, ApiError> {
            // First: geometry and the data model in parallel, mirroring
            // `parse_parquet` -- independent extractions over the same bytes,
            // each on its own rayon thread.
            let (mut result, data_model) = rayon::join(
                || process_geometry_filtered_with_quality(&content, opening_filter, tessellation_quality),
                || extract_data_model(&content),
            );
            let dm_stats = DataModelStats {
                entity_count: data_model.entities.len(),
                property_set_count: data_model.property_sets.len(),
                relationship_count: data_model.relationships.len(),
                spatial_node_count: data_model.spatial_hierarchy.nodes.len(),
            };
            // Don't include normals by default - client can compute them
            // The frame `result`'s vertices were baked in (#4118): the
            // collator's emitted `rel` is consumed directly by this route, so
            // without it a site-rotated model's repeated shapes fail the
            // residual check and fall back to content-hash dedup.
            let basis = baked_basis_zup(
                Some(result.mesh_coordinate_space),
                result.site_transform.as_deref(),
                result.metadata.coordinate_info.origin_shift,
            );
            // The symbol stream used to run in a `rayon::join` BESIDE the
            // parse. It cannot: it needs the frame the parse selected, or a
            // site-local model's symbols keep the site translation and
            // rotation its meshes dropped (#4706). Joined with both
            // serializations instead, so it still overlaps other work. The
            // upload therefore stays resident until the join ends rather than
            // being freed before the serialization; admission reserves the
            // upload size for the request's whole lifetime either way.
            let (symbolic_data, (serialized, dm_parquet)) = rayon::join(
                || extract_symbolic_data_with_provenance_in_frame(&content, result.frame),
                || {
                    rayon::join(
                        || serialize_to_parquet_optimized_with_stats(&result.meshes, false, Some(&basis)),
                        || serialize_data_model_to_parquet(&data_model),
                    )
                },
            );
            drop(content);
            let (parquet_data, opt_stats) = serialized?;
            let dm_parquet = dm_parquet?;
            // Nothing after this reads the meshes; free them here rather than
            // hold the model across the cache writes below.
            drop(std::mem::take(&mut result.meshes));
            tracing::info!(
                cache_key = %cache_key_for_log,
                input_meshes = opt_stats.input_meshes,
                unique_meshes = opt_stats.unique_meshes,
                unique_materials = opt_stats.unique_materials,
                mesh_reuse_ratio = opt_stats.mesh_reuse_ratio,
                payload_size = parquet_data.len(),
                "Optimized Parquet serialization complete"
            );
            Ok((
                result,
                dm_stats,
                symbolic_data,
                parquet_data,
                dm_parquet,
                opt_stats,
                admission_guard,
            ))
        })
        .await??;

    // Cache the data model FIRST (#5129), so it can never sit missing behind
    // a geometry/metadata pair the replay gate would treat as current -- the
    // same ordering `parse_parquet` uses and the same #3869 reasoning: written
    // synchronously, before the response, not in a background task, because a
    // background write races the client's very next request.
    cache_data_model(&state, &cache_key, &dm_parquet).await;

    // Cache the symbolic stream so the client can fetch it via
    // `GET /api/v1/parse/symbolic/{cache_key}`.
    cache_symbolic_data_off_runtime(state.cache.clone(), cache_key.clone(), symbolic_data).await;

    // Create metadata header
    let metadata_header = OptimizedParquetMetadataHeader {
        cache_key: cache_key.clone(),
        metadata: result.metadata,
        stats: result.stats,
        mesh_coordinate_space: Some(result.mesh_coordinate_space),
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        optimization_stats: opt_stats,
        vertex_multiplier: VERTEX_MULTIPLIER,
        data_model_stats: Some(dm_stats),
    };

    let metadata_json = serde_json::to_string(&metadata_header)?;

    // Store body and metadata BEFORE responding, not in a background task like
    // the flat route (issue #3889): a background write races the client's very
    // next request, which is the request the cache exists to serve, and this
    // payload is the small one so the write is cheap. Metadata is written
    // LAST -- after the body AND the data model land -- so it can never sit
    // under a key with either one missing behind it: the replay gate reads
    // the metadata presence as "this cache_key is fully replayable" (#3869,
    // #5129). A write failure is logged and the response still goes out: the
    // parse succeeded, only the replay is lost.
    if let Err(e) = cache_optimized_response(&state, &cache_key, &parquet_data, &metadata_json).await
    {
        tracing::error!(error = %e, cache_key = %cache_key, "Failed to cache optimized Parquet response");
    } else {
        tracing::info!(
            cache_key = %cache_key,
            payload_size = parquet_data.len(),
            "Cached optimized Parquet response"
        );
    }

    optimized_parquet_response(metadata_json, parquet_data)
}
