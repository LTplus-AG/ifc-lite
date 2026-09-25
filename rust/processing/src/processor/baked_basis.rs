// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A streaming entry point that also reports the frame its batches are baked
//! in, before the first batch (#5407).
//!
//! Its own function rather than a field on [`StreamingOptions`]: that struct
//! is public with public fields, so a new field would break every caller that
//! builds it with a struct literal. This is additive instead. It is the same
//! pipeline, with one more argument into the shared core that
//! [`super::process_geometry_streaming_filtered_with_options`] calls with `None`.

use super::{
    process_geometry_streaming_filtered_with_options_and_ids, OpeningFilterMode,
    ProcessingResult, StreamingOptions,
};
use crate::types::mesh::MeshData;
use crate::types::response::QuickMetadataBootstrap;
use std::collections::HashSet;
use std::sync::OnceLock;

/// The pass inputs the public entry points take as arguments rather than
/// through [`StreamingOptions`], whose fields are public API: the id allow-list
/// (`id_filter`) and the basis slot above. One struct, so the shared core stays
/// within clippy's argument limit.
#[derive(Clone, Copy, Default)]
pub(super) struct PassScope<'a> {
    pub(super) entity_ids: Option<&'a HashSet<u32>>,
    pub(super) baked_basis_out: Option<&'a OnceLock<[f64; 16]>>,
}

/// [`super::process_geometry_streaming_filtered_with_options`], plus:
/// `baked_basis_out` receives [`super::native_to_baked`] for the frame this
/// pass bakes vertices in. It is set once, after frame selection and BEFORE
/// the first batch is emitted, so a streaming consumer can collate each batch
/// in the baked frame as it arrives. It equals `native_to_baked` of the
/// returned result's `mesh_coordinate_space`, `site_transform` and
/// `metadata.coordinate_info.origin_shift`.
pub fn process_geometry_streaming_filtered_with_baked_basis(
    content: &[u8],
    opening_filter: OpeningFilterMode,
    options: StreamingOptions,
    baked_basis_out: &OnceLock<[f64; 16]>,
    on_batch: impl FnMut(&[MeshData], usize, usize),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options_and_ids(
        content,
        opening_filter,
        options,
        PassScope { entity_ids: None, baked_basis_out: Some(baked_basis_out) },
        on_batch,
        on_color_update,
        on_quick_metadata_bootstrap,
    )
}
