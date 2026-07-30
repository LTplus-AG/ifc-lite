// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Phase C of the seam conform: triangulate the (optionally conformed) rings and
//! emit, in bucket order.
//!
//! Split out of `conform.rs` to keep it under the module-size ratchet.

use super::PlanBucket;
use crate::csg::consolidate::{emit_triangle, tri_is_needle};
use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};

/// Phase C — triangulate the (optionally conformed) rings and emit, in bucket order.
pub(in crate::csg::consolidate) fn emit_plans(plans: &mut [PlanBucket], conformed: bool) -> Mesh {
    use crate::triangulation::triangulate_polygon_with_holes_refined;
    let mut output = Mesh::new();
    for plan in plans.iter_mut() {
        for t in &plan.raw {
            emit_triangle(&mut output, t, &plan.normal);
        }
        let basis = (plan.origin, plan.u_axis, plan.v_axis, plan.normal);
        for region in plan.regions.iter_mut() {
            let (outer, holes) = if conformed {
                (&region.outer_conformed, &region.holes_conformed)
            } else {
                (&region.outer, &region.holes)
            };
            // Quality CDT + bounded Ruppert refinement. Returns the
            // (possibly Steiner-augmented) 2D vertex list `all_2d` plus
            // indices into it; the lift below maps EVERY returned vertex
            // (input + Steiner) back to 3D, so a Steiner point on a shared
            // edge is split on both sides → watertight, no T-junction.
            // Refinement is interior-only: this region's outer/hole rings
            // are shared with neighbouring plane buckets triangulated
            // independently; a boundary Steiner point would tear that seam
            // (open edges / T-junctions). Interior-only refinement keeps the
            // seam watertight while still removing the rim-corner slivers.
            // Reuse pass 1's CDT wherever phase B left the rings alone. Stored by
            // MOVE on pass 1 and borrowed here — cloning it instead cost more than
            // the CDT it saves. The quality CDT with Ruppert refinement dominates a
            // consolidate, and re-running it on untouched regions is what made the
            // second emit a +61% geometry regression on ISSUE_129.
            if conformed && !region.changed {
                match &region.cached {
                    Some((pts, idx)) => {
                        emit_region(&mut output, basis, pts, idx);
                        continue;
                    }
                    None => continue,
                }
            }
            let (all_2d, indices) = match triangulate_polygon_with_holes_refined(outer, holes) {
                Ok((pts, idx)) => (pts, idx),
                Err(_) => continue,
            };
            if !conformed {
                region.cached = Some((all_2d, indices));
                let (pts, idx) = region.cached.as_ref().expect("just stored");
                emit_region(&mut output, basis, pts, idx);
                continue;
            }
            emit_region(&mut output, basis, &all_2d, &indices);
        }
    }
    output
}

/// Lift one region's 2D CDT back to 3D and append it. Shared by the fresh and the
/// cached paths so both emit byte-identically.
fn emit_region(
    output: &mut Mesh,
    basis: (Point3<f64>, Vector3<f64>, Vector3<f64>, Vector3<f64>),
    all_2d: &[nalgebra::Point2<f64>],
    indices: &[usize],
) {
    let (origin, u_axis, v_axis, normal) = basis;
    let verts_3d: Vec<Point3<f64>> = all_2d
        .iter()
        .map(|p| origin + u_axis * p.x + v_axis * p.y)
        .collect();
    let base = output.vertex_count() as u32;
    for vp in &verts_3d {
        output.add_vertex(*vp, normal);
    }
    for tri in indices.chunks_exact(3) {
        // Needle backstop: drop any residual sub-weld degenerate sliver
        // ([`tri_is_needle`], the same scale-relative power-of-two rule as the
        // single-triangle path). Cannot open a real gap — the hole/seam is framed
        // by its non-degenerate neighbours.
        let v = [verts_3d[tri[0]], verts_3d[tri[1]], verts_3d[tri[2]]];
        if tri_is_needle(&v) {
            continue;
        }
        output.add_triangle(
            base + tri[0] as u32,
            base + tri[1] as u32,
            base + tri[2] as u32,
        );
    }
}
