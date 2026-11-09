// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ParamRect (stage A, first): the analytic box-minus-boxes cut in the host's
//! own placement frame, when the parametrics were captured and reconcile.

use super::super::geom::{
    rotate_mesh_from_frame, rotate_mesh_into_frame, rotate_point, signed_permutation_map, thin_axis,
};
use super::super::hygiene;
use super::{Cut, VoidContext};
use crate::math::aabb::Aabb3;
use crate::program::openings::execute::Execution;
use crate::{Mesh, Point3};

/// Flag-gated. ORIGIN-AWARE: it handles both the world mesh (origin 0, native
/// default) AND a per-element local-frame mesh (origin != 0, the wasm default —
/// the precision-critical case this path is FOR), since it builds its own frame
/// from the parametrics. Any miss falls through unchanged.
pub(super) fn try_cut(execution: &Execution, host: &Mesh, ctx: &VoidContext) -> Option<Cut> {
    if !crate::rect_fast::param_enabled() {
        return None;
    }
    let mesh = execution.try_param_rect_cut(host, ctx)?;
    Some(Cut { mesh, residual: None })
}

impl Execution {
    /// PARAMETRIC analytic fast path: subtract the openings as EXACT parametric boxes
    /// in the host's own placement frame (where the rotated wall + windows are
    /// axis-aligned), using the watertight cellular `rect_fast` cut, then rotate the
    /// result back to world. Frame + extents come from the IFC parametrics (not the
    /// mesh), so the cut is the analytic box-minus-boxes solid — ground-truth exact and
    /// MORE correct than the exact kernel on engulfing-opening walls. Fires only on the
    /// gated subset (`ctx.param` captured; host/opening reconciliation, shared-frame,
    /// in-bounds, no-overlap, watertight self-check); any miss returns `None` → exact
    /// kernel. Deterministic f64 → byte-identical native==wasm.
    pub(in crate::router::voids) fn try_param_rect_cut(&self, mesh: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        let param = ctx.param.as_ref()?;
        let host = &param.host;
        let rt = host.r.transpose();

        // Host expressed in F (small coords) + reconciliation against the real mesh.
        // ORIGIN-AWARE: the mesh may already be in a per-element local frame (wasm
        // defaults `local_frame_enabled()` ON), where positions are relative to
        // `mesh.origin` (world = origin + position). Frame the cut around
        // `center - origin` so host_f = Rᵀ·(world_vertex - center) either way.
        let o = mesh.origin;
        let eff_center = Point3::new(
            host.center.x - o[0],
            host.center.y - o[1],
            host.center.z - o[2],
        );
        let host_f = rotate_mesh_into_frame(mesh, &rt, &eff_center);
        if host_f.positions.is_empty() {
            return None;
        }
        let bounds = Aabb3::from_f32_positions(&host_f.positions);
        let (hmn, hmx) = (bounds.min, bounds.max);
        for k in 0..3 {
            let ext = hmx[k] - hmn[k];
            let lo = ext.min(2.0 * host.half[k]);
            let hi = ext.max(2.0 * host.half[k]).max(1.0e-9);
            if lo / hi < 0.99 {
                return None;
            }
        }

        // Opening boxes in F with the in-bounds + through-cut handling.
        let mut boxes: Vec<([f64; 3], [f64; 3])> = Vec::with_capacity(param.openings.len());
        for op in &param.openings {
            let map = signed_permutation_map(&(rt * op.r), 1.0e-3)?;
            let cf = rotate_point(
                &rt,
                op.center.x - host.center.x,
                op.center.y - host.center.y,
                op.center.z - host.center.z,
            );
            // The opening must penetrate along the wall's THIN (thickness) axis. If its
            // extrude axis maps to a length/height axis, extending it across the host
            // would wipe out a full slab — defer that case to the exact kernel.
            let pen = (0..3).find(|&i| map[i].0 == 2)?;
            if host.half[pen] > host.half[thin_axis(&host.half)] * 1.05 {
                return None;
            }
            let mut half_f = [0.0f64; 3];
            for i in 0..3 {
                half_f[i] = op.half[map[i].0];
            }
            // In-bounds: the opening must lie within the wall on the in-face axes; an
            // overrun is a partial intersection where box-clamp ≠ exact mesh-intersect.
            for i in 0..3 {
                if i == pen {
                    continue;
                }
                let tol = host.half[i] * 0.01 + 1.0e-4;
                if cf[i] - half_f[i] < -host.half[i] - tol
                    || cf[i] + half_f[i] > host.half[i] + tol
                {
                    return None;
                }
            }
            // Cut the box AS AUTHORED (it is reconciled to equal the opening void), with a
            // tiny margin on the penetration axis to avoid a flush-face coincidence. The
            // earlier full-thickness override over-cut multi-prism openings (each authored
            // box is a thin slice; extending each to the full thickness removes too much).
            let eps = 1.0e-4;
            let mut bmin = [cf[0] - half_f[0], cf[1] - half_f[1], cf[2] - half_f[2]];
            let mut bmax = [cf[0] + half_f[0], cf[1] + half_f[1], cf[2] + half_f[2]];
            bmin[pen] -= eps;
            bmax[pen] += eps;
            boxes.push((bmin, bmax));
        }

        // No-overlap: overlapping cutter boxes can diverge from the union-subtract.
        for a in 0..boxes.len() {
            for b in (a + 1)..boxes.len() {
                let (amn, amx) = boxes[a];
                let (bmn, bmx) = boxes[b];
                if (0..3).all(|i| amn[i] < bmx[i] - 1.0e-4 && bmn[i] < amx[i] - 1.0e-4) {
                    return None;
                }
            }
        }

        let mut stats = crate::rect_fast::RectFastStats::default();
        let cut_f = crate::rect_fast::subtract_rect_openings(&host_f, &boxes, &mut stats)?;
        let merged = crate::csg::ClippingProcessor::consolidate_coplanar(cut_f);
        // Emit as a local-frame mesh (small positions + origin), then run the SAME
        // hygiene the production output applies — in the small frame, where it is
        // precise — so the self-check sees exactly what downstream will keep.
        let mut out = rotate_mesh_from_frame(&merged, &host.r, &host.center);
        hygiene::clean_void_output(&mut out);

        // Self-check: never emit a non-watertight cut; defer to the exact kernel.
        if !crate::exact_topology::strict_closed_mesh(&out) {
            return None;
        }
        self.record_rect_fast(&stats);
        crate::rect_fast::param_record_fire();
        Some(out)
    }
}
