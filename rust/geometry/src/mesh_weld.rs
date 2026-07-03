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
//! Deterministic and cross-arch (native == wasm32): first-seen order over the
//! original vertex array, integer keys (f32 position bits + a quantized normal),
//! no float comparison, FMA-free.

use rustc_hash::FxHashMap;

/// Normal quantization grid: components are multiplied by this and rounded to an
/// integer before keying. Matches [`crate::facet_weld`]'s `NORMAL_QUANT` and the
/// `consolidate_coplanar` grid, so the weld merges exactly the f32-jittered
/// coplanar normals while keeping any real crease (normals that differ by more
/// than ~1e-3 in a component) split.
const NORMAL_QUANT: f32 = 1.0e3;

/// Vertex identity key: exact position bits plus a quantized normal.
type VKey = (u32, u32, u32, i32, i32, i32);

#[inline]
fn vkey(p: &[f32], n: &[f32]) -> VKey {
    (
        p[0].to_bits(),
        p[1].to_bits(),
        p[2].to_bits(),
        (n[0] * NORMAL_QUANT).round() as i32,
        (n[1] * NORMAL_QUANT).round() as i32,
        (n[2] * NORMAL_QUANT).round() as i32,
    )
}

/// Weld `positions`/`normals` (3 floats per vertex, equal length) and remap
/// `indices`. Returns the welded `(positions, normals, indices)`. A mesh with no
/// mergeable vertices (already welded, or all-crease like a cube) round-trips
/// unchanged apart from the (stable) vertex numbering — so the weld is
/// idempotent: welding a welded mesh is a no-op.
pub fn weld_indexed(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let nverts = positions.len() / 3;
    // No-op (return the inputs unchanged) on a malformed mesh: normals not
    // matching positions, empty, or ANY index >= nverts. This preserves the
    // pre-weld behaviour exactly - the emit path wrote the (invalid) index
    // buffer through without validating it, so a malformed input stays
    // invalid-but-present rather than panicking on `remap[i]`.
    if normals.len() != positions.len()
        || nverts == 0
        || indices.iter().any(|&i| i as usize >= nverts)
    {
        return (positions.to_vec(), normals.to_vec(), indices.to_vec());
    }

    let mut map: FxHashMap<VKey, u32> = FxHashMap::default();
    let mut remap = vec![0u32; nverts];
    let mut out_pos: Vec<f32> = Vec::with_capacity(positions.len());
    let mut out_nrm: Vec<f32> = Vec::with_capacity(normals.len());

    for v in 0..nverts {
        let p = &positions[v * 3..v * 3 + 3];
        let n = &normals[v * 3..v * 3 + 3];
        let key = vkey(p, n);
        let new_id = match map.get(&key) {
            Some(&id) => id,
            None => {
                let id = (out_pos.len() / 3) as u32;
                out_pos.extend_from_slice(p);
                out_nrm.extend_from_slice(n);
                map.insert(key, id);
                id
            }
        };
        remap[v] = new_id;
    }

    let out_idx: Vec<u32> = indices.iter().map(|&i| remap[i as usize]).collect();
    (out_pos, out_nrm, out_idx)
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
        let (p, n, i) = weld_indexed(&positions, &normals, &indices);
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
        let (p, _n, idx) = weld_indexed(&positions, &normals, &indices);
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
        let (p, n, i) = weld_indexed(&positions, &normals, &indices);
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
        let (p, _n, i) = weld_indexed(&positions, &normals, &indices);
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
        let (p, _n, i) = weld_indexed(&positions, &normals, &indices);
        assert_eq!(p.len() / 3, 24, "distinct per-face normals keep all 24 verts (flat shading)");
        assert_eq!(i.len(), 36, "12 triangles unchanged");
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
        let (p1, n1, i1) = weld_indexed(&positions, &normals, &indices);
        let (p2, n2, i2) = weld_indexed(&p1, &n1, &i1);
        assert_eq!((&p1, &n1, &i1), (&p2, &n2, &i2), "second weld is a no-op");
    }

    #[test]
    fn deterministic_and_first_seen_order() {
        let positions = vec![9.0, 9.0, 9.0, 0.0, 0.0, 0.0, 9.0, 9.0, 9.0];
        let normals = vec![0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let indices = vec![0, 1, 2];
        let (p1, n1, i1) = weld_indexed(&positions, &normals, &indices);
        let (p2, n2, i2) = weld_indexed(&positions, &normals, &indices);
        assert_eq!((&p1, &n1, &i1), (&p2, &n2, &i2), "stable across runs");
        assert_eq!(p1.len() / 3, 2, "the repeated vertex 0/2 merges");
        // First-seen: vertex 0's position takes new id 0, vertex 1 takes id 1.
        assert_eq!(&p1[0..3], &[9.0, 9.0, 9.0]);
        assert_eq!(i1, vec![0, 1, 0]);
    }
}
