// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Export-local intra-mesh vertex weld + index dedup.
//!
//! The faceted-brep mesher emits geometry per `IfcFace` with no cross-face
//! vertex sharing, so a closed shell duplicates every shared corner once per
//! incident face (~3-6x). That is the direct cause of the ~8x-larger GLBs the
//! reference-extractor comparison flagged on structural (faceted-brep-heavy)
//! models. This weld runs at the shared glTF write chokepoint (`push_mesh` /
//! `push_mesh_quantized`), collapsing vertices that share an identical f32
//! position AND a coinciding normal into one, then remapping indices.
//!
//! It is EXPORT-ONLY: it never touches `process_geometry`'s `MeshData`, so the
//! pinned mesh-output determinism manifests are unaffected. World triangles and
//! the world AABB are preserved exactly (welded vertices sit at identical
//! positions, triangle count and winding are unchanged). Creases stay split:
//! two faces meeting at an angle carry distinct normals at the shared corner,
//! so their vertices do NOT merge and flat/crease shading is preserved.
//!
//! Deterministic and cross-arch (native == wasm32): first-seen order over the
//! original vertex array, integer keys (f32 position bits + a quantized normal),
//! no float comparison, FMA-free.

use rustc_hash::FxHashMap;

/// Normal quantization grid: components are multiplied by this and rounded to an
/// integer before keying. Matches `ifc_lite_geometry`'s `facet_weld` /
/// `consolidate_coplanar` `NORMAL_QUANT`, so the weld merges exactly the
/// f32-jittered coplanar normals while keeping any real crease (normals that
/// differ by more than ~1e-3 in a component) split.
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
/// unchanged apart from the (stable) vertex numbering.
pub(crate) fn weld_local(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let nverts = positions.len() / 3;
    // No-op (return the inputs unchanged) on a malformed mesh: normals not
    // matching positions, empty, or ANY index >= nverts. This preserves the
    // pre-weld behaviour exactly - the emit path wrote the (invalid) index
    // buffer through without validating it, so a malformed from-meshes input
    // stays invalid-but-present rather than panicking on `remap[i]`.
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

    let out_idx: Vec<u32> = indices
        .iter()
        .map(|&i| remap[i as usize])
        .collect();
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
        let (p, n, i) = weld_local(&positions, &normals, &indices);
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
    fn out_of_range_index_is_a_no_op_not_a_panic() {
        // A malformed mesh (index >= vertex count) must round-trip unchanged,
        // exactly as the pre-weld emit path handled it - no OOB panic.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let normals = [0.0f32, 0.0, 1.0].repeat(3);
        let indices = vec![0, 1, 9]; // 9 is out of range (only 3 verts)
        let (p, n, i) = weld_local(&positions, &normals, &indices);
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
        let (p, _n, i) = weld_local(&positions, &normals, &indices);
        assert_eq!(p.len() / 3, 2, "distinct normals keep the corner split");
        assert_eq!(i, vec![0, 1]);
    }

    #[test]
    fn deterministic_and_first_seen_order() {
        let positions = vec![9.0, 9.0, 9.0, 0.0, 0.0, 0.0, 9.0, 9.0, 9.0];
        let normals = vec![0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let indices = vec![0, 1, 2];
        let (p1, n1, i1) = weld_local(&positions, &normals, &indices);
        let (p2, n2, i2) = weld_local(&positions, &normals, &indices);
        assert_eq!((&p1, &n1, &i1), (&p2, &n2, &i2), "stable across runs");
        assert_eq!(p1.len() / 3, 2, "the repeated vertex 0/2 merges");
        // First-seen: vertex 0's position takes new id 0, vertex 1 takes id 1.
        assert_eq!(&p1[0..3], &[9.0, 9.0, 9.0]);
        assert_eq!(i1, vec![0, 1, 0]);
    }
}
