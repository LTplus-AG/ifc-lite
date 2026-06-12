// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared IFC processing pipeline and types.
//!
//! This crate extracts the core processing logic so it can be used by both
//! the HTTP server and the native FFI library.

pub mod element;
mod georeferencing;
mod processor;
pub mod style;
mod symbolic;
mod types;

pub use georeferencing::{extract_georeferencing, Georeferencing};
/// Re-exported so the server can name the quality level without a direct
/// `ifc-lite-geometry` dependency edge for one enum.
pub use ifc_lite_geometry::TessellationQuality;
pub use processor::{
    convert_mesh_to_site_local, process_geometry, process_geometry_filtered,
    process_geometry_filtered_with_quality,
    process_geometry_streaming, process_geometry_streaming_filtered,
    process_geometry_streaming_filtered_with_options, process_geometry_streaming_with_options,
    process_geometry_streaming_with_options_and_bootstrap,
    OpeningFilterMode, ProcessingResult, StreamingOptions,
};
pub use style::{default_color_for_type, Rgba, TRANSPARENCY_ALPHA_THRESHOLD};
pub use symbolic::{
    extract_symbolic_data, SymbolicCircle, SymbolicData, SymbolicFillArea, SymbolicGridAxis,
    SymbolicPolyline, SymbolicText,
};
pub use types::mesh::MeshData;
pub use types::response::{
    CoordinateInfo, ModelMetadata, ParseResponse, ProcessingStats,
    QuickMetadataBootstrap, QuickMetadataEntitySummary, QuickMetadataSpatialNode,
};
