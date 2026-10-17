// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`ProcessingSink`]: what a pass tells its caller while it runs.
//!
//! Every event has a no-op default, so a consumer implements the ones it
//! reads. `()` is the sink that listens to nothing.
//!
//! Ordering contract (pinned by `tests/entry_point_trace.rs`):
//! `on_bootstrap` fires at most once, then `on_frame` exactly once, then any
//! number of `on_batch` interleaved with `on_color_update`. `on_frame` fires
//! before the first `on_batch`, also for a file with no jobs. A
//! `on_color_update` replays deferred styles after the first batch, never
//! before it. Events fire once per chunk, never per element.

use crate::mesh_frame::MeshFrame;
use crate::types::mesh::MeshData;
use crate::types::response::QuickMetadataBootstrap;
use std::sync::OnceLock;

/// The frame a pass bakes its vertices in (#5407).
///
/// Delivered once, after frame selection and before the first batch, so a
/// streaming consumer can collate each batch in the baked frame as it arrives.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameEvent {
    /// The frame itself: its tag, the subtracted translation, the removed
    /// site rotation. The returned result's `frame` is this value.
    pub frame: MeshFrame,
    /// [`native_to_baked`](super::native_to_baked) for `frame` and the site
    /// transform: the column-major basis that maps native coordinates to the
    /// baked frame.
    pub baked_basis: [f64; 16],
}

/// Events of one [`process`](super::process) pass. See the module docs.
pub trait ProcessingSink {
    /// The lightweight spatial bootstrap, when `Features::quick_metadata_bootstrap` is on.
    fn on_bootstrap(&mut self, _bootstrap: &QuickMetadataBootstrap) {}
    /// The frame this pass bakes vertices in.
    fn on_frame(&mut self, _frame: &FrameEvent) {}
    /// A chunk of meshes, with the jobs done so far and the job total.
    fn on_batch(&mut self, _meshes: &[MeshData], _processed: usize, _total: usize) {}
    /// Colours resolved after the first batch, when styles were deferred.
    fn on_color_update(&mut self, _updates: &[(u32, [f32; 4])]) {}
}

impl ProcessingSink for () {}

/// The adapter the deprecated entry points use to turn their closure
/// arguments into a sink. Deleted with them in C10.
#[doc(hidden)]
pub struct ClosureSink<'a, B, C, Q> {
    pub on_batch: B,
    pub on_color_update: C,
    pub on_bootstrap: Q,
    /// Receives [`FrameEvent::baked_basis`] when set.
    pub baked_basis_out: Option<&'a OnceLock<[f64; 16]>>,
}

impl<B, C, Q> ProcessingSink for ClosureSink<'_, B, C, Q>
where
    B: FnMut(&[MeshData], usize, usize),
    C: FnMut(&[(u32, [f32; 4])]),
    Q: FnMut(&QuickMetadataBootstrap),
{
    fn on_bootstrap(&mut self, bootstrap: &QuickMetadataBootstrap) {
        (self.on_bootstrap)(bootstrap);
    }

    fn on_frame(&mut self, frame: &FrameEvent) {
        if let Some(out) = self.baked_basis_out {
            // `set` fails only if already set: one pass publishes one frame.
            let _ = out.set(frame.baked_basis);
        }
    }

    fn on_batch(&mut self, meshes: &[MeshData], processed: usize, total: usize) {
        (self.on_batch)(meshes, processed, total);
    }

    fn on_color_update(&mut self, updates: &[(u32, [f32; 4])]) {
        (self.on_color_update)(updates);
    }
}
