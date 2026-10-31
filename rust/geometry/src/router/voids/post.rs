// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The exact tail's post passes (stage D), run on the exact cut in the cut
//! frame. Their order is the statement order of [`finish`] and is part of the
//! geometry and diagnostics contract: the recut and the flap clip, for one,
//! do not commute on an open host.

use super::malformed_opening_repair::recut_malformed_openings;
use super::sweep::drop_faces_outside_host;
use super::VoidContext;
use crate::program::openings::execute::{Execution, FailureCapture};
use crate::{Mesh, Point3};

/// What the post passes read from the frame-local cut.
pub(super) struct PostContext<'a> {
    pub(super) execution: &'a Execution,
    /// Drained first, so the failures reach the execution before any repair.
    pub(super) kernel_failures: FailureCapture<'a>,
    pub(super) ctx: &'a VoidContext,
    pub(super) element_id: u32,
    pub(super) tris_before: usize,
    pub(super) host_bounds_capture: ((f32, f32, f32), (f32, f32, f32)),
    /// The host's pre-cut bounds in the cut frame (the flap clip's box).
    pub(super) wall_min: Point3<f64>,
    pub(super) wall_max: Point3<f64>,
    /// The un-welded host, the stray-shard sweep's parity reference.
    pub(super) original_host: &'a Mesh,
    /// Whether any exact pass changed the host; gates the shard sweep.
    pub(super) host_mutated: bool,
}

/// Failure drain, sliver refinement, malformed recut, flap clip, conditional
/// shard sweep, cut effect — in that order.
pub(super) fn finish(mut result: Mesh, context: PostContext<'_>) -> Mesh {
    let PostContext {
        execution,
        kernel_failures,
        ctx,
        element_id,
        tris_before,
        host_bounds_capture,
        wall_min,
        wall_max,
        original_host,
        host_mutated,
    } = context;
    // Drain whatever fallbacks the kernel logged during this element's
    // void / clip pass, attributed to the host product, so the caller can
    // surface them (e.g. flagged in a viewer overlay or asserted in
    // regression tests) once the outcome is published.
    drop(kernel_failures);

    // WATERTIGHT SLIVER REFINEMENT (issue #1007): the exact-kernel cut of a
    // long, tilted faceted-BREP host facet can emit a high-aspect corner
    // sliver (a far-corner triangle fanned to two new rim vertices a few cm
    // apart) that lands ALONE in its plane bucket and so bypasses the
    // coplanar CDT. Bisect any >8:1 triangle's longest edge at its midpoint,
    // splitting BOTH incident triangles in lockstep so the mesh stays
    // watertight (no T-junction) and the midpoint lies ON the original edge
    // ⇒ cut volume is preserved exactly. A no-op on clean cuts (no triangle
    // exceeds 8:1), so it does not perturb the frozen corpus. Only runs when
    // a cut was actually attempted (`!ctx.is_noop()` guarantees this path).
    // This canonicalizer is likewise not a hygiene boundary: fresh sub-grid
    // candidates require handling by the remaining repair/clip/sweep path,
    // independently of the router's earlier source cleanup (#4797).
    result = crate::facet_weld::refine_high_aspect_slivers(&result);

    // UNDER-CUT REPAIR: a self-intersecting tessellated cutter (garbage
    // vertices metres from the real opening) makes the kernel UNDER-cut — a
    // wall flap bridges the opening. Re-cut each such opening with a clean
    // box (removes only the opening prism, taking the flap, while preserving
    // and re-triangulating the wall around the hole). Done HERE, in the cut
    // frame (host + cutters share it), and BEFORE the spike clip so any
    // residual protrusion is still caught. A no-op when no cutter is
    // malformed — clean openings are never reshaped.
    recut_malformed_openings(&mut result, &ctx.malformed_opening_boxes());

    // SPURIOUS-FLAP CLIP: a subtract can only remove material, so the cut is
    // mathematically contained in the host's pre-cut AABB (`wall_min/max`);
    // any triangle poking past it is provably an artifact — a malformed
    // cutter's far-flung leaked flap (self-intersecting / tessellated void,
    // surfacing once a SECOND cutter perturbs the arrangement), OR the
    // flush-cap through-extension reveal overhang (`extend_opening_mesh_
    // through_host` pushes a flush cap ~0.3·depth past the host for a clean
    // transversal cut, so the subtract emits the reveal out to it — 0.105 m
    // past a 0.35 m floor slab, #1633). `clip_triangles_to_host_aabb` bounds
    // its jitter tolerance so a large host cannot leak the overhang. A no-op
    // on clean cuts.
    result.clip_triangles_to_host_aabb(
        [wall_min.x as f32, wall_min.y as f32, wall_min.z as f32],
        [wall_max.x as f32, wall_max.y as f32, wall_max.z as f32],
    );

    // STRAY-SHARD SWEEP: see `sweep::drop_faces_outside_host` (#1788).
    if host_mutated {
        result = drop_faces_outside_host(result, original_host);
    }

    // Per-host cut-effect snapshot: tris_before / tris_after lets the
    // diagnostic surface the silent-no-op case (rectangular boxes
    // processed but the host mesh came out unchanged — the box
    // probably didn't intersect the wall, e.g. wrong placement).
    execution.record_host_cut_effect(
        element_id,
        tris_before,
        result.triangle_count(),
        ctx.rect_opening_count(),
        host_bounds_capture,
    );

    result
}
