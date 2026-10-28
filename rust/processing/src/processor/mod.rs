// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC processing service with parallel geometry extraction.
//!
//! Originally contributed by Mathias Søndergaard (Sonderwoods/Linkajou).
//!
//! [`process`] sequences five phases, each in its own module:
//! `scan` (one walk: entity index, jobs, spans) -> `resolve` (index installed,
//! styles/voids/units/frame resolved, filters applied) -> `pass` (chunked
//! parallel meshing and sink events, with `jobs` meshing one element) ->
//! `finalize` (diagnostics, instances, georeferencing, the result).

use crate::types::mesh::{InstanceRecord, MeshData};
use crate::types::response::{ModelMetadata, ProcessingStats};

mod color_layer;
mod csg_summary;
#[cfg(test)]
#[path = "csg_summary_tests.rs"]
mod csg_summary_tests;
mod diagnostics;
mod entity_index;
pub(crate) mod entry_points;
#[allow(deprecated)]// the deprecated delegates stay exported until the next major
pub use entry_points::{
    process_geometry, process_geometry_filtered, process_geometry_filtered_with_quality,
    process_geometry_filtered_with_quality_and_ids, process_geometry_streaming,
    process_geometry_streaming_filtered, process_geometry_streaming_filtered_with_baked_basis,
    process_geometry_streaming_filtered_with_options, process_geometry_streaming_with_options,
    process_geometry_streaming_with_options_and_bootstrap, process_geometry_with_index,
};
mod finalize;
pub(crate) mod instancing;
mod job;
use job::{normalize_optional_string, EntityJob};
mod jobs;
mod opening_filter;
mod pass;
mod pass_metadata;
mod phase_marks;
use phase_marks::{mark, Clock, Mark};
mod properties;
mod quick_collector;
mod quick_metadata;
mod request;
pub use request::{Batching, Features, ProcessingRequest, StreamingOptions};
mod resolve;
mod run_snapshot;
mod scan;
mod scheduling;
mod schema_detection;
mod sink;
#[doc(hidden)]
pub use sink::ClosureSink;
pub use sink::{FrameEvent, OnBatch, ProcessingSink};
mod site_local;

pub use quick_metadata::is_quick_spatial_type_ci;
pub use schema_detection::detect_schema_version;
pub use site_local::{convert_mesh_to_site_local, native_to_baked};
pub(crate) use site_local::site_local_rotation_invalidates_captured_transforms;

use crate::mesh_frame::{MeshCoordinateSpace, MeshFrame};
pub(crate) use color_layer::resolve_element_color_for_product_definition_shape;

/// Controls how IfcWindow / IfcDoor openings are exported.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpeningFilterMode {
    /// Export all openings and cut their voids in host walls (default behaviour).
    #[default]
    Default = 0,
    /// Skip all IfcWindow / IfcDoor meshes and do not cut any voids.
    IgnoreAll = 1,
    /// Skip only opaque (non-glazed) windows and doors; glazed ones are kept.
    IgnoreOpaque = 2,
}

impl OpeningFilterMode {
    /// Stable string suffix for disk-cache keys. Unlike `Debug` formatting,
    /// this is guaranteed not to change across compiler versions.
    pub fn cache_key_suffix(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::IgnoreAll => "ignore_all",
            Self::IgnoreOpaque => "ignore_opaque",
        }
    }
}

/// Result of processing an IFC file.
pub struct ProcessingResult {
    pub meshes: Vec<MeshData>,
    /// #1623 Phase 2 don't-bake output: per-occurrence instance records emitted when
    /// `StreamingOptions.enable_instancing` is set. Each non-template occurrence of a
    /// repeated single-solid `IfcRepresentationMap` skipped its full materialize; the
    /// template MeshData stays in `meshes` (keyed by `InstanceRecord.template_express_id`)
    /// and each occurrence here places it by a template-relative transform. Always
    /// empty when instancing is off, so exporters/determinism see the flat output.
    pub instances: Vec<InstanceRecord>,
    /// The frame the mesh vertices are expressed in, as its wire tag.
    ///
    /// Always `frame.coordinate_space()`: the constructor below is the only
    /// writer of either field, and `issue_4706_symbolic_shares_the_mesh_frame`
    /// asserts they agree on a live parse.
    pub mesh_coordinate_space: MeshCoordinateSpace,
    /// The frame itself: the tag above PLUS the translation that was
    /// subtracted and the site rotation that was removed.
    ///
    /// A second consumer of the same bytes that has to land in the same frame
    /// reads it here rather than re-deriving the three-tier selection from
    /// `site_transform` and the metadata's origin shift. The server's symbolic
    /// stream is that consumer (#4706): it hands this to
    /// `extract_symbolic_data_with_provenance_in_frame`.
    pub frame: MeshFrame,
    /// IfcSite ObjectPlacement as column-major 4x4 matrix (in meters).
    pub site_transform: Option<Vec<f64>>,
    /// IfcBuilding ObjectPlacement as column-major 4x4 matrix (in meters).
    pub building_transform: Option<Vec<f64>>,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
}

/// The native pipeline: scan, resolve, mesh, finalise. The one body behind
/// every entry point; see [`ProcessingRequest`] for the inputs and
/// [`ProcessingSink`] for the events it raises while it runs.
pub fn process(
    content: &[u8],
    req: &ProcessingRequest,
    sink: &mut dyn ProcessingSink,
) -> ProcessingResult {
    let total_start = mark(Mark::PipelineStart, Clock::now());
    let parse_start = Clock::now();

    // Span taxonomy for the pipeline phases. Each phase span mirrors a
    // ProcessingStats timer window; `phase_ms` / count fields are recorded
    // post-hoc from the measurements the pipeline already takes. Field names
    // reuse the GeometryDiagnostics vocabulary (total_csg_failures,
    // backstop_count, ...) so events and the wasm PipelineDiagnostics channel
    // share one vocabulary.
    let pipeline_span = tracing::info_span!(
        "geometry_pipeline",
        byte_size = content.len(),
        element_count = tracing::field::Empty,
        total_ms = tracing::field::Empty,
    );
    let _pipeline_guard = pipeline_span.clone().entered();
    tracing::info!(
        content_size = content.len(),
        "Starting IFC geometry processing"
    );

    let resolved = resolve::resolve(content, req, sink, parse_start);
    let passed = pass::run(content, req, sink, resolved);
    finalize::finish(content, passed, total_start, &pipeline_span)
}
