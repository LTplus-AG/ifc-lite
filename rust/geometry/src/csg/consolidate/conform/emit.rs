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
use rustc_hash::FxHashMap;

/// Phase C — triangulate the (optionally conformed) rings and emit, in bucket order.
/// Returns the emitted mesh and whether EVERY region triangulated.
///
/// The flag matters only for the conformed pass. A region whose CDT fails is
/// skipped, and on the conformed candidate that is not survivable: the accept bar
/// tests watertightness, and a dropped region that happened to be its own closed
/// component leaves the remainder edge-balanced, so a candidate missing a whole
/// surface component would be accepted. The caller rejects the candidate outright
/// rather than trying to reason about which drops are benign.
pub(in crate::csg::consolidate) fn emit_plans(
    plans: &mut [PlanBucket],
    conformed: bool,
) -> (Mesh, bool) {
    let mut complete = true;
    use crate::triangulation::{
        triangulate_polygon_with_holes_refined_bounded, EARCUT_FALLBACK_MAX_VERTICES,
    };
    let mut output = Mesh::new();
    for plan in plans.iter_mut() {
        let raw = if conformed {
            plan.raw_conformed.as_ref().unwrap_or(&plan.raw)
        } else {
            &plan.raw
        };
        for t in raw {
            emit_triangle(&mut output, t, &plan.normal);
        }
        let basis = (plan.origin, plan.u_axis, plan.v_axis, plan.normal);
        for region in plan.regions.iter_mut() {
            crate::progress::tick();
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
            if !conformed {
                if let Some((pts, idx)) = &region.cached {
                    emit_region(&mut output, basis, pts, idx);
                    continue;
                }
            }
            if conformed && !region.changed {
                match &region.cached {
                    Some((pts, idx)) => {
                        emit_region(&mut output, basis, pts, idx);
                        continue;
                    }
                    None => {
                        complete = false;
                        continue;
                    }
                }
            }
            // A region that fails to triangulate makes the consolidation fall
            // back to the raw kernel mesh, which is cheaper than earcut on a large
            // declined ring.
            let triangulated = triangulate_polygon_with_holes_refined_bounded(
                outer,
                holes,
                EARCUT_FALLBACK_MAX_VERTICES,
            );
            let (all_2d, indices) = match triangulated {
                Ok((pts, idx)) => (pts, idx),
                Err(_) => {
                    complete = false;
                    continue;
                }
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
    (output, complete)
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
    // Built on the first needle only: most regions have none.
    let mut edge_uses: Option<FxHashMap<(usize, usize), u8>> = None;
    for tri in indices.chunks_exact(3) {
        // Needle backstop: drop any residual sub-weld degenerate sliver
        // ([`tri_is_needle`], the same scale-relative power-of-two rule as the
        // single-triangle path; its doc carries the no-gap argument and the
        // long-span faces the rule also drops).
        //
        // That argument needs the needle's short edge to lie on a ring, where
        // the two near-duplicate rim vertices sit. A short edge interior to the
        // region joins two separate stretches of boundary, each kept by its own
        // neighbour: two opening corners 150 um apart on a 40 m wall face
        // (#8156). Dropping the needles across that neck leaves a hole in the
        // face that only a weld wider than the neck closes, so they are kept.
        let v = [verts_3d[tri[0]], verts_3d[tri[1]], verts_3d[tri[2]]];
        if tri_is_needle(&v) {
            let uses = edge_uses.get_or_insert_with(|| count_edge_uses(indices));
            if !shortest_edge_is_interior(tri, &v, uses) {
                continue;
            }
        }
        output.add_triangle(
            base + tri[0] as u32,
            base + tri[1] as u32,
            base + tri[2] as u32,
        );
    }
}

fn edge_key(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}

/// How many triangles of one region's triangulation use each undirected edge.
fn count_edge_uses(indices: &[usize]) -> FxHashMap<(usize, usize), u8> {
    // A triangulation of T triangles has at most 1.5 T distinct edges.
    let mut uses = FxHashMap::with_capacity_and_hasher(indices.len() / 2, Default::default());
    for tri in indices.chunks_exact(3) {
        for k in 0..3 {
            let count: &mut u8 = uses.entry(edge_key(tri[k], tri[(k + 1) % 3])).or_default();
            *count = count.saturating_add(1);
        }
    }
    uses
}

/// Whether the shortest edge of `tri` is shared with another triangle of the
/// same region, as opposed to lying on one of the region's rings. Ties keep
/// the first edge in index order. A zero-length or non-finite edge is never
/// interior: that triangle is degenerate, not a neck.
fn shortest_edge_is_interior(
    tri: &[usize],
    v: &[Point3<f64>; 3],
    uses: &FxHashMap<(usize, usize), u8>,
) -> bool {
    let len2 = |k: usize| (v[k] - v[(k + 1) % 3]).norm_squared();
    let mut shortest = 0;
    for k in 1..3 {
        if len2(k) < len2(shortest) {
            shortest = k;
        }
    }
    (0..3).all(|k| len2(k).is_finite())
        && len2(shortest) > 0.0
        && uses.get(&edge_key(tri[shortest], tri[(shortest + 1) % 3])).is_some_and(|&n| n >= 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::Point2;

    fn emitted(points: &[[f64; 2]], indices: &[usize]) -> Mesh {
        let points: Vec<Point2<f64>> = points.iter().map(|p| Point2::new(p[0], p[1])).collect();
        let basis = (Point3::origin(), Vector3::x(), Vector3::y(), Vector3::z());
        let mut mesh = Mesh::new();
        emit_region(&mut mesh, basis, &points, indices);
        mesh
    }

    fn emitted_triangles(points: &[[f64; 2]], indices: &[usize]) -> usize {
        emitted(points, indices).triangle_count()
    }

    /// #8156: two needles across a 100 um neck share their short edge. Each
    /// long edge belongs to a neighbour that stays, so both are kept.
    #[test]
    fn issue_8156_needles_sharing_their_short_edge_are_kept() {
        let points = [[0.0, 0.0], [1.0e-4, 0.0], [5.0, 1.0], [-5.0, -1.0]];
        assert_eq!(emitted_triangles(&points, &[0, 1, 2, 1, 0, 3]), 2);
    }

    /// The backstop's original case: the short edge lies on a ring, between
    /// two near-duplicate rim vertices. The needle goes, its neighbour stays.
    #[test]
    fn a_needle_whose_short_edge_is_on_a_ring_is_still_dropped() {
        let points = [[0.0, 0.0], [1.0e-4, 0.0], [5.0, 1.0], [2.0, 3.0]];
        assert_eq!(emitted_triangles(&points, &[0, 1, 2, 0, 2, 3]), 1);
    }

    /// Two indices at one position give zero-area triangles with a shared
    /// zero-length edge: degenerate, and dropped as before.
    #[test]
    fn a_shared_zero_length_edge_is_still_dropped() {
        let points = [[0.0, 0.0], [0.0, 0.0], [5.0, 1.0], [-5.0, -1.0]];
        assert_eq!(emitted_triangles(&points, &[0, 1, 2, 1, 0, 3]), 0);
    }

    /// Known limit: "shared short edge means a neck" is read in f64. A 10 nm
    /// neck at x = 3 m is below f32 resolution there, so both needles are kept
    /// and come out with zero area. The later `clean_degenerate` removes them.
    #[test]
    fn a_shared_short_edge_below_f32_resolution_emits_zero_area_triangles() {
        let points = [[3.0, 0.0], [3.0 + 1.0e-8, 0.0], [8.0, 1.0], [-2.0, -1.0]];
        let mut mesh = emitted(&points, &[0, 1, 2, 1, 0, 3]);
        assert_eq!(mesh.triangle_count(), 2);
        assert_eq!(mesh.positions[0..3], mesh.positions[3..6], "the neck collapses in f32");
        mesh.clean_degenerate();
        assert_eq!(mesh.triangle_count(), 0);
    }
}
