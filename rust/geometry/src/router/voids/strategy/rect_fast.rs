// SPDX-License-Identifier: MPL-2.0
use super::{Execution, Mesh, VoidContext};
use super::super::{CutterKind, Point3};

pub(super) fn try_cut(
    execution: &Execution, host: &Mesh, context: &VoidContext, element_id: u32,
    bounds: ((f32, f32, f32), (f32, f32, f32)), triangles_before: usize,
) -> Option<Mesh> {
    if !crate::rect_fast::enabled() { return None; }
    let mesh = execution.try_rect_fast(host, context)?;
    execution.record_host_cut_effect(
        element_id, triangles_before, mesh.triangle_count(), context.rect_opening_count(), bounds,
    );
    Some(mesh)
}

impl Execution {
    /// Try the analytic rectangular-opening fast path. Returns the watertight
    /// cut mesh iff EVERY merged opening is an axis-aligned `Rectangular`
    /// through-cut and the host is a clean axis-aligned box; otherwise `None`
    /// (→ the exact kernel handles it). A mixed opening set defers the whole
    /// host rather than composing analytic + exact cuts.
    fn try_rect_fast(&self, host: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        let (wmn, wmx) = host.bounds();
        let wall_min = Point3::new(wmn.x as f64, wmn.y as f64, wmn.z as f64);
        let wall_max = Point3::new(wmx.x as f64, wmx.y as f64, wmx.z as f64);
        let mut boxes: Vec<([f64; 3], [f64; 3])> =
            Vec::with_capacity(ctx.merged_openings.len());
        for op in &ctx.merged_openings {
            match op {
                CutterKind::Rectangular(omn, omx, dir) => {
                    let (fmn, fmx) = match dir {
                        Some(d) => self.extend_opening_along_direction(
                            *omn, *omx, wall_min, wall_max, *d,
                        ),
                        None => (*omn, *omx),
                    };
                    boxes.push(([fmn.x, fmn.y, fmn.z], [fmx.x, fmx.y, fmx.z]));
                }
                _ => return None,
            }
        }
        let mut stats = crate::rect_fast::RectFastStats::default();
        let out = crate::rect_fast::subtract_rect_openings(host, &boxes, &mut stats);
        self.record_rect_fast(&stats);
        // The cellular cut conformingly splits EVERY face by ALL grid lines (so
        // adjacent cells share edges → watertight), which over-fragments faces an
        // opening doesn't reach. Run the result through the SAME coplanar merge
        // the exact path uses (i_overlay union per plane) to collapse those back
        // to minimal triangles — keeps it watertight and un-bloated.
        out.map(crate::csg::ClippingProcessor::consolidate_coplanar)
    }

}
