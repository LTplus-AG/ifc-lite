// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (intra-mesh vertex weld + index dedup). Split
//! into a `*_tests.rs` file (module-size-ratchet exempt) and attached via
//! `#[path]`.

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
    let (p, n, uv, i) = weld_indexed(&positions, &normals, None, &indices).expect("merged");
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
    let (p, _n, _uv, idx) = weld_indexed(&positions, &normals, None, &indices).expect("merged");
    assert_eq!(raw_verts, 4 * G * G);
    assert_eq!(p.len() / 3, (G + 1) * (G + 1), "welded to unique grid points");
    assert_eq!(idx.len(), indices.len(), "triangle count unchanged");
}

#[test]
fn out_of_range_index_is_a_no_op_not_a_panic() {
    // A malformed mesh (index >= vertex count) must not panic: the weld
    // returns None (caller keeps the unvalidated originals), exactly as the
    // pre-weld emit path handled it - no OOB access.
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals = [0.0f32, 0.0, 1.0].repeat(3);
    let indices = vec![0, 1, 9]; // 9 is out of range (only 3 verts)
    assert!(
        weld_indexed(&positions, &normals, None, &indices).is_none(),
        "malformed input is a no-op (None), not a panic"
    );
}

#[test]
fn index_equal_to_vertex_count_is_a_no_op_not_a_panic() {
    // Boundary case for the OOB guard: 3 vertices (valid indices 0..=2,
    // `nverts` == 3), with vertex 0 and vertex 1 at the SAME position+normal
    // so a merge actually happens (unique(2) != nverts(3)) and the code
    // reaches the `out_idx: remap[i as usize]` gather — vs.
    // `out_of_range_index_is_a_no_op_not_a_panic`, whose 3 distinct
    // vertices never merge, so it returns `None` via the "nothing
    // collided" branch and NEVER reaches that gather regardless of the
    // guard, and whose bad index (9) is far past the boundary anyway.
    // One index == nverts (3) — the smallest invalid index, right at the
    // guard's threshold. `i > nverts` (instead of `i >= nverts`) wrongly
    // admits `i == nverts` as in range, past the malformed-input guard,
    // to panic at `remap[3]` (remap has length `nverts` == 3, so index 3
    // is one past its end).
    let positions = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
    let normals = [0.0f32, 0.0, 1.0].repeat(3);
    let indices = vec![0, 1, 3]; // 3 == nverts, one past the last valid index
    assert!(
        weld_indexed(&positions, &normals, None, &indices).is_none(),
        "index == vertex count is out of range: no-op (None), not a panic"
    );
}

#[test]
fn keeps_creases_split() {
    // Same corner position, two DIFFERENT normals (a 90-degree crease): the
    // two vertices must NOT merge (or flat shading would break), so nothing
    // collides and the weld returns None (the 2-vertex input is kept as-is).
    let positions = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let normals = vec![0.0, 0.0, 1.0, 1.0, 0.0, 0.0];
    let indices = vec![0, 1];
    assert!(
        weld_indexed(&positions, &normals, None, &indices).is_none(),
        "distinct normals: nothing merges, weld is a no-op"
    );
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
    assert!(
        weld_indexed(&positions, &normals, None, &indices).is_none(),
        "distinct per-face normals: nothing merges, all 24 verts kept (flat shading)"
    );
}

#[test]
fn uv_seam_stays_split_and_uvs_stay_aligned() {
    // Two triangles sharing an edge, all 6 verts coplanar with the SAME +Z
    // normal — but the shared edge is a texture SEAM: its two duplicated
    // corners carry DIFFERENT UVs on each triangle (u=1 vs u=0). Position +
    // normal alone would merge them (as `merges_coplanar_shared_vertices`
    // shows: 6 -> 4); the UV key must keep the two seam corners split, so
    // the UV key keeps them split so nothing merges (weld is a no-op) and
    // the original UVs stay 1:1 with the 6 positions. Without the UV in the
    // key these two corners would collapse (as `merges_coplanar_shared_vertices`
    // shows: 6 -> 4) and tear the texture.
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
    assert!(
        weld_indexed(&positions, &normals, Some(&uvs), &indices).is_none(),
        "the UV seam keeps all 6 verts split (nothing merges, UVs stay 1:1)"
    );
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
    let (p, _n, uv, _i) =
        weld_indexed(&positions, &normals, Some(&uvs), &indices).expect("merged");
    let uv = uv.expect("uvs carried through");
    assert_eq!(p.len() / 3, 4, "same-uv shared corners still weld to 4");
    assert_eq!(uv.len(), (p.len() / 3) * 2, "uvs stay 1:1 with welded positions");
}

#[test]
fn weld_is_idempotent() {
    // The first weld merges the shared edge (6 -> 4); welding the RESULT is
    // a no-op (returns None), which is what makes removing the redundant
    // per-export weld safe.
    let positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, //
        1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, //
    ];
    let normals = [0.0f32, 0.0, 1.0].repeat(6);
    let indices = vec![0, 1, 2, 3, 4, 5];
    let (p1, n1, _uv1, i1) =
        weld_indexed(&positions, &normals, None, &indices).expect("first weld merges");
    assert_eq!(p1.len() / 3, 4);
    assert!(
        weld_indexed(&p1, &n1, None, &i1).is_none(),
        "second weld of an already-welded mesh is a no-op"
    );
}

#[test]
fn deterministic_and_first_seen_order() {
    let positions = vec![9.0, 9.0, 9.0, 0.0, 0.0, 0.0, 9.0, 9.0, 9.0];
    let normals = vec![0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let indices = vec![0, 1, 2];
    let (p1, n1, _uv1, i1) =
        weld_indexed(&positions, &normals, None, &indices).expect("merged");
    let (p2, n2, _uv2, i2) =
        weld_indexed(&positions, &normals, None, &indices).expect("merged");
    assert_eq!((&p1, &n1, &i1), (&p2, &n2, &i2), "stable across runs");
    assert_eq!(p1.len() / 3, 2, "the repeated vertex 0/2 merges");
    // First-seen: vertex 0's position takes new id 0, vertex 1 takes id 1.
    assert_eq!(&p1[0..3], &[9.0, 9.0, 9.0]);
    assert_eq!(i1, vec![0, 1, 0]);
}
