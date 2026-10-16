// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one place the symbolic stream converts IFC world coordinates into the
//! frame the viewer draws in.
//!
//! The mesh pipeline stores `world = origin + position + rtc_offset` in IFC
//! Z-up metres (`crate::simplify_session`), so a re-based vertex is the IFC
//! coordinate minus the RTC offset on ALL THREE axes — and, in the site-local
//! tier, turned by the site placement's inverse rotation as well
//! (`processor::site_local`, #4706). Both halves come off the one
//! [`MeshFrame`] the caller's meshes were baked in. The viewer reads that
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
//!
//! It is also where the stream turns f32 (#7684 PROCESSING-SYM-4). Everything
//! upstream (placements, coordinates, the offset itself) is f64, the
//! subtraction happens in f64, and only the small re-based result is cast.
//! The pipeline used to cast at read time and subtract an f32 offset from an
//! f32 world coordinate: at 5,000 km the f32 step is 0.5 m, so a symbol could
//! land half a metre off the mesh it annotates. The mesh side has subtracted
//! in f64 all along (`mapped_operator_precision.rs`).

use crate::mesh_frame::MeshFrame;

/// The model's mesh frame, in IFC Z-up metres, as a coordinate rebase.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct RenderFrameRebase {
    /// IFC X (easting) component of the translation.
    x: f64,
    /// IFC Y (northing) component of the translation.
    y: f64,
    /// IFC Z (elevation) component of the translation.
    z: f64,
    /// The plan block of the frame's inverse rotation, as the frame's images
    /// of the world X and Y axes: `[x_axis.x, x_axis.y, y_axis.x, y_axis.y]`.
    /// The identity for every frame that removes no rotation.
    axes: [f64; 4],
}

impl Default for RenderFrameRebase {
    /// The identity, spelled as the frame that is one.
    fn default() -> Self {
        Self::from_frame(MeshFrame::RawIfc)
    }
}

impl RenderFrameRebase {
    /// The rebase for a mesh frame: subtracts what the frame subtracts AND
    /// removes what it rotates away, so a `RawIfc` frame is the identity. The
    /// frame owns both decisions.
    ///
    /// The rotation arrives as the frame's images of the world X and Y axes
    /// rather than as a matrix, so this cannot transpose it by hand. Their
    /// elevation components are dropped, which is exact for a rotation about
    /// Z, the only kind a plan view can express and the only kind an IfcSite
    /// placement carries in the fixtures and files this has run on. A site
    /// placement that tilts OUT of the plan moves elevation into the plan pair
    /// and back, and the 2D stream has no per-point elevation to carry that:
    /// its symbols would stay upright while the meshes tilt. Not handled here,
    /// and not hidden either — `MeshFrame::rotate_into_frame` is the full 3x3
    /// for a consumer that can use all of it.
    pub(super) fn from_frame(frame: MeshFrame) -> Self {
        let (x, y, z) = frame.rtc_offset();
        let x_axis = frame.rotate_into_frame([1.0, 0.0, 0.0]);
        let y_axis = frame.rotate_into_frame([0.0, 1.0, 0.0]);
        Self { x, y, z, axes: [x_axis[0], x_axis[1], y_axis[0], y_axis[1]] }
    }

    /// An IFC plan DIRECTION in the renderer's 2D pair. The frame's rotation
    /// applies; its translation does not, because a direction has no position.
    ///
    /// Text baselines are the consumer (`text.rs`). The handedness flip lives
    /// here too, so a caller cannot negate the northing of a point and forget
    /// to negate the direction beside it.
    pub(super) fn plan_direction(self, ifc_dx: f64, ifc_dy: f64) -> (f32, f32) {
        let (x, y) = self.rotate_plan(ifc_dx, ifc_dy);
        (x as f32, -(y as f32) + 0.0)
    }

    /// The inverse rotation restricted to the plan: an IFC plan pair in the
    /// frame's own axes, before the handedness flip.
    #[inline]
    fn rotate_plan(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.axes[0] * x + self.axes[2] * y,
            self.axes[1] * x + self.axes[3] * y,
        )
    }

    /// IFC plan coordinates → the renderer's 2D pair `(renderX, -renderZ)`,
    /// the handedness the section cutter emits and the viewer's overlay
    /// consumes.
    pub(super) fn plan(self, ifc_x: f64, ifc_y: f64) -> (f32, f32) {
        // The handedness flip negates the northing, and negating a zero
        // northing gives -0.0 rather than 0.0. The two compare equal and draw
        // identically, but they are distinct values to anything that inspects
        // the sign bit - including this overlay's pinned golden digests, which
        // record sign of zero on purpose to catch representation drift across
        // the worker boundary. Emitting -0.0 would spend that signal on an
        // artifact of how the flip is written. Adding 0.0 maps -0.0 to +0.0
        // and is the identity on every other value, IEEE-754 round-to-nearest.
        // Subtract and rotate in f64; cast only the small result (#7684). A
        // value past f32's range casts to infinity, which every caller's
        // finiteness gate (`push_finite_point` and its siblings) then drops.
        let (x, y) = self.rotate_plan(ifc_x - self.x, ifc_y - self.y);
        (x as f32, -(y as f32) + 0.0)
    }

    /// IFC elevation → the renderer's `world_y`.
    ///
    /// The frame's rotation does not enter: the plan rotation this carries
    /// fixes the Z axis (see [`RenderFrameRebase::from_frame`]), so an
    /// elevation is only ever offset.
    pub(super) fn elevation(self, ifc_z: f64) -> f32 {
        (ifc_z - self.z) as f32
    }
}

#[cfg(test)]
#[path = "rebase_tests.rs"]
mod rebase_tests;
