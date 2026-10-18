// SPDX-License-Identifier: MPL-2.0
//! Finalize an admitted analytic opening candidate in the original host frame.
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_candidate(
    tris: &[PTri], mesh: &Mesh, ctx: &VoidContext, mut residual_idx: Vec<usize>,
    committed_ops: usize, committed_cutter_volume: f64,
    refine_boxes: Vec<([f64; 3], [f64; 3])>,
) -> Option<(Mesh, Option<VoidContext>)> {
    crate::resource::check_current().ok()?;
    let mut out = mesh_from_ptris(tris, mesh);
    // COPLANAR CONSOLIDATION: the conforming per-triangle CDT deliberately
    // over-fragments faces (every decomposed host triangle keeps its own
    // sub-triangulation, and caps carry their constraint scaffolding). Run
    // the SAME coplanar merge the exact kernel and the rect/param fast
    // paths apply (i_overlay union per plane bucket + CDT re-triangulation,
    // watertight-preserving), collapsing each planar face back to a few
    // large triangles — 2-3x fewer output triangles on the advanced_model
    // walls, matching the exact kernel's tessellation density.
    out = crate::csg::ClippingProcessor::consolidate_coplanar(out);
    crate::resource::check_current().ok()?;
    let consolidated_closure = ClosureVerdict::for_mesh(&out);
    if consolidated_closure.closed_enough_to_emit()
        && !consolidated_change_is_measurable(mesh, &out)
    {
        defer(4);
        return None;
    }
    // WATERTIGHT SLIVER REFINEMENT (#1007): the per-triangle CDT can emit a
    // high-aspect corner sliver at an opening rim (a far-corner triangle
    // fanned to two rim vertices) — the visible roof-slope chamfer the
    // exact path also produces and repairs. Run the SAME lockstep-bisection
    // pass the exact kernel output gets (targets aspect <= 8:1, watertight
    // by construction), so the analytic cut meets the same rim-quality bar.
    // The pass fixes one edge per internal round (64 max); the analytic
    // cut can carry more rim fans than that, so drive it to a (bounded)
    // fixpoint — each iteration is a no-op clone once no sliver remains.
    // SELF-CHECKED application, and ONLY when this cut is FINAL (no
    // residual): with a residual, the exact kernel still cuts this mesh and
    // runs its own sliver refinement on ITS output — refining first would
    // hand the arrangement midpoint-split geometry it re-fragments (#1167).
    // On a hairline-tolerated output the lockstep split can also see just
    // one side of an overlapping chain pair and amplify the sub-grid
    // mismatch, and the split slivers can fall below the clean-degenerate
    // grid — so accept the refined mesh only when it is STRICTLY closed
    // and a cleaned probe stays at least hairline-closed.
    if residual_idx.is_empty() && consolidated_closure.is_directed_closed() {
        // SCOPED to the committed cutters' padded AABBs: #1007's target is
        // the high-aspect corner sliver the CUT emits at an opening rim, and
        // every rim-incident sliver touches its cutter's box. The unscoped
        // pass also bisected the host's own authored long-thin faces (a thin
        // steel wall is legitimately full of >8:1 quads), inflating output
        // triangles and paying the full lockstep fixpoint on every
        // analytic-cut host (the Holter 4.1.x regression).
        //
        // Refine straight off `out` first: the scoped pass returns the input
        // unchanged when no in-region sliver fires (the common clean-cut
        // case), and for a NO-OP fixpoint `refined == out` byte-for-byte, so
        // the upfront clone, the probe clean, and the closure audits decided
        // nothing. Only a fixpoint that actually split an edge pays the
        // probe + self-check audits. Same 6-refine budget as before
        // (1 here + up to 5 below). This refinement is not a replacement
        // for the router's source-triangle cleanup and does not promise
        // hygienic output. The probe informs acceptance; `finish_cut`
        // closure-audits and prefers a clean result, but may return its
        // explicit compatibility result (#4797).
        let mut refined =
            crate::facet_weld::refine_high_aspect_slivers_within(&out, &refine_boxes);
        crate::resource::check_current().ok()?;
        if refined.indices.len() != out.indices.len() {
            for _ in 0..5 {
                let next =
                    crate::facet_weld::refine_high_aspect_slivers_within(&refined, &refine_boxes);
                crate::resource::check_current().ok()?;
                if next.indices.len() == refined.indices.len() {
                    break;
                }
                refined = next;
            }
            let mut probe = refined.clone();
            probe.clean_degenerate();
            if directed_closed(&refined) && closed_enough_to_emit(&probe) {
                out = refined;
            }
        }
    }
    // The finalizer cleans before the ulp weld so discarded slivers cannot
    // choose a surviving seam coordinate, then audits the exact mesh it
    // returns. A closed pre-clean result remains the compatibility fallback.
    let finished = finish_cut_verdict(out, mesh);
    crate::resource::check_current().ok()?;
    let Some((finished, directed)) = finished else {
        defer(9);
        return None;
    };
    out = finished;
    // A host stored relative to a per-element origin can keep hairline
    // seams its world-frame twin does not (#5739): its weld is sized by the
    // small stored coordinates. Close them when that leaves the cut
    // strictly closed, else keep it. World-frame cuts are untouched.
    if mesh.origin != [0.0; 3] && !directed {
        let closed = tjunction_close::close_seams(&out, mesh);
        crate::resource::check_current().ok()?;
        if let Some(closed) = closed {
            out = closed;
        }
    }

    // Residual openings in their original classification order.
    residual_idx.sort_unstable();
    let residual: Vec<OpeningType> = residual_idx
        .iter()
        .map(|&i| ctx.merged_openings[i].clone())
        .collect();

    if !result_volume_within_bounds(mesh, &out, committed_cutter_volume) {
        defer(8);
        return None;
    }
    crate::resource::check_current().ok()?;
    record_cut(committed_ops, residual.len());

    let residual_ctx = if residual.is_empty() {
        None
    } else {
        Some(VoidContext {
            openings: residual.clone(),
            merged_openings: residual,
            param: None,
            bool2d: None,
        })
    };
    Some((out, residual_ctx))
}
