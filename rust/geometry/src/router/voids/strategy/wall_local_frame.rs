// SPDX-License-Identifier: MPL-2.0
use super::{Execution, Mesh, VoidContext};
use super::super::{GeometryRouter, CutterKind, Point3, Vector3, WALL_NORMAL_DEPTH_COS, frame_snap};
use super::super::geom::{
    mesh_to_frame, project_aabb_in_frame, is_axis_aligned_direction,
    rotate_mesh_from_frame, wall_frame_from_depth,
};
use super::super::local_frame::{host_thickness_wall_frame, vertical_depth_wall_frame};
use nalgebra::Matrix3;

impl Execution {
    /// Cut a plan-rotated wall's openings in the wall's own axis-aligned,
    /// origin-centred frame (issue #1167). Returns `None` (caller uses the
    /// world path) unless the wall is rotated in plan and every opening carries
    /// a cutter mesh. The wall normal comes from an opening's non-axis-aligned,
    /// ~horizontal depth axis; else from vertical strips' frames (#3977); else,
    /// when no opening authors a depth at all, from the host's own thickness
    /// axis (#5410).
    ///
    /// In the wall frame the host and its openings are axis-aligned and near the
    /// origin, so the exact subtract runs in the clean, f32-precise regime a
    /// straight wall enjoys — clean-box openings even reclassify to the
    /// watertight `rect_fast` path. Curved / brep openings keep their mesh and
    /// are subtracted there too. The result is rotated back; the orthonormal,
    /// origin-centred round-trip is identity for untouched geometry. Recurses
    /// into [`Self::cut_in_frame`] with `allow_local_frame: false` (#3641).
    pub(super) fn cut_in_wall_frame(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
        element_id: u32,
        host_world_bounds: ((f32, f32, f32), (f32, f32, f32)),
    ) -> Option<Mesh> {
        let axes = self.wall_frame_axes(mesh, ctx)?;
        let (mn, mx) = mesh.bounds();
        let center = Vector3::new(
            ((mn.x + mx.x) * 0.5) as f64,
            ((mn.y + mx.y) * 0.5) as f64,
            ((mn.z + mx.z) * 0.5) as f64,
        );
        let host_local = mesh_to_frame(mesh, &axes, center);

        let z = Vector3::new(0.0, 0.0, 1.0);
        let mut local_openings: Vec<CutterKind> = Vec::with_capacity(ctx.merged_openings.len());
        for op in &ctx.merged_openings {
            let cutter = match op {
                CutterKind::DiagonalRectangular(m, _) => m,
                CutterKind::NonRectangular(m, _, _, _) => m,
                CutterKind::Rectangular(..) => return None,
            };
            let (lmn, lmx) = project_aabb_in_frame(cutter, &axes, center)?;
            let in_frame =
                |v: Vector3<f64>| Vector3::new(v.dot(&axes[0]), v.dot(&axes[1]), v.dot(&axes[2]));
            // The cutter's own penetration (depth) axis expressed in the wall
            // frame. Drives both the alignment test and — for the exact fallback
            // — the cap-extension direction, which MUST stay faithful to THIS
            // cutter: hardcoding the wall normal would push a misaligned
            // opening's flush/short cap along the wrong axis and carve the wrong
            // prism (#1270 review).
            let frame_depth = match op {
                CutterKind::DiagonalRectangular(_, f) => Some(in_frame(f.depth)),
                CutterKind::NonRectangular(_, _, _, d) => d.map(in_frame),
                CutterKind::Rectangular(..) => None,
            };
            // Whether THIS opening's own oriented box is axis-aligned in the
            // wall frame. The frame is seeded from the FIRST rotated opening
            // (#1167); a second opening tilted differently *in plane* is NOT
            // axis-aligned here, so projecting its frame AABB would over-cut it
            // (#1259 review). Only a clean box whose full frame aligns with the
            // wall frame may take the fast rectangular cut; everything else —
            // brep/curved voids and frame-misaligned boxes alike — keeps its
            // exact (un-rotated, centred) mesh for the subtract.
            let frame_aligned = match op {
                CutterKind::DiagonalRectangular(_, f) => {
                    is_axis_aligned_direction(&in_frame(f.depth))
                        && is_axis_aligned_direction(&in_frame(f.cross_a))
                        && is_axis_aligned_direction(&in_frame(f.cross_b))
                }
                _ => false,
            };
            if frame_aligned {
                // Preserve THIS cutter's authored penetration axis. The new
                // #3977 selector also admits vertically extruded strips, whose
                // local depth is +Y rather than the wall normal (+Z). Extending
                // those along +Z would turn a partial-thickness vertical slot
                // into a full-through cut. An inferred box axis carries no such
                // intent and must retain the established wall-normal fallback.
                // A cutter authored along the wall normal itself keeps +Z too:
                // handing the rectangular cut an antiparallel (-Z) depth flips
                // its cap extension and tears the host (rvt01 #10191 census).
                let rect_depth = match op {
                    CutterKind::DiagonalRectangular(_, frame)
                        if frame.depth_is_authored
                            && frame_depth.is_some_and(|d| d.z.abs() < WALL_NORMAL_DEPTH_COS) =>
                    {
                        frame_depth
                    }
                    _ => Some(z),
                };
                local_openings.push(CutterKind::Rectangular(lmn, lmx, rect_depth));
            } else {
                let mesh_local = mesh_to_frame(cutter, &axes, center);
                // Keep this cutter's true depth in the frame; fall back to the
                // wall normal (+Z) only when the opening carried no direction.
                let dir = frame_depth.unwrap_or(z);
                local_openings.push(CutterKind::NonRectangular(mesh_local, lmn, lmx, Some(dir)));
            }
        }
        let local_ctx = VoidContext {
            merged_openings: GeometryRouter::merge_rectangular_openings(&local_openings),
            openings: local_openings,
            // The local-frame recursion never re-captures the parametric cut
            // (issue #1209): it operates on already-classified openings, so the
            // analytic `param` / 2D paths are irrelevant here — defer to the exact
            // path.
            param: None,
            bool2d: None,
        };

        // Forward the WORLD host bounds captured before this rotation so the
        // diagnostic reports world coords, not wall-frame (rotated/centred) ones.
        let diag_before = self.mark();
        // Whether the host reached us stored relative to a per-element origin
        // (the wasm default): `apply_void_context` then cleared that origin, so
        // the world bounds it passed differ from the stored ones. A world-frame
        // host has identical bounds and keeps its established closure test.
        let (smn, smx) = mesh.bounds();
        let frame_relative =
            host_world_bounds != ((smn.x, smn.y, smn.z), (smx.x, smx.y, smx.z));
        let frame = Matrix3::from_columns(&axes);
        let center_point = Point3::from(center);
        let result_local = self
            .cut_in_frame(host_local, &local_ctx, element_id, host_world_bounds, false);
        // Rotation-only positions retain the far centre in `Mesh::origin`.
        let mut result = rotate_mesh_from_frame(&result_local, &frame, &center_point);
        // #5635: the operands arrive as f32 WORLD positions, so in the frame one
        // authored face can land on dozens of depth values micrometres apart and
        // the cut keeps T-junction seams along them. Only when the cut came back
        // open (and not empty), cut again on operands whose coincident planes are
        // snapped back onto one value. Keep the retry only if it is strictly
        // closed and removed the same material as the first cut to within 0.1%
        // (a retry whose cut silently failed returns the whole host). A cut that
        // is already closed is never touched, so it stays byte-identical. The
        // host itself need not be closed: an extruded voided profile carries
        // T-junctions of its own that the cut consolidates away.
        //
        // For a frame-relative host the closure is judged on the cut as it will
        // be emitted: rotated back and after the degenerate-triangle hygiene.
        // Stored that way, a cut can be closed on the frame's grid only through
        // µm slivers that hygiene then drops (#5739). The world frame's test is
        // unchanged, so its output is too.
        let closed = if frame_relative {
            frame_snap::closed_as_emitted(&result)
        } else {
            frame_snap::closed_and_consistently_wound(&result_local)
        };
        if !result_local.positions.is_empty() && !closed {
            let first_volume = frame_snap::enclosed_volume(&result_local);
            // Only the kept run may leave a diagnostics record.
            let diag_first = self.split_off(diag_before);
            // Rebuilt rather than kept from above: the clean path pays nothing.
            let mut host_snapped = mesh_to_frame(mesh, &axes, center);
            let mut openings_snapped = local_ctx.openings.clone();
            // The WORLD magnitude (a local-frame host's origin folded in), so
            // the tolerance does not depend on the vertex frame (#5739). For a
            // world-frame host these are its own bounds, as before.
            let ((wx0, wy0, wz0), (wx1, wy1, wz1)) = host_world_bounds;
            let world_magnitude = [wx0, wy0, wz0, wx1, wy1, wz1]
                .iter()
                .fold(0.0_f64, |m, v| m.max((*v as f64).abs()));
            frame_snap::snap_to_frame_planes(
                &mut host_snapped,
                &mut openings_snapped,
                frame_snap::frame_snap_tolerance(world_magnitude),
            );
            let snapped_ctx = VoidContext {
                merged_openings: GeometryRouter::merge_rectangular_openings(&openings_snapped),
                openings: openings_snapped,
                param: None,
                bool2d: None,
            };
            let retry = self.cut_in_frame(
                host_snapped,
                &snapped_ctx,
                element_id,
                host_world_bounds,
                false,
            );
            let retry_volume = frame_snap::enclosed_volume(&retry);
            let same_cut = (retry_volume - first_volume).abs()
                <= 1.0e-3 * first_volume.abs().max(retry_volume.abs());
            let accepted = if !same_cut {
                None
            } else if frame_relative {
                let emitted = rotate_mesh_from_frame(&retry, &frame, &center_point);
                frame_snap::closed_as_emitted(&emitted).then_some(emitted)
            } else {
                frame_snap::closed_and_consistently_wound(&retry)
                    .then(|| rotate_mesh_from_frame(&retry, &frame, &center_point))
            };
            if let Some(emitted) = accepted {
                result = emitted;
            } else {
                self.restore(diag_before, diag_first);
            }
        }
        Some(result)
    }

    /// The #1167 wall frame `[run, height, normal]` for a plan-rotated wall
    /// whose openings can all be expressed in it, else `None` (the host keeps
    /// the world path). Translation-invariant, so it gives the same answer for a
    /// world-stored host and a local-frame one (#5739).
    fn wall_frame_axes(&self, mesh: &Mesh, ctx: &VoidContext) -> Option<[Vector3<f64>; 3]> {
        if ctx.merged_openings.is_empty() {
            return None;
        }
        let depth_of = |op: &CutterKind| op.cutter().depth();
        // Define the wall frame from the first opening whose depth is a
        // genuinely rotated, ~horizontal axis. Axis-aligned walls find none and
        // keep their (unchanged) world path.
        let horizontal_axes = ctx
            .merged_openings
            .iter()
            .filter_map(depth_of)
            .find(|d| !is_axis_aligned_direction(d) && d.z.abs() <= 0.2)
            .and_then(wall_frame_from_depth);
        let axes = match horizontal_axes {
            Some(axes) => axes,
            None => vertical_depth_wall_frame(mesh, &ctx.merged_openings)
                .or_else(|| host_thickness_wall_frame(mesh, &ctx.merged_openings))?,
        };

        // AABB-only `Rectangular` openings can't be rotated into the frame; a
        // plan-rotated wall never has them (they'd be diagonal), so bail.
        if ctx.merged_openings.iter().any(|op| matches!(op, CutterKind::Rectangular(..))) {
            return None;
        }
        Some(axes)
    }

}
