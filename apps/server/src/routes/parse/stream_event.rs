// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The SSE wire type of `POST /api/v1/parse/parquet-stream`.
//!
//! Its own module because it has two producers that must not drift: the live
//! parse in `parquet_stream.rs` and the cache replay in `cached_replay.rs`,
//! whose whole contract is that a hit is indistinguishable from a miss.

use crate::types::{ModelMetadata, ProcessingStats};
use ifc_lite_processing::SymbolicData;
use serde::Serialize;

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
