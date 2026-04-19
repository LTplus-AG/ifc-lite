// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared IFC processing pipeline and types.
//!
//! This crate extracts the core processing logic so it can be used by both
//! the HTTP server and the native FFI library.

mod processor;
mod types;

pub use processor::{
    convert_mesh_to_site_local, process_geometry, process_geometry_filtered,
    process_geometry_streaming, process_geometry_streaming_filtered,
    process_geometry_streaming_filtered_with_options, process_geometry_streaming_with_options,
    process_geometry_streaming_with_options_and_bootstrap,
    OpeningFilterMode, ProcessingResult, StreamingOptions,
};
pub use types::mesh::MeshData;
pub use types::response::{
    CoordinateInfo, ModelMetadata, ParseResponse, ProcessingStats,
    QuickMetadataBootstrap, QuickMetadataEntitySummary, QuickMetadataSpatialNode,
};
