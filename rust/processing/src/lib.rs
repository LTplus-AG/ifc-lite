// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared IFC processing pipeline and types.
//!
//! This crate extracts the core processing logic so it can be used by both
//! the HTTP server and the native FFI library.

pub mod determinism;
pub(crate) mod parallel_scan;
mod shard_classes;
pub use parallel_scan::{build_entity_index_parallel, scan_shard, ShardRecords};
pub use shard_classes::{
    classify_type_name, scan_shard_classified, PREPASS_CLASS_CODE_MASK,
    PREPASS_CLASS_FLAG_GEOMETRY_JOB, PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
    PREPASS_CLASS_INDEXED_COLOUR_MAP, PREPASS_CLASS_MATERIAL_DEF_REPR,
    PREPASS_CLASS_MAPPED_ITEM, PREPASS_CLASS_MATERIAL_LAYER_SET, PREPASS_CLASS_NONE,
    PREPASS_CLASS_PROJECT, PREPASS_CLASS_REL_DEFINES_BY_TYPE,
    PREPASS_CLASS_REL_AGGREGATES, PREPASS_CLASS_REL_ASSOCIATES_MATERIAL, PREPASS_CLASS_REL_FILLS,
    PREPASS_CLASS_REL_VOIDS, PREPASS_CLASS_SITE, PREPASS_CLASS_STYLED_ITEM,
};
// `determinism::diff_report` unit tests (#1549) live in this sibling
// `_tests.rs` file, declared from here rather than inside `determinism.rs`,
// because that module already sits exactly at its frozen
// `module_size_ratchet` budget (`tests/module_size_allowlist.txt`); adding
// even a `mod` declaration there would fail the "no allowlisted file grows"
// gate. `_tests.rs` is itself exempt from that ratchet (see
// `module_size_ratchet.rs`'s `is_exempt`).
#[cfg(test)]
#[path = "determinism_tests.rs"]
mod determinism_tests;
pub mod element;
pub mod geometry_export;
mod georeferencing;
pub mod pipeline_diagnostics;
pub mod prepass;
mod prepass_styled;
pub use prepass_styled::flat_styles_rgba8_from_geometry_columns;
mod processor;
pub(crate) mod simplify_math;
pub mod simplify_session;
// `simplify_session` unit tests live in a sibling `_tests.rs` file so the
// module itself stays inside its `module_size_ratchet` budget (same pattern
// as `determinism_tests.rs`; `_tests.rs` files are ratchet-exempt).
#[cfg(test)]
#[path = "simplify_session_tests.rs"]
mod simplify_session_tests;
pub mod stream_meta;
pub mod style;
mod symbolic;
mod types;

pub use geometry_export::{build_geometry_data_export, ExportedElement, GeometryDataExport};
pub use georeferencing::{extract_georeferencing, Georeferencing};
pub use pipeline_diagnostics::{
    PipelineDiagnostics, PipelinePhaseTimings, PIPELINE_DIAGNOSTICS_SCHEMA_VERSION,
};
/// Re-exported so the server can name the quality level without a direct
/// `ifc-lite-geometry` dependency edge for one enum.
pub use ifc_lite_geometry::TessellationQuality;
pub use processor::{
    convert_mesh_to_site_local, process_geometry, process_geometry_filtered,
    process_geometry_filtered_with_quality, process_geometry_with_index,
    process_geometry_streaming, process_geometry_streaming_filtered,
    process_geometry_streaming_filtered_with_options, process_geometry_streaming_with_options,
    process_geometry_streaming_with_options_and_bootstrap,
    OpeningFilterMode, ProcessingResult, StreamingOptions,
};
pub use simplify_session::{simplify_element, SimplifiedElement, SimplifyRecordInput, SimplifySkip};
pub use style::{default_color_for_type, Rgba, TRANSPARENCY_ALPHA_THRESHOLD};
pub use symbolic::{
    extract_symbolic_data, SymbolicCircle, SymbolicData, SymbolicFillArea, SymbolicGridAxis,
    SymbolicPolyline, SymbolicText,
};
pub use types::mesh::{InstanceRecord, MeshData, RawInstanceOccurrence};
pub use types::response::{
    CoordinateInfo, ModelMetadata, ParseResponse, ProcessingStats,
    QuickMetadataBootstrap, QuickMetadataEntitySummary, QuickMetadataSpatialNode,
};
