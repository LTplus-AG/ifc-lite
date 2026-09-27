// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Non-streaming geometry entry points with tessellation controls.

use super::{
    process_geometry_streaming_filtered_with_options,
    process_geometry_streaming_filtered_with_options_and_ids, OpeningFilterMode,
    ProcessingResult, StreamingOptions,
};
use ifc_lite_geometry::TessellationQuality;
use std::collections::HashSet;

/// Like [`super::process_geometry_filtered`] with a consumer-selected
/// tessellation detail level (#976), exposed to the browser and server too.
pub fn process_geometry_filtered_with_quality<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process_geometry_streaming_filtered_with_options(
        content.as_ref(),
        opening_filter,
        full_pass_options(tessellation_quality),
        |_, _, _| {},
        |_| {},
        |_| {},
    )
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
pub fn process_geometry_filtered_with_quality_and_ids<T>(
    content: &T,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
    entity_ids: Option<&HashSet<u32>>,
) -> ProcessingResult
where
    T: AsRef<[u8]> + ?Sized,
{
    process_geometry_streaming_filtered_with_options_and_ids(
        content.as_ref(),
        opening_filter,
        full_pass_options(tessellation_quality),
        super::baked_basis::PassScope { entity_ids, baked_basis_out: None },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

fn full_pass_options(tessellation_quality: TessellationQuality) -> StreamingOptions {
    StreamingOptions {
        initial_batch_size: usize::MAX,
        throughput_batch_size: usize::MAX,
        tessellation_quality,
        ..StreamingOptions::default()
    }
}
