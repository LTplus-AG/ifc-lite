// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Intra-mesh vertex weld + index dedup, applied at the mesh SOURCE.
//!
//! The faceted-brep mesher emits geometry per `IfcFace` with no cross-face
//! vertex sharing, so a closed shell duplicates every shared corner once per
//! incident face (~3-6x). That is the direct cause of the ~8x-larger GLBs the
//! reference-extractor comparison flagged on structural (faceted-brep-heavy)
//! models, and it inflates every downstream mesh (render, export, analysis).
//! This weld collapses vertices that share an identical f32 position AND a
//! coinciding (quantized) normal into one, then remaps indices.
//!
//! It runs once, at the single per-element mesh funnel `build_mesh_data`
//! (`ifc_lite_processing::element`), so every element — voided or not, faceted
//! brep or swept solid — arrives welded in its `MeshData`. Because it keys on
//! the quantized normal, coincident positions carrying DISTINCT normals (a
//! crease / cube corner) stay split, so flat shading is preserved (a cube keeps
//! its 24 vertices). World triangles and the world AABB are preserved exactly
//! (welded vertices sit at identical positions; triangle count and winding are
//! unchanged).
//!
//! ## Per-vertex attributes
//!
//! `MeshData`'s only per-vertex-parallel arrays are `positions`, `normals`, and
//! (for textured meshes, #961) `uvs`. The weld carries the UVs through the same
//! remap so they stay 1:1 with the welded positions, AND folds the (quantized)
//! UV into the merge key: two vertices at the same position + normal but
//! DIFFERENT UVs are a legitimate texture SEAM and must stay split, or the
//! texture mapping tears. An untextured mesh (`uvs == None`) contributes a
//! constant `(0, 0)` UV, so its key is effectively position + normal and it gets
//! the full weld benefit (steel faceted breps unaffected).
//!
//! Deterministic and cross-arch (native == wasm32): first-seen order over the
//! original vertex array, integer keys (f32 position bits + a quantized normal +
//! a quantized UV), no float comparison, FMA-free.

use rustc_hash::FxHashMap;

/// Normal quantization grid: components are multiplied by this and rounded to an
/// integer before keying. Matches [`crate::facet_weld`]'s `NORMAL_QUANT` and the
/// `consolidate_coplanar` grid, so the weld merges exactly the f32-jittered
/// coplanar normals while keeping any real crease (normals that differ by more
/// than ~1e-3 in a component) split.
const NORMAL_QUANT: f32 = 1.0e3;

/// UV quantization grid (~0.001 texel-fraction resolution). Coarse enough to
/// merge f32 UV jitter on a shared corner, far finer than any real texture seam
/// (a seam jumps the UV by a large fraction of the atlas), so seams stay split.
const UV_QUANT: f32 = 1.0e3;

/// Vertex identity key: exact position bits + quantized normal + quantized UV.
type VKey = (u32, u32, u32, i32, i32, i32, i32, i32);

#[inline]
fn vkey(p: &[f32], n: &[f32], uv: [f32; 2]) -> VKey {
    (
        p[0].to_bits(),
        p[1].to_bits(),
        p[2].to_bits(),
        (n[0] * NORMAL_QUANT).round() as i32,
        (n[1] * NORMAL_QUANT).round() as i32,
        (n[2] * NORMAL_QUANT).round() as i32,
        (uv[0] * UV_QUANT).round() as i32,
        (uv[1] * UV_QUANT).round() as i32,
    )
}

/// Weld `positions`/`normals` (3 floats per vertex, equal length), optional
/// `uvs` (2 floats per vertex), and remap `indices`. Returns the welded
/// `(positions, normals, uvs, indices)` — `uvs` is `Some` iff the input `uvs`
/// was `Some`, always 1:1 with the welded positions. A mesh with no mergeable
/// vertices (already welded, or all-crease like a cube) round-trips unchanged
/// apart from the (stable) vertex numbering — so the weld is idempotent.
pub fn weld_indexed(
    positions: &[f32],
    normals: &[f32],
    uvs: Option<&[f32]>,
    indices: &[u32],
) -> (Vec<f32>, Vec<f32>, Option<Vec<f32>>, Vec<u32>) {
    let nverts = positions.len() / 3;
    // No-op (return the inputs unchanged) on a malformed mesh: normals not
    // matching positions, empty, a UV array not 2-per-vertex, or ANY index >=
    // nverts. This preserves the pre-weld behaviour exactly - the emit path
    // wrote the (invalid) buffers through without validating them, so a
    // malformed input stays invalid-but-present rather than panicking, and a
    // desynced UV array is never re-associated with the wrong vertices.
    let uv_len_ok = uvs.is_none_or(|u| u.len() == nverts * 2);
    if normals.len() != positions.len()
        || nverts == 0
        || !uv_len_ok
        || indices.iter().any(|&i| i as usize >= nverts)
    {
        return (
            positions.to_vec(),
            normals.to_vec(),
            uvs.map(|u| u.to_vec()),
            indices.to_vec(),
        );
    }

    let mut map: FxHashMap<VKey, u32> = FxHashMap::default();
    let mut remap = vec![0u32; nverts];
    let mut out_pos: Vec<f32> = Vec::with_capacity(positions.len());
    let mut out_nrm: Vec<f32> = Vec::with_capacity(normals.len());
    let mut out_uv: Vec<f32> = Vec::with_capacity(uvs.map_or(0, <[f32]>::len));

    for v in 0..nverts {
        let p = &positions[v * 3..v * 3 + 3];
        let n = &normals[v * 3..v * 3 + 3];
        let uv = match uvs {
            Some(u) => [u[v * 2], u[v * 2 + 1]],
            None => [0.0, 0.0],
        };
        let key = vkey(p, n, uv);
        let new_id = match map.get(&key) {
            Some(&id) => id,
            None => {
                let id = (out_pos.len() / 3) as u32;
                out_pos.extend_from_slice(p);
                out_nrm.extend_from_slice(n);
                if uvs.is_some() {
                    out_uv.extend_from_slice(&uv);
                }
                map.insert(key, id);
                id
            }
        };
        remap[v] = new_id;
    }

    let out_idx: Vec<u32> = indices.iter().map(|&i| remap[i as usize]).collect();
    let out_uvs = uvs.map(|_| out_uv);
    (out_pos, out_nrm, out_uvs, out_idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_coplanar_shared_vertices() {
        // Two triangles sharing an edge, all four vertices coplanar with the
        // same +Z normal, but authored per-face (6 vertices, the shared edge
        // duplicated). The weld collapses to the 4 unique corners.
        let positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, // tri A
            1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // tri B (shares 2 verts)
        ];
        let normals = [0.0f32, 0.0, 1.0].repeat(6); // 6 verts, all +Z
        let indices = vec![0, 1, 2, 3, 4, 5];
        let (p, n, uv, i) = weld_indexed(&positions, &normals, None, &indices);
        assert!(uv.is_none(), "no uvs in, no uvs out");
        assert_eq!(p.len() / 3, 4, "6 authored verts -> 4 unique corners");
        assert_eq!(n.len(), p.len());
        assert_eq!(i.len(), 6, "triangle count unchanged");
        // Every remapped index is in range and reproduces the same world points.
        for (orig, &ni) in indices.iter().zip(i.iter()) {
            let o = *orig as usize * 3;
            let w = ni as usize * 3;
            assert_eq!(&positions[o..o + 3], &p[w..w + 3], "world position preserved");
        }
    }

    #[test]
    fn faceted_plate_welds_to_grid() {
        // A flat GxG plate authored per-cell — each cell carries its OWN four
        // coplanar corners (the faceted-brep duplication pattern). The weld
        // collapses the 4*G*G raw vertices to the (G+1)^2 unique grid points,
        // leaving triangles unchanged.
        const G: usize = 4;
        let mut positions: Vec<f32> = Vec::new();
        let mut normals: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for i in 0..G {
            for j in 0..G {
                let base = (positions.len() / 3) as u32;
                let (x, y) = (i as f32, j as f32);
                for (dx, dy) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
                    positions.extend_from_slice(&[x + dx, y + dy, 0.0]);
                    normals.extend_from_slice(&[0.0, 0.0, 1.0]);
                }
                indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
            }
        }
        let raw_verts = positions.len() / 3;
        let (p, _n, _uv, idx) = weld_indexed(&positions, &normals, None, &indices);
        assert_eq!(raw_verts, 4 * G * G);
        assert_eq!(p.len() / 3, (G + 1) * (G + 1), "welded to unique grid points");
        assert_eq!(idx.len(), indices.len(), "triangle count unchanged");
    }

    #[test]
    fn out_of_range_index_is_a_no_op_not_a_panic() {
        // A malformed mesh (index >= vertex count) must round-trip unchanged,
        // exactly as the pre-weld emit path handled it - no OOB panic.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let normals = [0.0f32, 0.0, 1.0].repeat(3);
        let indices = vec![0, 1, 9]; // 9 is out of range (only 3 verts)
        let (p, n, _uv, i) = weld_indexed(&positions, &normals, None, &indices);
        assert_eq!(p, positions, "malformed input returns positions unchanged");
        assert_eq!(n, normals);
        assert_eq!(i, indices, "indices pass through unchanged");
    }

    #[test]
    fn keeps_creases_split() {
        // Same corner position, two DIFFERENT normals (a 90-degree crease): the
        // two vertices must NOT merge, or flat shading would break.
        let positions = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let normals = vec![0.0, 0.0, 1.0, 1.0, 0.0, 0.0];
        let indices = vec![0, 1];
        let (p, _n, _uv, i) = weld_indexed(&positions, &normals, None, &indices);
        assert_eq!(p.len() / 3, 2, "distinct normals keep the corner split");
        assert_eq!(i, vec![0, 1]);
    }

    #[test]
    fn flat_shaded_cube_keeps_24_verts() {
        // A unit cube authored as 6 quads, each with its OWN 4 corners and a
        // per-face outward normal (flat shading). Every cube corner is shared by
        // 3 faces carrying 3 DISTINCT normals, so no vertex merges: the welded
        // cube keeps all 24 vertices (flat shading preserved).
        let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
            // +Z / -Z
            ([0.0, 0.0, 1.0], [[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]]),
            ([0.0, 0.0, -1.0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]]),
            // +X / -X
            ([1.0, 0.0, 0.0], [[1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [1.0, 1.0, 1.0], [1.0, 0.0, 1.0]]),
            ([-1.0, 0.0, 0.0], [[0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 1.0, 1.0], [0.0, 0.0, 1.0]]),
            // +Y / -Y
            ([0.0, 1.0, 0.0], [[0.0, 1.0, 0.0], [1.0, 1.0, 0.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]]),
            ([0.0, -1.0, 0.0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 0.0, 1.0]]),
        ];
        let mut positions: Vec<f32> = Vec::new();
        let mut normals: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for (nrm, corners) in faces {
            let base = (positions.len() / 3) as u32;
            for c in corners {
                positions.extend_from_slice(&c);
                normals.extend_from_slice(&nrm);
            }
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        assert_eq!(positions.len() / 3, 24, "6 faces * 4 corners = 24 raw verts");
        let (p, _n, _uv, i) = weld_indexed(&positions, &normals, None, &indices);
        assert_eq!(p.len() / 3, 24, "distinct per-face normals keep all 24 verts (flat shading)");
        assert_eq!(i.len(), 36, "12 triangles unchanged");
    }

    #[test]
    fn uv_seam_stays_split_and_uvs_stay_aligned() {
        // Two triangles sharing an edge, all 6 verts coplanar with the SAME +Z
        // normal — but the shared edge is a texture SEAM: its two duplicated
        // corners carry DIFFERENT UVs on each triangle (u=1 vs u=0). Position +
        // normal alone would merge them (as `merges_coplanar_shared_vertices`
        // shows: 6 -> 4); the UV key must keep the two seam corners split, so
        // the mesh welds to 6 (nothing merges here) and the UVs stay 1:1.
        let positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, // tri A
            1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // tri B (shares the (1,0)&(1,1) corners)
        ];
        let normals = [0.0f32, 0.0, 1.0].repeat(6);
        // Seam: tri A's shared corners have u=1, tri B's identical-position
        // corners have u=0 — a distinct UV on the same position+normal.
        let uvs = vec![
            0.0, 0.0, 1.0, 0.0, 1.0, 1.0, // tri A uvs (u=1 at the shared corners)
            0.0, 0.0, 0.0, 1.0, 0.0, 1.0, // tri B uvs (u=0 at the identical-position corners)
        ];
        let indices = vec![0, 1, 2, 3, 4, 5];
        let (p, n, uv, i) = weld_indexed(&positions, &normals, Some(&uvs), &indices);
        assert_eq!(p.len() / 3, 6, "the UV seam keeps all 6 verts split");
        let uv = uv.expect("uvs carried through");
        assert_eq!(uv.len(), (p.len() / 3) * 2, "uvs stay 1:1 (2 per vertex) with positions");
        assert_eq!(n.len(), p.len(), "normals stay 1:1 with positions");
        assert_eq!(i.len(), 6, "triangle count unchanged");
        // Each welded vertex's UV matches its source vertex's UV (no desync).
        for (orig, &ni) in indices.iter().zip(i.iter()) {
            let o = *orig as usize * 2;
            let w = ni as usize * 2;
            assert_eq!(&uvs[o..o + 2], &uv[w..w + 2], "uv follows its vertex");
        }
    }

    #[test]
    fn coplanar_same_uv_still_welds_and_carries_uvs() {
        // The seam counterpart: two coplanar tris sharing an edge whose shared
        // corners carry the SAME UV weld to 4 verts (like the untextured case),
        // and the surviving UVs stay 1:1 with positions.
        let positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, // tri A
            1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // tri B (shares 2 verts)
        ];
        let normals = [0.0f32, 0.0, 1.0].repeat(6);
        // UV == position.xy, so shared corners share a UV and DO merge.
        let uvs = vec![
            0.0, 0.0, 1.0, 0.0, 0.0, 1.0, //
            1.0, 0.0, 1.0, 1.0, 0.0, 1.0, //
        ];
        let indices = vec![0, 1, 2, 3, 4, 5];
        let (p, _n, uv, _i) = weld_indexed(&positions, &normals, Some(&uvs), &indices);
        let uv = uv.expect("uvs carried through");
        assert_eq!(p.len() / 3, 4, "same-uv shared corners still weld to 4");
        assert_eq!(uv.len(), (p.len() / 3) * 2, "uvs stay 1:1 with welded positions");
    }

    #[test]
    fn weld_is_idempotent() {
        // Welding an already-welded mesh is a no-op (bit-identical output). This
        // is what makes removing the redundant per-export weld safe.
        let positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, //
            1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, //
        ];
        let normals = [0.0f32, 0.0, 1.0].repeat(6);
        let indices = vec![0, 1, 2, 3, 4, 5];
        let (p1, n1, _uv1, i1) = weld_indexed(&positions, &normals, None, &indices);
        let (p2, n2, _uv2, i2) = weld_indexed(&p1, &n1, None, &i1);
        assert_eq!((&p1, &n1, &i1), (&p2, &n2, &i2), "second weld is a no-op");
    }

    #[test]
    fn deterministic_and_first_seen_order() {
        let positions = vec![9.0, 9.0, 9.0, 0.0, 0.0, 0.0, 9.0, 9.0, 9.0];
        let normals = vec![0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let indices = vec![0, 1, 2];
        let (p1, n1, _uv1, i1) = weld_indexed(&positions, &normals, None, &indices);
        let (p2, n2, _uv2, i2) = weld_indexed(&positions, &normals, None, &indices);
        assert_eq!((&p1, &n1, &i1), (&p2, &n2, &i2), "stable across runs");
        assert_eq!(p1.len() / 3, 2, "the repeated vertex 0/2 merges");
        // First-seen: vertex 0's position takes new id 0, vertex 1 takes id 1.
        assert_eq!(&p1[0..3], &[9.0, 9.0, 9.0]);
        assert_eq!(i1, vec![0, 1, 0]);
    }
}
