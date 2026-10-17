// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The eleven historical entry points, as one-line delegates onto
//! [`process`](super::process).
//!
//! Each builds the exact [`ProcessingRequest`] its old body built and adapts
//! its closure arguments to a sink, so output and event order are unchanged.
//! `process_geometry` is the convenience that stays; the other ten are
//! deprecated and deleted in the next major (C10). Do not add a variant: a new pass
//! input is a [`ProcessingRequest`] field, a new output stream a
//! [`ProcessingSink`](super::ProcessingSink) event.

use super::{
    process, Batching, ClosureSink, OpeningFilterMode, ProcessingRequest, ProcessingResult,
    StreamingOptions,
};
use crate::types::mesh::MeshData;
use crate::types::response::QuickMetadataBootstrap;
use ifc_lite_core::EntityIndex;
use ifc_lite_geometry::TessellationQuality;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

/// Process IFC content with parallel geometry extraction (default opening filter).
pub fn process_geometry<T>(content: &T) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process(content.as_ref(), &ProcessingRequest::full_pass(), &mut ())
}

/// Like [`process_geometry`] but reuses a pre-built entity index instead of scanning
/// `content` for one. For a caller that also runs a second pass over the same bytes
/// (e.g. pairing GLB export with attribute extraction): build the index once with
/// `ifc_lite_core::build_entity_index` and share it across both, skipping the
/// duplicate scan. `index` MUST be built from the same `content`. Output is identical
/// to `process_geometry(content)`.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_with_index<T>(content: &T, index: Arc<EntityIndex>) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process(content.as_ref(), &ProcessingRequest::full_pass().index(index), &mut ())
}

/// Process IFC content with parallel geometry extraction and emit batches as they complete.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_streaming(
    content: &[u8],
    batch_size: usize,
    on_batch: impl FnMut(&[MeshData], usize, usize),
) -> ProcessingResult {
    let request = ProcessingRequest::default().batching(Batching::new(batch_size, batch_size));
    process(content, &request, &mut closures(on_batch, |_| {}, |_| {}, None))
}

/// Process IFC content with parallel geometry extraction and configurable streaming behavior.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_streaming_with_options(
    content: &[u8],
    options: StreamingOptions,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> ProcessingResult {
    let request = ProcessingRequest::from_streaming(OpeningFilterMode::Default, options);
    process(content, &request, &mut closures(on_batch, on_color_update, |_| {}, None))
}

/// Process IFC content with parallel geometry extraction and emit a quick metadata bootstrap
/// once the scan phase completes.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_streaming_with_options_and_bootstrap(
    content: &[u8],
    options: StreamingOptions,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    let request = ProcessingRequest::from_streaming(OpeningFilterMode::Default, options);
    process(
        content,
        &request,
        &mut closures(on_batch, on_color_update, on_quick_metadata_bootstrap, None),
    )
}

/// Process IFC content with parallel geometry extraction and a configurable opening filter.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_filtered<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process(content.as_ref(), &ProcessingRequest::full_pass().opening_filter(opening_filter), &mut ())
}

/// Like [`process_geometry_filtered`] with a consumer-selected tessellation
/// detail level (#976), exposed to the browser and server too.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_filtered_with_quality<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    let request =
        ProcessingRequest::full_pass().opening_filter(opening_filter).quality(tessellation_quality);
    process(content.as_ref(), &request, &mut ())
}

/// Like [`process_geometry_filtered_with_quality`], but restricts tessellation
/// to the supplied IFC express ids. `None` preserves the unfiltered behaviour;
/// `Some(empty)` is an active filter that produces no meshes.
///
/// The pipeline still scans and resolves the whole file before applying the
/// allow-list. This preserves geometry dependencies that are not themselves
/// output jobs, such as the `IfcOpeningElement` cutters needed to mesh a
/// selected wall correctly, while non-selected product jobs never reach the
/// tessellation loop.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_filtered_with_quality_and_ids<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
    entity_ids: Option<&HashSet<u32>>,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    let request = ProcessingRequest::full_pass()
        .opening_filter(opening_filter)
        .quality(tessellation_quality)
        .ids(entity_ids.map(|ids| Arc::new(ids.clone())));
    process(content.as_ref(), &request, &mut ())
}

/// Process IFC content with parallel geometry extraction and a configurable streaming batch size.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_streaming_filtered(
    content: &[u8],
    opening_filter: OpeningFilterMode,
    batch_size: usize,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> ProcessingResult {
    let request = ProcessingRequest::default()
        .opening_filter(opening_filter)
        .batching(Batching::new(batch_size, batch_size));
    process(content, &request, &mut closures(on_batch, on_color_update, |_| {}, None))
}

/// Process IFC content with parallel geometry extraction and configurable streaming behavior.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_streaming_filtered_with_options(
    content: &[u8],
    opening_filter: OpeningFilterMode,
    options: StreamingOptions,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    let request = ProcessingRequest::from_streaming(opening_filter, options);
    process(
        content,
        &request,
        &mut closures(on_batch, on_color_update, on_quick_metadata_bootstrap, None),
    )
}

/// [`process_geometry_streaming_filtered_with_options`], plus:
/// `baked_basis_out` receives [`native_to_baked`](super::native_to_baked) for the frame this
/// pass bakes vertices in. It is set once, after frame selection and BEFORE
/// the first batch is emitted, so a streaming consumer can collate each batch
/// in the baked frame as it arrives. It equals `native_to_baked` of the
/// returned result's `mesh_coordinate_space`, `site_transform` and
/// `metadata.coordinate_info.origin_shift`.
#[deprecated(since = "21.4.0", note = "use `process` with a `ProcessingRequest`; the entry points are deleted in the next major")]
pub fn process_geometry_streaming_filtered_with_baked_basis(
    content: &[u8],
    opening_filter: OpeningFilterMode,
    options: StreamingOptions,
    baked_basis_out: &OnceLock<[f64; 16]>,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    let request = ProcessingRequest::from_streaming(opening_filter, options);
    process(
        content,
        &request,
        &mut closures(on_batch, on_color_update, on_quick_metadata_bootstrap, Some(baked_basis_out)),
    )
}

/// Pins the closure shapes, so a delegate's call reads as the sink it builds.
fn closures<'a, B, C, Q>(
    on_batch: B,
    on_color_update: C,
    on_bootstrap: Q,
    baked_basis_out: Option<&'a OnceLock<[f64; 16]>>,
) -> ClosureSink<'a, B, C, Q>
where
    B: FnMut(&[MeshData], usize, usize),
    C: FnMut(&[(u32, [f32; 4])]),
    Q: FnMut(&QuickMetadataBootstrap),
{
    ClosureSink { on_batch, on_color_update, on_bootstrap, baked_basis_out }
}
