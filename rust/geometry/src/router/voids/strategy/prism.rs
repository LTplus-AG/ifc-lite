// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Prism (stage A, third): each opening whose cutter is a genuine
//! stepped-extrusion prism is subtracted from the host MESH analytically.

use super::super::{prism_cut, world_host_bounds};
use super::{Cut, VoidContext};
use crate::program::openings::execute::Execution;
use crate::Mesh;

/// Flag-gated. Plain boxes AND rebated masonry windows; host-shape-agnostic,
/// so it fires on the faceted-BREP / clipped / multi-item hosts the parametric
/// and 2D stages cannot serve. Tried after them so their proven outputs stay
/// byte-identical; ORIGIN-AWARE (the cut runs in the host's own local frame,
/// cutters relativized in f64, `origin` re-stamped). Ineligible openings come
/// back as a residual context, cut by the caller's recursion on the analytic
/// result — the same composition contract as the 2D path (which also routes
/// ITS residual through this path on recursion, so a 2D host's perpendicular
/// sleeves take the prism cut too). Any miss falls through with the FULL
/// opening set unchanged.
pub(super) fn try_cut(execution: &Execution, host: &Mesh, ctx: &VoidContext, element_id: u32) -> Option<Cut> {
    if !prism_cut::enabled() {
        return None;
    }
    // World bounds + triangle count captured BEFORE the cut so the
    // per-host diagnostic matches what the exact/rect paths record.
    let prism_bounds = world_host_bounds(host);
    let prism_tris_before = host.triangle_count();
    let (mesh, residual) = execution.try_prism_cut(host, ctx)?;
    if residual.is_none() {
        // Same per-host cut-effect snapshot the exact path records, so
        // prism-cut hosts aren't missing from the diagnostics. With a
        // residual, the recursive exact pass records the (final) one itself.
        execution.record_host_cut_effect(
            element_id,
            prism_tris_before,
            mesh.triangle_count(),
            ctx.rect_opening_count(),
            prism_bounds,
        );
    }
    Some(Cut { mesh, residual })
}
