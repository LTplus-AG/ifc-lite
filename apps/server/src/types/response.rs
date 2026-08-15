// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Response types for the API.
//!
//! Shared types (ParseResponse, ModelMetadata, CoordinateInfo, ProcessingStats) are
//! re-exported from the `ifc-lite-processing` crate. Server-only types remain here.

use super::MeshData;
use ifc_lite_processing::SymbolicData;
use serde::{Deserialize, Serialize};

// Re-export shared types from the processing crate
pub use ifc_lite_processing::{ModelMetadata, ParseResponse, ProcessingStats};

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
// Variant sizes differ because the payload events carry buffers; boxing them
// would complicate the SSE serialization path for no runtime benefit here.
#[allow(clippy::large_enum_variant)]
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
        /// 2D symbol data extracted from `IfcAnnotation` and `IfcGrid`
        /// entities — mirrors the inline field on `POST /api/v1/parse`
        /// (issue #843) so the streaming paths reach parity (issue #900).
        #[serde(default, skip_serializing_if = "SymbolicData::is_empty")]
        symbolic_data: SymbolicData,
    },

    /// Error occurred.
    Error {
        /// Error message.
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `Option` fields on `StreamEvent::Complete` are omitted from the
    /// wire when absent (`skip_serializing_if = "Option::is_none"`) — older
    /// clients / cached blobs never carried them, and re-adding the key
    /// unconditionally would be a silent shape change nothing else pins.
    #[test]
    fn complete_omits_absent_optional_fields_from_the_wire() {
        let event = StreamEvent::Complete {
            stats: ProcessingStats::default(),
            metadata: ModelMetadata::default(),
            cache_key: "k".to_string(),
            mesh_coordinate_space: None,
            site_transform: None,
            building_transform: None,
            symbolic_data: SymbolicData::default(),
        };
        let json = serde_json::to_value(&event).unwrap();
        let obj = json.as_object().unwrap();
        assert!(
            !obj.contains_key("mesh_coordinate_space"),
            "None mesh_coordinate_space must be omitted, got: {json}"
        );
        assert!(
            !obj.contains_key("site_transform"),
            "None site_transform must be omitted, got: {json}"
        );
        assert!(
            !obj.contains_key("building_transform"),
            "None building_transform must be omitted, got: {json}"
        );
        assert!(
            !obj.contains_key("symbolic_data"),
            "empty symbolic_data must be omitted, got: {json}"
        );
    }

    /// The inverse: when present, each optional field MUST actually reach
    /// the wire (an over-eager `skip_serializing_if` predicate would drop a
    /// real value silently).
    #[test]
    fn complete_includes_present_optional_fields_on_the_wire() {
        let event = StreamEvent::Complete {
            stats: ProcessingStats::default(),
            metadata: ModelMetadata::default(),
            cache_key: "k".to_string(),
            mesh_coordinate_space: Some("site_local".to_string()),
            site_transform: Some(vec![1.0; 16]),
            building_transform: Some(vec![2.0; 16]),
            symbolic_data: SymbolicData::default(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["mesh_coordinate_space"], "site_local");
        assert_eq!(json["site_transform"].as_array().unwrap().len(), 16);
        assert_eq!(json["building_transform"].as_array().unwrap().len(), 16);
    }
}
