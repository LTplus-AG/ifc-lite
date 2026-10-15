// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parse endpoints for IFC file processing.

pub(crate) mod cache_keys;
mod cached_replay;
mod stream_batch;
mod stream_event;
mod stream_progress;
mod fetch;
mod json;
mod parquet;
mod parquet_optimized;
mod parquet_optimized_replay;
mod parquet_stream;
mod replay_header;
mod upload;

pub use fetch::{check_cache, get_cached_geometry, get_data_model, get_symbolic};
pub use json::{parse_full, parse_metadata, parse_stream};
pub use parquet::parse_parquet;
pub use parquet_optimized::parse_parquet_optimized;
pub use parquet_stream::parse_parquet_stream;
use upload::{admit_upload, request_cache_key_off_runtime};

use crate::error::ApiError;
use crate::services::cache::DiskCache;
use crate::services::{DataModelEntities, OpeningFilterMode, ParquetLayout, StreamShapes};
use ifc_lite_processing::{SymbolicDataWithProvenance, TessellationQuality};
use std::sync::Arc;

/// Query parameters shared by all parse endpoints.
#[derive(serde::Deserialize, Default, Clone)]
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
    /// Flat-Parquet mesh-table layout (#3888): "flat" (default) or
    /// "shared-shapes" — see [`ParquetLayout`] for why it is opt-in. A query
    /// parameter rather than a header because every endpoint it has to reach
    /// (both parse routes, the cache check, the cached-geometry fetch) already
    /// takes this struct, so the signal travels with the cache identity.
    #[serde(default)]
    pub parquet_layout: ParquetLayout,
    /// Whether `POST /api/v1/parse/parquet-stream` may share shapes ACROSS
    /// batches (#5407): "batch-local" (default) or "cross-batch", which needs
    /// `parquet_layout=shared-shapes`. See [`StreamShapes`] for why it is a
    /// second opt-in rather than implied by the layout. Ignored by every other
    /// route, and not part of the cache identity.
    #[serde(default)]
    pub stream_shapes: StreamShapes,
    /// Which rows the data model's entities table carries (#6034): "all"
    /// (default, every STEP instance) or "rooted" (objects with a GlobalId,
    /// plus every instance another data-model table references). See
    /// [`DataModelEntities`]. Read by every route that writes the data model
    /// (`/parse/parquet`, `/parse/parquet/optimized`, `/parse/parquet-stream`)
    /// and by `/cache/check`, because it selects WHICH data-model entry has to
    /// exist; the geometry and metadata entries are the same for both.
    #[serde(default)]
    pub data_model_entities: DataModelEntities,
    /// SHA-256 of the file the client is asking about, hex, lowercase (#3901).
    ///
    /// Read by `POST /api/v1/parse/parquet-stream` and (since #5128)
    /// `POST /api/v1/parse/parquet/optimized`, and only when the request
    /// carries no multipart body: see [`cached_replay::replay_by_client_hash`]
    /// and [`parquet_optimized_replay::replay_optimized_by_client_hash`] for
    /// what each does and what it is not allowed to do. It lives on this
    /// struct rather than in a header so it travels with the rest of the cache
    /// identity (`opening_filter`, `tessellation_quality`, `parquet_layout`)
    /// through the one place every parse route already parses. A hash paired
    /// with the wrong layout names a different entry, and splitting one
    /// identity across two transports is how such pairings drift apart.
    #[serde(default)]
    pub sha256: Option<String>,
}

impl ParseQuery {
    /// The stream's batch-sharing mode, refusing cross-batch sharing on the
    /// flat layout: that layout has no rotation columns and must stay
    /// byte-identical to v5, so it cannot share anything, and a client asking
    /// for it has misread the contract.
    fn resolved_stream_shapes(&self) -> Result<StreamShapes, ApiError> {
        if self.stream_shapes == StreamShapes::CrossBatch && !self.parquet_layout.has_rotation() {
            return Err(ApiError::BadRequest(
                "stream_shapes=cross-batch requires parquet_layout=shared-shapes".to_string(),
            ));
        }
        Ok(self.stream_shapes)
    }

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

/// Write the symbolic sidecar through [`cache_keys::cache_symbolic_data`] on
/// the blocking pool (#4696).
///
/// That call JSON-encodes the whole 2D symbol stream before it writes, and
/// awaited on an async worker the encode holds that worker for its whole
/// length. Every parse route writes the sidecar through here. The write itself
/// is async, so the blocking thread drives it with `Handle::block_on`.
async fn cache_symbolic_data_off_runtime(
    cache: Arc<DiskCache>,
    cache_key: String,
    symbolic: SymbolicDataWithProvenance,
) {
    let runtime = tokio::runtime::Handle::current();
    let written = tokio::task::spawn_blocking(move || {
        runtime.block_on(cache_keys::cache_symbolic_data(&cache, &cache_key, &symbolic))
    })
    .await;
    if let Err(e) = written {
        tracing::error!(error = %e, "Symbolic data cache task failed");
    }
}

#[cfg(test)]
mod parquet_tests;

#[cfg(test)]
mod parquet_optimized_tests;

#[cfg(test)]
mod json_tests;

#[cfg(test)]
mod finish_tests;

#[cfg(test)]
mod worker_thread_tests;

#[cfg(test)]
mod fetch_tests;

#[cfg(test)]
mod cache_keys_symbolic_tests;

#[cfg(test)]
mod cache_keys_tests;

#[cfg(test)]
mod data_model_entities_tests;

#[cfg(test)]
mod cached_replay_tests;

#[cfg(test)]
mod cached_replay_batches_tests;

#[cfg(test)]
#[path = "resolved_tessellation_quality_tests.rs"]
mod resolved_tessellation_quality_tests;
