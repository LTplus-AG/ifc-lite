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
use crate::mesh_check::{Degenerate, EdgeLedger, VertexKey};
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

/// Failure drain, cut vertex canonicalization, malformed recut, flap clip, conditional
/// shard sweep, cut effect — in that order.
pub(super) fn finish(result: Mesh, context: PostContext<'_>) -> Mesh {
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

    let malformed_openings = ctx.malformed_opening_boxes();
    let finish_mesh = |mut result: Mesh| {
        // UNDER-CUT REPAIR: a self-intersecting tessellated cutter (garbage
        // vertices metres from the real opening) makes the kernel UNDER-cut — a
        // wall flap bridges the opening. Re-cut each such opening with a clean
        // box (removes only the opening prism, taking the flap, while preserving
        // and re-triangulating the wall around the hole). Done HERE, in the cut
        // frame (host + cutters share it), and BEFORE the spike clip so any
        // residual protrusion is still caught. A no-op when no cutter is
        // malformed — clean openings are never reshaped.
        recut_malformed_openings(&mut result, &malformed_openings);

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
        result
    };

    // Judge the emitted mesh after repair and clipping. An intermediate
    // rebuild can have over-used edges that those passes remove.
    let result = if let Some(canonical) = crate::facet_weld::canonicalize_cut_vertices(&result, None) {
        let mut candidate = finish_mesh(canonical);
        let exact_edges = |mesh: &Mesh| {
            EdgeLedger::build(mesh, VertexKey::BitsZeroFolded, Degenerate::SkipTriangle)
        };
        let mut rebuilt = exact_edges(&candidate);
        if rebuilt.multiplicity_defects().over_used != 0 {
            // A rebuild can leave a sub-grid triangle on a seam. Use the
            // common void cleanup to repair the seam before deciding.
            super::hygiene::clean_void_output(&mut candidate);
            rebuilt = exact_edges(&candidate);
        }
        if rebuilt.multiplicity_defects().over_used == 0 {
            candidate
        } else {
            let original = finish_mesh(result);
            let valid = original.indices.iter().all(|&i| (i as usize) < original.positions.len() / 3);
            if !valid || rebuilt.overuse_increased_from(&exact_edges(&original)) {
                original
            } else {
                candidate
            }
        }
    } else {
        finish_mesh(result)
    };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::csg::ClippingProcessor;
    use crate::mesh_check::edge_multiplicity_defects;

    #[test]
    fn exact_cut_keeps_edges_that_canonicalization_would_join_10511() {
        let mut cut = Mesh::new();
        for offset in [0.0_f32, 2.0e-5, 4.0e-5] {
            cut.positions.extend_from_slice(&[
                0.0, offset, 0.0, 4.0, offset, 0.0, 0.0, offset, 0.1,
            ]);
        }
        cut.indices.extend(0..9);
        assert_eq!(edge_multiplicity_defects(&cut).over_used, 0);
        let rebuilt = crate::facet_weld::canonicalize_cut_vertices(&cut, None).unwrap();
        assert!(edge_multiplicity_defects(&rebuilt).over_used > 0);

        let execution = Execution::new(Default::default());
        let clipper = ClippingProcessor::new();
        let context = VoidContext {
            openings: vec![],
            merged_openings: vec![],
            param: None,
            bool2d: None,
        };
        let result = finish(cut.clone(), PostContext {
            execution: &execution,
            kernel_failures: execution.capture_failures(&clipper, 1),
            ctx: &context,
            element_id: 1,
            tris_before: 3,
            host_bounds_capture: ((-1.0, -1.0, -1.0), (5.0, 1.0, 1.0)),
            wall_min: Point3::new(-1.0, -1.0, -1.0),
            wall_max: Point3::new(5.0, 1.0, 1.0),
            original_host: &cut,
            host_mutated: false,
        });
        assert_eq!(result.positions, cut.positions);
        assert_eq!(result.indices, cut.indices);
    }
}
