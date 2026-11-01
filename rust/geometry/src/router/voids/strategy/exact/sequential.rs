// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The sequential exact cut of one opening (after its batch, if any, missed).

use super::fallback_635::Fallback;
use super::{CutContext, ExactState, Flow};
use crate::router::voids::admission::{
    aabb_engulfs, admit_cutter, cut_retains_triangles, min_opening_volume, ENGULF_TOLERANCE_F32,
};
use crate::router::voids::geom::opening_engulfs_host_solid;
use crate::router::voids::sweep::mesh_to_keep;
use crate::router::voids::CutterKind;
use crate::{GeometryRouter, Mesh};

impl ExactState {
    /// Subtract `opening` exactly. `Stop` when its solid engulfs the host
    /// (the host is consumed and no later opening runs); `Fallback` when the
    /// kernel failed on an opening that reaches the host.
    pub(super) fn cut_one<'a>(&mut self, result: &mut Mesh, opening: &'a CutterKind, context: CutContext<'_>) -> Flow<'a> {
        let CutContext { execution, clipper, .. } = context;
        // Normalize both exact-subtract variants into the same (mesh, min,
        // max, dir) shape. `DiagonalRectangular` (a clean but tilted box —
        // e.g. a roof-slope window or a slanted roof opening, #1007 defect B)
        // is a REAL solid cutter, so it MUST be subtracted exactly, never
        // approximated by a frame-rotated AABB: that legacy path
        // (`apply_diagonal_openings`) tore the host (101 boundary edges) and
        // left the void uncut. Route it through the same exact-mesh subtract
        // as `NonRectangular`; the kernel cuts the tilted box cleanly
        // (winding-robust after the defect-A orient-outward fix). The
        // mesh-bounds AABB + frame-depth direction still seed the #635
        // fallback, which only fires if the exact subtract no-ops.
        let normalized = opening.cutter().normalized();
        if let Some((opening_mesh, open_min_pt, open_max_pt, extrusion_dir)) = normalized {
            let open_min_pt = &open_min_pt;
            let open_max_pt = &open_max_pt;
            {
                // The 0.1 L volume floor filtered legacy-BSP CSG artefacts but
                // also drops genuine small openings — bolt holes / sleeves in
                // thin plates. At the two highest quality levels keep those
                // holes (the exact kernel is stable on small cutters); only
                // reject numerically degenerate cutters there. (issue #976)
                // This path compares in f32, the precision of the bounds.
                let (result_min, result_max) = result.bounds();
                let min_open_vol = min_opening_volume(execution.tessellation_quality) as f32;
                let Some((open_min_f32, open_max_f32)) =
                    admit_cutter(opening_mesh, (result_min, result_max), min_open_vol)
                else {
                    return Flow::Next;
                };

                // ENGULFING-SOLID VOID: when this opening's real solid
                // CONTAINS the whole host, the exact subtract no-ops on the
                // coincident shared faces and returns the host unchanged in
                // volume (a spurious solid where the opening should be). A
                // cheap AABB-engulf pre-check (false for an ordinary opening,
                // which spans the host on at most its thickness axis) gates
                // the O(host_v · opening_t) containment scan, which confirms
                // TRUE solid containment — so a void whose AABB engulfs the
                // host while its real profile excludes it is not affected.
                // On a hit the host is fully consumed.
                let host_aabb_engulfed = aabb_engulfs(
                    [open_min_f32.x, open_min_f32.y, open_min_f32.z],
                    [open_max_f32.x, open_max_f32.y, open_max_f32.z],
                    [result_min.x, result_min.y, result_min.z],
                    [result_max.x, result_max.y, result_max.z],
                    ENGULF_TOLERANCE_F32,
                );
                if host_aabb_engulfed && opening_engulfs_host_solid(result, opening_mesh) {
                    // The empty result marks the host consumed
                    // (`program::openings::execute`).
                    *result = Mesh::default();
                    self.host_mutated = true;
                    return Flow::Stop;
                }

                let tri_before = result.triangle_count();
                let failures_before = clipper.failure_count();
                let mut csg_succeeded = false;
                // PENETRATING CUTTER (PART A): push the opening's caps a hair
                // PAST the host along its depth axis so a flush cap becomes a
                // clean transversal crossing — the exact kernel then cuts the
                // tilted, faceted roof opening with no bridging sliver (#1007
                // host #1112). Falls back to the raw opening mesh when no depth
                // direction is known (the kernel handles a true through-cutter
                // anyway; the extension only matters for the flush-cap case).
                let extended_opening = GeometryRouter::sequential_cutter(
                    opening_mesh, extrusion_dir, result,
                );
                let cutter = &extended_opening;
                let outcome = clipper.subtract_mesh(result, cutter);
                // Nothing to cut, so the #635 fallback below must not cut a
                // box either (#5362).
                let kernel_found_no_overlap = outcome.found_no_overlap();
                let kept = mesh_to_keep(outcome, result);
                // The host is still un-cut: the kernel found no real
                // intersection, or bailed on a grazing/coplanar cutter.
                let csg_unchanged = kept.is_none();
                if let Some(csg_result) = kept {
                    if cut_retains_triangles(tri_before, &csg_result) {
                        *result = csg_result;
                        self.host_mutated = true;
                        csg_succeeded = true;
                    }
                }

                // AABB fallback (issue #635): when CSG can't subtract the
                // opening (most commonly because its triangulated profile
                // exceeds `MAX_CSG_POLYGONS_PER_MESH`, i.e. circular /
                // arched / arbitrary curved openings), cut the opening's
                // axis-aligned bounding box instead. This leaves a square
                // hole in place of a round one, but a square hole is
                // dramatically less wrong than a missing void on a wall
                // that is supposed to host a window or door.
                // A re-tessellation this router refused on its own
                // retention check is not a verdict: fall back as before.
                let kernel_verdict_disjoint = kernel_found_no_overlap && csg_unchanged;
                if !csg_succeeded && !kernel_verdict_disjoint {
                    return Flow::Fallback(Fallback {
                        opening_mesh,
                        open_min_pt: *open_min_pt,
                        open_max_pt: *open_max_pt,
                        extrusion_dir,
                        tri_before,
                        failures_before,
                        csg_unchanged,
                    });
                }
            }
        }
        Flow::Next
    }
}
