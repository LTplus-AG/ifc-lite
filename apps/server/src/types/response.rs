// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Response types for the API.
//!
//! Shared types (ParseResponse, ModelMetadata, CoordinateInfo, ProcessingStats) are
//! re-exported from the `ifc-lite-processing` crate. Server-only types remain here.

use super::MeshData;
use serde::{Deserialize, Serialize};

// Re-export shared types from the processing crate
pub use ifc_lite_processing::{CoordinateInfo, ModelMetadata, ParseResponse, ProcessingStats};

/// Metadata-only response (no geometry).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataResponse {
    /// Total number of entities.
    pub entity_count: usize,
    /// Number of geometry-bearing entities.
    pub geometry_count: usize,
    /// IFC schema version.
    pub schema_version: String,
    /// File size in bytes.
    pub file_size: usize,
}

/// Server-Sent Event types for streaming.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// Initial event with estimated totals.
    Start {
        /// Estimated number of geometry entities.
        total_estimate: usize,
    },

    /// Progress update.
    Progress {
        /// Number of entities processed.
        processed: usize,
        /// Total entities to process.
        total: usize,
        /// Current entity type being processed.
        current_type: String,
    },

    /// Batch of processed meshes.
    Batch {
        /// Meshes in this batch.
        meshes: Vec<MeshData>,
        /// Batch sequence number.
        batch_number: usize,
    },

    /// Processing complete.
    Complete {
        /// Final processing statistics.
        stats: ProcessingStats,
        /// Model metadata.
        metadata: ModelMetadata,
        /// Cache key for the result.
        cache_key: String,
        /// Coordinate space of the mesh vertices: `"site_local"`, `"model_rtc"`, or `"raw_ifc"`.
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_coordinate_space: Option<String>,
        /// IfcSite ObjectPlacement as a column-major 4×4 matrix (metres).
        #[serde(skip_serializing_if = "Option::is_none")]
        site_transform: Option<Vec<f64>>,
        /// IfcBuilding ObjectPlacement as a column-major 4×4 matrix (metres).
        #[serde(skip_serializing_if = "Option::is_none")]
        building_transform: Option<Vec<f64>>,
    },

    /// Error occurred.
    Error {
        /// Error message.
        message: String,
    },
}
