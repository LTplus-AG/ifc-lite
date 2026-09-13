// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one place the symbolic stream converts IFC world coordinates into the
//! frame the viewer draws in.
//!
//! The mesh pipeline stores `world = origin + position + rtc_offset` in IFC
//! Z-up metres (`crate::simplify_session`), so a re-based vertex is the IFC
//! coordinate minus the RTC offset on ALL THREE axes. The viewer reads that
//! Y-up: `renderX = ifcX - rtc.x`, `renderZ = -(ifcY - rtc.y)`,
//! `renderY = ifcZ - rtc.z` (`apps/viewer/src/lib/wall-rects-from-meshes.ts`).
//! Symbolic primitives are overlaid on that scene, so they must be re-based
//! by exactly the same offset. `rust/wasm-bindings/src/api/grid_lines.rs`'s
//! `to_render_frame` is the same conversion written out for the 3D grid
//! overlay, and agrees axis for axis.
//!
//! This type exists because the offset used to travel as two loose `f32`
//! arguments (`rtc_x`, `rtc_z`) through six modules: the plan Y flip was
//! handed the offset's Z (elevation) component instead of its Y, putting the
//! whole overlay a northing away from the meshes, and the elevation was never
//! re-based at all. With the components private and reachable only through
//! [`RenderFrameRebase::plan`] / [`RenderFrameRebase::elevation`], a call
//! site can no longer pick the wrong one.

use crate::mesh_frame::MeshFrame;

/// The model's RTC offset, in IFC Z-up metres, as a coordinate rebase.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct RenderFrameRebase {
    /// IFC X (easting) component.
    x: f32,
    /// IFC Y (northing) component.
    y: f32,
    /// IFC Z (elevation) component.
    z: f32,
}

impl RenderFrameRebase {
    /// The rebase for a mesh frame: subtracts what the frame subtracts, so a
    /// `RawIfc` frame is the identity. The frame owns the threshold decision.
    pub(super) fn from_frame(frame: MeshFrame) -> Self {
        let (x, y, z) = frame.rtc_offset();
        Self { x: x as f32, y: y as f32, z: z as f32 }
    }

    /// IFC plan coordinates → the renderer's 2D pair `(renderX, -renderZ)`,
    /// the handedness the section cutter emits and the viewer's overlay
    /// consumes.
    pub(super) fn plan(self, ifc_x: f32, ifc_y: f32) -> (f32, f32) {
        // The handedness flip negates the northing, and negating a zero
        // northing gives -0.0 rather than 0.0. The two compare equal and draw
        // identically, but they are distinct values to anything that inspects
        // the sign bit - including this overlay's pinned golden digests, which
        // record sign of zero on purpose to catch representation drift across
        // the worker boundary. Emitting -0.0 would spend that signal on an
        // artifact of how the flip is written. Adding 0.0 maps -0.0 to +0.0
        // and is the identity on every other value, IEEE-754 round-to-nearest.
        (ifc_x - self.x, -(ifc_y - self.y) + 0.0)
    }

    /// IFC elevation → the renderer's `world_y`.
    pub(super) fn elevation(self, ifc_z: f32) -> f32 {
        ifc_z - self.z
    }
}

#[cfg(test)]
#[path = "rebase_tests.rs"]
mod rebase_tests;
