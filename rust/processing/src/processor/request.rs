// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`ProcessingRequest`]: everything a caller can ask of one pass.
//!
//! One value type for what used to be spread over eleven entry points: the
//! opening filter, tessellation quality, batching, which optional phases run,
//! the id allow-list, an injected entity index and a cancel flag. A new pass
//! input is a field here, never a new `process_geometry_*` function.

use super::{OpeningFilterMode, StreamingOptions};
use ifc_lite_core::EntityIndex;
use ifc_lite_geometry::TessellationQuality;
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// How the meshing loop chunks its jobs, and in what order.
///
/// Chunking is a delivery property: it decides how often the sink hears
/// `on_batch`, never what the result holds.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Batching {
    /// Jobs in the very first chunk.
    pub initial: usize,
    /// Jobs in every later chunk.
    pub throughput: usize,
    /// Mesh cheap, high-yield element classes first.
    pub fast_first: bool,
}

impl Batching {
    /// `initial` jobs first, then `throughput` per chunk, in file order.
    pub fn new(initial: usize, throughput: usize) -> Self {
        Self { initial, throughput, fast_first: false }
    }

    /// One chunk holding every job.
    pub fn single_chunk() -> Self {
        Self::new(usize::MAX, usize::MAX)
    }

    /// Sort jobs by element-class priority (walls and slabs first) before chunking.
    pub fn fast_first(mut self, fast_first: bool) -> Self {
        self.fast_first = fast_first;
        self
    }
}

/// The optional phases of a pass. All on except the bootstrap, as before.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Features {
    /// Resolve space/zone property sets on the first-frame path.
    pub properties: bool,
    /// Resolve IfcPresentationLayerAssignment on the first-frame path.
    pub presentation_layers: bool,
    /// Emit [`ProcessingSink::on_bootstrap`](super::ProcessingSink::on_bootstrap)
    /// once the scan is done.
    pub quick_metadata_bootstrap: bool,
}

impl Features {
    pub fn properties(mut self, on: bool) -> Self {
        self.properties = on;
        self
    }

    pub fn presentation_layers(mut self, on: bool) -> Self {
        self.presentation_layers = on;
        self
    }

    pub fn quick_metadata_bootstrap(mut self, on: bool) -> Self {
        self.quick_metadata_bootstrap = on;
        self
    }
}

impl Default for Features {
    fn default() -> Self {
        Self { properties: true, presentation_layers: true, quick_metadata_bootstrap: false }
    }
}

/// One pass over one file: the input of [`process`](super::process).
///
/// `ProcessingRequest::default()` is the streaming shape (50-job chunks);
/// [`ProcessingRequest::full_pass`] is the one-chunk shape the non-streaming
/// consumers (server routes, exporters, FFI) use. Both mesh the same elements
/// the same way.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub struct ProcessingRequest {
    /// Which window / door openings are cut and drawn.
    pub opening_filter: OpeningFilterMode,
    /// Tessellation detail (#976). `Medium` is the historical output.
    pub quality: TessellationQuality,
    pub batching: Batching,
    pub features: Features,
    /// Keep the emitted meshes in the returned [`ProcessingResult`](super::ProcessingResult).
    pub retain_meshes: bool,
    /// #1623 "don't-bake" instancing; needs `retain_meshes`.
    pub instancing: bool,
    /// Restrict meshing to these express ids. `None` is the unfiltered pass;
    /// `Some(empty)` is an active filter that meshes nothing. The whole file is
    /// still scanned and resolved, so a selected wall keeps the opening cutters
    /// it needs; only unselected product jobs never reach the meshing loop.
    pub entity_ids: Option<Arc<HashSet<u32>>>,
    /// A prebuilt index of the SAME bytes, instead of building one inline.
    pub entity_index: Option<Arc<EntityIndex>>,
    /// Cooperative cancellation between job chunks. A cancelled pass returns a
    /// PARTIAL result that the caller must not present as complete.
    pub cancel: Option<Arc<AtomicBool>>,
}

impl Default for ProcessingRequest {
    fn default() -> Self {
        Self::from_streaming(OpeningFilterMode::Default, StreamingOptions::default())
    }
}

impl ProcessingRequest {
    /// Every job in one chunk, no events beyond that one.
    pub fn full_pass() -> Self {
        Self::default().batching(Batching::single_chunk())
    }

    pub fn opening_filter(mut self, mode: OpeningFilterMode) -> Self {
        self.opening_filter = mode;
        self
    }

    pub fn quality(mut self, quality: TessellationQuality) -> Self {
        self.quality = quality;
        self
    }

    pub fn batching(mut self, batching: Batching) -> Self {
        self.batching = batching;
        self
    }

    pub fn features(mut self, features: Features) -> Self {
        self.features = features;
        self
    }

    pub fn retain_meshes(mut self, retain: bool) -> Self {
        self.retain_meshes = retain;
        self
    }

    pub fn instancing(mut self, on: bool) -> Self {
        self.instancing = on;
        self
    }

    pub fn ids(mut self, ids: Option<Arc<HashSet<u32>>>) -> Self {
        self.entity_ids = ids;
        self
    }

    pub fn index(mut self, index: Arc<EntityIndex>) -> Self {
        self.entity_index = Some(index);
        self
    }

    pub fn cancel(mut self, cancel: Arc<AtomicBool>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// The request a [`StreamingOptions`] literal stands for. For the
    /// deprecated entry points and the callers that still build the old
    /// struct; C10 deletes it with `StreamingOptions`.
    #[doc(hidden)]
    pub fn from_streaming(opening_filter: OpeningFilterMode, options: StreamingOptions) -> Self {
        Self {
            opening_filter,
            quality: options.tessellation_quality,
            batching: Batching {
                initial: options.initial_batch_size,
                throughput: options.throughput_batch_size,
                fast_first: options.fast_first_batch,
            },
            features: Features {
                properties: options.include_properties,
                presentation_layers: options.include_presentation_layers,
                quick_metadata_bootstrap: options.emit_quick_metadata_bootstrap,
            },
            retain_meshes: options.retain_emitted_meshes,
            instancing: options.enable_instancing,
            entity_ids: None,
            entity_index: options.entity_index,
            cancel: options.cancel,
        }
    }
}
