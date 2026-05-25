// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Coplanar Z-fight dedup for multi-sub-mesh elements.
//!
//! Revit-exported doors/windows often ship the glass pane as a thin brep
//! whose front/back faces sit exactly on the metal-trim faces. The glass and
//! trim then Z-fight when rendered. This pass detects axis-aligned AABB
//! faces shared between two sub-meshes of the SAME element with overlapping
//! 2D projection and shrinks the smaller (by vertex count) sub-mesh inward
//! by `eps` along that axis so the faces no longer overlap. Detection is
//! done in the element's local frame BEFORE placement is applied, so the
//! axis-aligned assumption holds for any product orientation.
//!
//! `eps` is auto-derived as `5e-5 × max_sub_mesh_extent` so the offset is
//! always ~0.05–0.1 mm at typical IFC product scales (millimetre or metre
//! file units) without callers having to thread `unit_scale` through. That
//! is well below any meaningful BIM tolerance and below f32 precision at
//! typical building scales, but large enough to break Z-fight in a 24-bit
//! depth buffer.
//!
//! Non-glass sub-meshes still benefit: any element whose sub-shells share
//! an AABB face plane (e.g. window frame + sash, panelled doors with inlay
//! glass) gets the same treatment automatically. Sub-meshes whose AABBs do
//! not overlap pay only the cheap AABB compare.
//!
//! See `tests/issue_604_door_glass_zfight.rs` for the regression that pins
//! this behaviour for the issue-604 fixture.

use crate::mesh::SubMeshCollection;

/// In-place dedup. Operates in whatever units the sub-meshes are currently
/// stored in (file units pre-`scale_mesh`, or meters post-`scale_mesh`) —
/// `eps` is auto-derived from the sub-meshes' own AABBs so the offset is
/// scale-correct regardless of unit_scale.
pub(crate) fn dedupe_coplanar_submeshes(collection: &mut SubMeshCollection) {
    let n = collection.sub_meshes.len();
    if n < 2 {
        return;
    }

    // Per-sub-mesh AABBs in local frame (pre-placement). `bounds()` is O(N)
    // over positions; we compute once and reuse for every pair.
    let bounds: Vec<([f32; 3], [f32; 3])> = collection
        .sub_meshes
        .iter()
        .map(|sm| {
            let (mn, mx) = sm.mesh.bounds();
            ([mn.x, mn.y, mn.z], [mx.x, mx.y, mx.z])
        })
        .collect();

    // Scale eps to the model: 5e-5 × max-extent → ~0.1 mm at 2 m product
    // height, ~0.0001 m at 2 m product height (whichever units the mesh is
    // currently in). Floor at f32 precision so empty / degenerate inputs
    // don't divide by zero.
    let max_extent = bounds
        .iter()
        .map(|(mn, mx)| (mx[0] - mn[0]).max(mx[1] - mn[1]).max(mx[2] - mn[2]))
        .fold(0.0f32, f32::max);
    let eps = (max_extent * 5e-5).max(1e-6);
    let plane_tol = eps * 10.0;

    // For each sub-mesh, accumulate per-axis inward offsets to apply.
    // axis_offsets[i][axis][side]; side 0 = min face, 1 = max face. Values
    // are +eps (push min face up) or -eps (push max face down).
    let mut offsets: Vec<[[f32; 2]; 3]> = vec![[[0.0; 2]; 3]; n];

    for i in 0..n {
        for j in (i + 1)..n {
            let (a_min, a_max) = bounds[i];
            let (b_min, b_max) = bounds[j];

            for axis in 0..3 {
                // Two candidate shared planes per axis: a.max == b.min, or
                // a.min == b.max. Symmetric opposite-outward-normal cases.
                let cases = [(a_max[axis], b_min[axis], 1, 0), (a_min[axis], b_max[axis], 0, 1)];
                for (pa, pb, side_a, side_b) in cases {
                    if (pa - pb).abs() > plane_tol {
                        continue;
                    }
                    // Check 2D overlap on the other two axes. Must have
                    // positive overlap area, not just a shared edge.
                    let (u, v) = match axis {
                        0 => (1, 2),
                        1 => (0, 2),
                        _ => (0, 1),
                    };
                    let ou_min = a_min[u].max(b_min[u]);
                    let ou_max = a_max[u].min(b_max[u]);
                    let ov_min = a_min[v].max(b_min[v]);
                    let ov_max = a_max[v].min(b_max[v]);
                    if ou_max - ou_min <= plane_tol || ov_max - ov_min <= plane_tol {
                        continue;
                    }
                    // Smaller-by-vertex-count sub-mesh gets shrunk. For ties
                    // pick the one with smaller AABB volume, then lower index.
                    let nv_i = collection.sub_meshes[i].mesh.positions.len();
                    let nv_j = collection.sub_meshes[j].mesh.positions.len();
                    let shrink_i = if nv_i != nv_j {
                        nv_i < nv_j
                    } else {
                        let vol_i = (a_max[0] - a_min[0]).abs()
                            * (a_max[1] - a_min[1]).abs()
                            * (a_max[2] - a_min[2]).abs();
                        let vol_j = (b_max[0] - b_min[0]).abs()
                            * (b_max[1] - b_min[1]).abs()
                            * (b_max[2] - b_min[2]).abs();
                        if vol_i != vol_j { vol_i < vol_j } else { true }
                    };
                    if shrink_i {
                        offsets[i][axis][side_a] += if side_a == 0 { eps } else { -eps };
                    } else {
                        offsets[j][axis][side_b] += if side_b == 0 { eps } else { -eps };
                    }
                }
            }
        }
    }

    // Apply offsets. For each sub-mesh, any vertex whose coord is within
    // `plane_tol` of the AABB min/max on that axis gets nudged by the
    // accumulated inward offset. We accumulate offsets across pairs but
    // clamp the magnitude per-side to `eps` so chained pairs do not
    // multiply-shrink.
    for (i, off) in offsets.iter().enumerate() {
        if off.iter().all(|p| p[0] == 0.0 && p[1] == 0.0) {
            continue;
        }
        let (mn, mx) = bounds[i];
        let mesh = &mut collection.sub_meshes[i].mesh;
        for chunk in mesh.positions.chunks_exact_mut(3) {
            for axis in 0..3 {
                let off_min = off[axis][0].clamp(0.0, eps);
                let off_max = off[axis][1].clamp(-eps, 0.0);
                if off_min != 0.0 && (chunk[axis] - mn[axis]).abs() <= plane_tol {
                    chunk[axis] += off_min;
                }
                if off_max != 0.0 && (chunk[axis] - mx[axis]).abs() <= plane_tol {
                    chunk[axis] += off_max;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{Mesh, SubMesh};

    fn box_mesh(min: [f32; 3], max: [f32; 3]) -> Mesh {
        // Triangle-soup 1x1x1 unit-style box scaled to the given AABB. Each
        // face is its own 4 verts (no shared corners) so the AABB of every
        // face is exact.
        let mut m = Mesh::new();
        let p = [
            [min[0], min[1], min[2]], [max[0], min[1], min[2]],
            [max[0], max[1], min[2]], [min[0], max[1], min[2]],
            [min[0], min[1], max[2]], [max[0], min[1], max[2]],
            [max[0], max[1], max[2]], [min[0], max[1], max[2]],
        ];
        let faces: [([usize; 4], [f32; 3]); 6] = [
            ([0, 3, 2, 1], [0.0, 0.0, -1.0]),
            ([4, 5, 6, 7], [0.0, 0.0, 1.0]),
            ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
            ([2, 3, 7, 6], [0.0, 1.0, 0.0]),
            ([0, 4, 7, 3], [-1.0, 0.0, 0.0]),
            ([1, 2, 6, 5], [1.0, 0.0, 0.0]),
        ];
        for (idx, n) in faces {
            let base = (m.positions.len() / 3) as u32;
            for &k in idx.iter() {
                m.positions.extend_from_slice(&p[k]);
                m.normals.extend_from_slice(&n);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        m
    }

    fn expected_eps(max_extent: f32) -> f32 {
        (max_extent * 5e-5).max(1e-6)
    }

    #[test]
    fn shrinks_smaller_submesh_on_shared_y_plane() {
        // Big mesh: 100x100x100 box at y=[0, 100].
        // Small mesh: 50x50x10 box at y=[100, 110]. They share the y=100
        // plane with overlapping XZ projection. The small mesh should
        // shrink so its min y goes to 100 + eps.
        let big = box_mesh([0.0, 0.0, 0.0], [100.0, 100.0, 100.0]);
        let small = box_mesh([25.0, 100.0, 25.0], [75.0, 110.0, 75.0]);
        let mut coll = SubMeshCollection::new();
        coll.sub_meshes.push(SubMesh::new(1, big));
        coll.sub_meshes.push(SubMesh::new(2, small));
        dedupe_coplanar_submeshes(&mut coll);
        let eps = expected_eps(100.0);
        let (mn_big, mx_big) = coll.sub_meshes[0].mesh.bounds();
        let (mn_small, mx_small) = coll.sub_meshes[1].mesh.bounds();
        assert!((mn_big.y - 0.0).abs() < 1e-4);
        assert!((mx_big.y - 100.0).abs() < 1e-4);
        assert!((mn_small.y - (100.0 + eps)).abs() < 1e-3);
        assert!((mx_small.y - 110.0).abs() < 1e-4);
    }

    #[test]
    fn shrinks_smaller_when_sandwiched_on_both_y_faces() {
        // Glass-like setup: thin middle mesh sandwiched between two
        // thicker meshes that share y=10 and y=15 planes with it.
        let trim_back = box_mesh([0.0, 0.0, 0.0], [100.0, 10.0, 100.0]);
        let glass = box_mesh([20.0, 10.0, 20.0], [80.0, 15.0, 80.0]);
        let trim_front = box_mesh([0.0, 15.0, 0.0], [100.0, 25.0, 100.0]);
        let mut coll = SubMeshCollection::new();
        coll.sub_meshes.push(SubMesh::new(1, trim_back));
        coll.sub_meshes.push(SubMesh::new(2, glass));
        coll.sub_meshes.push(SubMesh::new(3, trim_front));
        dedupe_coplanar_submeshes(&mut coll);
        let eps = expected_eps(100.0);
        let (mn_g, mx_g) = coll.sub_meshes[1].mesh.bounds();
        let thickness = mx_g.y - mn_g.y;
        assert!((thickness - (5.0 - 2.0 * eps)).abs() < 1e-3);
    }

    #[test]
    fn leaves_non_overlapping_pairs_alone() {
        // Two meshes share y=10 plane but are offset in XZ so no overlap.
        let a = box_mesh([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        let b = box_mesh([20.0, 10.0, 20.0], [30.0, 20.0, 30.0]);
        let mut coll = SubMeshCollection::new();
        coll.sub_meshes.push(SubMesh::new(1, a));
        coll.sub_meshes.push(SubMesh::new(2, b));
        dedupe_coplanar_submeshes(&mut coll);
        let (_, mx_a) = coll.sub_meshes[0].mesh.bounds();
        let (mn_b, _) = coll.sub_meshes[1].mesh.bounds();
        assert!((mx_a.y - 10.0).abs() < 1e-4);
        assert!((mn_b.y - 10.0).abs() < 1e-4);
    }

    #[test]
    fn empty_or_single_submesh_is_noop() {
        let mut coll = SubMeshCollection::new();
        dedupe_coplanar_submeshes(&mut coll);
        coll.sub_meshes
            .push(SubMesh::new(1, box_mesh([0.0; 3], [1.0, 1.0, 1.0])));
        dedupe_coplanar_submeshes(&mut coll);
        let (mn, mx) = coll.sub_meshes[0].mesh.bounds();
        assert!((mn.x - 0.0).abs() < 1e-4);
        assert!((mx.x - 1.0).abs() < 1e-4);
    }
}
