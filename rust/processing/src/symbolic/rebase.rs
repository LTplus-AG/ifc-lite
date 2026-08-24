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

/// Large-coordinate threshold (metres). Below it the model is local-coord
/// territory and re-basing would shift the overlay off-screen, so the rebase
/// is the identity — matching `ModelBounds::has_large_coordinates` and the
/// mesh pipeline's own needs-shift decision.
const LARGE_COORD_THRESHOLD: f64 = 10_000.0;

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
    /// Build the rebase for a detected RTC offset (IFC Z-up metres), or the
    /// identity when the model is not large-coordinate.
    pub(super) fn from_rtc_offset(rtc_offset: (f64, f64, f64)) -> Self {
        let needs_rtc = rtc_offset.0.abs() > LARGE_COORD_THRESHOLD
            || rtc_offset.1.abs() > LARGE_COORD_THRESHOLD
            || rtc_offset.2.abs() > LARGE_COORD_THRESHOLD;
        if !needs_rtc {
            return Self::default();
        }
        Self {
            x: rtc_offset.0 as f32,
            y: rtc_offset.1 as f32,
            z: rtc_offset.2 as f32,
        }
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
