// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};

/// Calculate smooth normals for a mesh.
///
/// One real implementation on every target. This used to be a no-op on
/// native (a leftover of the decommissioned desktop IPC path, which
/// recomputed normals in JS): the server silently shipped EMPTY normal
/// buffers for brep/surface/swept meshes, which the parquet writer
/// zero-padded and the glTF exporter dropped — while the same model loaded
/// via wasm had real normals (alignment audit).
#[inline]
pub fn calculate_normals(mesh: &mut Mesh) {
    let vertex_count = mesh.vertex_count();
    if vertex_count == 0 {
        return;
    }

    let positions_len = mesh.positions.len();

    // Initialize normals to zero
    let mut normals = vec![Vector3::zeros(); vertex_count];

    // Accumulate face normals
    for i in (0..mesh.indices.len()).step_by(3) {
        // Bounds check for indices array
        if i + 2 >= mesh.indices.len() {
            break;
        }

        let i0 = mesh.indices[i] as usize;
        let i1 = mesh.indices[i + 1] as usize;
        let i2 = mesh.indices[i + 2] as usize;

        // Bounds check for vertex indices - skip invalid triangles
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        if i0 * 3 + 2 >= positions_len || i1 * 3 + 2 >= positions_len || i2 * 3 + 2 >= positions_len
        {
            continue;
        }

        // Get triangle vertices
        let v0 = Point3::new(
            mesh.positions[i0 * 3] as f64,
            mesh.positions[i0 * 3 + 1] as f64,
            mesh.positions[i0 * 3 + 2] as f64,
        );
        let v1 = Point3::new(
            mesh.positions[i1 * 3] as f64,
            mesh.positions[i1 * 3 + 1] as f64,
            mesh.positions[i1 * 3 + 2] as f64,
        );
        let v2 = Point3::new(
            mesh.positions[i2 * 3] as f64,
            mesh.positions[i2 * 3 + 1] as f64,
            mesh.positions[i2 * 3 + 2] as f64,
        );

        // Calculate face normal
        let edge1 = v1 - v0;
        let edge2 = v2 - v0;
        let normal = edge1.cross(&edge2);

        // Accumulate normal for each vertex
        normals[i0] += normal;
        normals[i1] += normal;
        normals[i2] += normal;
    }

    // Normalize and write back
    mesh.normals.clear();
    mesh.normals.reserve(vertex_count * 3);

    for normal in normals {
        let normalized = normal
            .try_normalize(1e-6)
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
        mesh.normals.push(normalized.x as f32);
        mesh.normals.push(normalized.y as f32);
        mesh.normals.push(normalized.z as f32);
    }
}

/// Crease-aware vertex normals.
///
/// Standard per-vertex normal averaging produces two failure modes after
/// boolean CSG:
/// - **Scar lines on coplanar surfaces.** Manifold splits cut faces into
///   adjacent strips with numerically near-coincident-but-distinct verts;
///   un-welded averaging then treats each strip as isolated and renders a
///   visible darker/lighter line at every strip boundary.
/// - **Over-rounded corners.** Welding by position alone fixes the scar
///   lines but the vertex at a wall-meets-floor corner now contributes to
///   both face normals; averaging them gives a 45° normal where the
///   designer authored a 90° crease, so the corner reads as "soft" /
///   smoothed.
///
/// `smooth_normals_with_creases` resolves both at once:
///
/// 1. Compute area-weighted face normals.
/// 2. For each vertex, partition incident triangles into "smooth groups"
///    via union-find over edge-adjacency, joining only when the two
///    triangles' face normals satisfy `face_normal_dot ≥ crease_cos`.
/// 3. For each `(vertex, group)`, emit a duplicated final vertex with
///    the position of the original and the group's averaged normal.
/// 4. Rewrite indices to reference the duplicated final vertices.
///
/// At the rendering stage the result behaves exactly as a designer
/// expects: coplanar adjacent strips share a vertex per smooth group →
/// uniform shading; wall-meets-floor corners get separate verts per face
/// → crisp 90° edge.
///
/// `crease_cos` is the cosine of the maximum smoothing angle (default
/// `cos(30°) ≈ 0.866`). Lower values (e.g. `cos(60°) ≈ 0.5`) smooth
/// across more corners; higher values (`cos(15°) ≈ 0.966`) create more
/// hard edges. The 30° default matches Blender's "auto smooth", 3ds
/// Max's "smoothing groups by angle" and most CAD viewers.
///
/// Vertex bloat: in the worst case (every vertex on a crease) the output
/// has `3T` verts (same as flat shading). In the best case (every face
/// coplanar with its neighbour) the output keeps the input vert count.
/// Typical post-CSG building geometry lands at ~1.5×.
///
/// Unlike `calculate_normals` this is NOT cfg-gated to wasm. The same
/// crease-resolution logic runs on both targets so native and browser
/// renderers see identical normals. Native callers that previously
/// relied on JS-side normal computation can continue to; this function
/// just writes the canonical answer to `mesh.normals` either way.
pub fn smooth_normals_with_creases(mesh: &mut Mesh, crease_cos: f64) {
    use rustc_hash::FxHashMap;

    let vertex_count = mesh.vertex_count();
    let tri_count = mesh.indices.len() / 3;
    if vertex_count == 0 || tri_count == 0 {
        return;
    }

    // ── 1. Compute area-weighted face normals (cross product magnitude
    //       is 2× area, which is exactly the weight area-weighting wants).
    let mut face_normals: Vec<Vector3<f64>> = Vec::with_capacity(tri_count);
    for tri in mesh.indices.chunks_exact(3) {
        let i0 = tri[0] as usize;
        let i1 = tri[1] as usize;
        let i2 = tri[2] as usize;
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            face_normals.push(Vector3::zeros());
            continue;
        }
        let v0 = Point3::new(
            mesh.positions[i0 * 3] as f64,
            mesh.positions[i0 * 3 + 1] as f64,
            mesh.positions[i0 * 3 + 2] as f64,
        );
        let v1 = Point3::new(
            mesh.positions[i1 * 3] as f64,
            mesh.positions[i1 * 3 + 1] as f64,
            mesh.positions[i1 * 3 + 2] as f64,
        );
        let v2 = Point3::new(
            mesh.positions[i2 * 3] as f64,
            mesh.positions[i2 * 3 + 1] as f64,
            mesh.positions[i2 * 3 + 2] as f64,
        );
        let e1 = v1 - v0;
        let e2 = v2 - v0;
        face_normals.push(e1.cross(&e2));
    }

    // ── 2. Build vertex → list of (triangle_idx, corner_idx) adjacency.
    let mut vert_to_tris: Vec<smallvec::SmallVec<[(u32, u8); 6]>> =
        vec![smallvec::SmallVec::new(); vertex_count];
    for (t, tri) in mesh.indices.chunks_exact(3).enumerate() {
        for k in 0..3 {
            let v = tri[k] as usize;
            if v < vertex_count {
                vert_to_tris[v].push((t as u32, k as u8));
            }
        }
    }

    // ── 3. Per-vertex smooth-group partition via union-find over edge-
    //       adjacent triangles meeting at this vertex. Two triangles
    //       (t_a, k_a) and (t_b, k_b) sharing this vertex are in the
    //       same smooth group iff they share an EDGE incident to this
    //       vertex AND their face normals' normalised dot ≥ crease_cos.
    //
    //       We also emit one final vertex per (vertex, group) pair and
    //       remember the mapping triangle_corner → final_vertex_idx so
    //       the index-rewrite pass can produce the output triangle list.
    let mut new_positions: Vec<f32> = Vec::with_capacity(mesh.positions.len());
    let mut new_normals: Vec<f32> = Vec::with_capacity(mesh.positions.len());
    // corner_to_new_vertex[t * 3 + k] = the final vertex index for that
    // (triangle, corner) pair.
    let mut corner_to_new_vertex: Vec<u32> = vec![0; tri_count * 3];

    for (v, incident) in vert_to_tris.iter().enumerate() {
        if incident.is_empty() {
            continue;
        }

        // Union-find scratch. `parent[i]` indexes back into `incident`.
        let n = incident.len();
        let mut parent: smallvec::SmallVec<[u32; 6]> = (0..n as u32).collect();
        let find = |parent: &mut [u32], mut i: u32| -> u32 {
            while parent[i as usize] != i {
                parent[i as usize] = parent[parent[i as usize] as usize]; // path compress
                i = parent[i as usize];
            }
            i
        };

        // Index the triangles' two "other" corner vertices at this
        // vertex so we can detect shared edges cheaply: triangles
        // share an edge incident to `v` iff one of their non-`v`
        // corners matches.
        let other_corners = |corner_idx: u8, t: u32| -> [u32; 2] {
            let tri = &mesh.indices[(t as usize) * 3..(t as usize) * 3 + 3];
            let a = tri[((corner_idx + 1) % 3) as usize];
            let b = tri[((corner_idx + 2) % 3) as usize];
            [a, b]
        };

        // For small n (typical n ≤ 6) the O(n²) pairwise check is
        // faster than building a hash map of corner→incident-index;
        // BIM corner valences are bounded by mesh topology.
        for i in 0..n {
            let (t_i, k_i) = incident[i];
            let n_i = face_normals[t_i as usize]
                .try_normalize(1e-12)
                .unwrap_or_else(Vector3::zeros);
            if n_i == Vector3::zeros() {
                continue;
            }
            let oc_i = other_corners(k_i, t_i);
            for j in (i + 1)..n {
                let (t_j, k_j) = incident[j];
                let n_j = face_normals[t_j as usize]
                    .try_normalize(1e-12)
                    .unwrap_or_else(Vector3::zeros);
                if n_j == Vector3::zeros() {
                    continue;
                }
                let oc_j = other_corners(k_j, t_j);
                let shares_edge = oc_i[0] == oc_j[0]
                    || oc_i[0] == oc_j[1]
                    || oc_i[1] == oc_j[0]
                    || oc_i[1] == oc_j[1];
                if !shares_edge {
                    continue;
                }
                if n_i.dot(&n_j) < crease_cos {
                    continue;
                }
                // Union i and j.
                let ri = find(&mut parent, i as u32);
                let rj = find(&mut parent, j as u32);
                if ri != rj {
                    parent[ri as usize] = rj;
                }
            }
        }

        // Group incident triangles by root and emit one new vertex per
        // group with the group's area-weighted average normal.
        let mut group_to_new_vertex: FxHashMap<u32, u32> = FxHashMap::default();
        for i in 0..n {
            let root = find(&mut parent, i as u32);
            let new_v = *group_to_new_vertex.entry(root).or_insert_with(|| {
                let new_idx = (new_positions.len() / 3) as u32;
                new_positions.push(mesh.positions[v * 3]);
                new_positions.push(mesh.positions[v * 3 + 1]);
                new_positions.push(mesh.positions[v * 3 + 2]);
                // Group normal = area-weighted sum of contributing face
                // normals (not yet normalised — we accumulate raw
                // contributions and normalise after group is closed).
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_idx
            });
            // Accumulate this triangle's face normal (already area-weighted)
            // into the group's normal slot.
            let (t_i, _k_i) = incident[i];
            let n_i = face_normals[t_i as usize];
            new_normals[new_v as usize * 3] += n_i.x as f32;
            new_normals[new_v as usize * 3 + 1] += n_i.y as f32;
            new_normals[new_v as usize * 3 + 2] += n_i.z as f32;

            // Remember which final vertex this (triangle, corner) maps to.
            let (t, k) = incident[i];
            corner_to_new_vertex[t as usize * 3 + k as usize] = new_v;
        }
    }

    // ── 4. Normalise the accumulated normals.
    for chunk in new_normals.chunks_exact_mut(3) {
        let len_sq = (chunk[0] * chunk[0] + chunk[1] * chunk[1] + chunk[2] * chunk[2]) as f64;
        if len_sq > 1e-24 {
            let inv = (1.0 / len_sq.sqrt()) as f32;
            chunk[0] *= inv;
            chunk[1] *= inv;
            chunk[2] *= inv;
        } else {
            chunk[2] = 1.0;
        }
    }

    // ── 5. Rewrite indices to reference the new final vertices.
    let mut new_indices: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for t in 0..tri_count {
        new_indices.push(corner_to_new_vertex[t * 3]);
        new_indices.push(corner_to_new_vertex[t * 3 + 1]);
        new_indices.push(corner_to_new_vertex[t * 3 + 2]);
    }

    mesh.positions = new_positions;
    mesh.normals = new_normals;
    mesh.indices = new_indices;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a unit cube as 8 verts × 12 triangles (each corner vertex
    /// shared by three perpendicular faces). Used by the crease-aware
    /// normal tests below.
    fn cube_for_crease_tests() -> Mesh {
        let mut m = Mesh::with_capacity(8, 36);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let v = |x: f64, y: f64, z: f64| Point3::new(x, y, z);
        let corners = [
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(1.0, 1.0, 0.0),
            v(0.0, 1.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(1.0, 0.0, 1.0),
            v(1.0, 1.0, 1.0),
            v(0.0, 1.0, 1.0),
        ];
        for p in corners.iter() {
            m.add_vertex(*p, n);
        }
        for tri in [
            [0u32, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [2, 3, 7],
            [2, 7, 6],
            [1, 2, 6],
            [1, 6, 5],
            [3, 0, 4],
            [3, 4, 7],
        ] {
            m.add_triangle(tri[0], tri[1], tri[2]);
        }
        m
    }

    /// On a cube with 8 shared corner vertices, the naive averaging
    /// produces (1, 1, 1)/√3 normals at every corner (45° from each
    /// face) — corners read as "soft" balls. Crease-aware smoothing
    /// must split each corner into three separate verts (one per
    /// incident face) so the renderer paints crisp 90° edges.
    ///
    /// 8 corners × 3 faces = 24 final verts (one per (corner, face)),
    /// matching the per-face vertex emission a designer would author.
    #[test]
    fn crease_split_keeps_cube_corners_crisp() {
        let mut cube = cube_for_crease_tests();
        smooth_normals_with_creases(&mut cube, 0.866); // cos(30°)
        assert_eq!(
            cube.positions.len() / 3,
            24,
            "expected one vertex per (corner, face): 8 corners × 3 faces = 24, got {}",
            cube.positions.len() / 3,
        );
        // Every final vertex's normal must be axis-aligned (a face
        // normal) within tolerance. If averaging leaked across the
        // crease the normal would have all three components ≈ 1/√3.
        for chunk in cube.normals.chunks_exact(3) {
            let nx = chunk[0].abs();
            let ny = chunk[1].abs();
            let nz = chunk[2].abs();
            // Exactly one component should be ~1.0; the others ~0.
            let nontrivial = [nx, ny, nz].iter().filter(|&&v| v > 0.5).count();
            assert_eq!(
                nontrivial, 1,
                "vertex normal ({nx:.3}, {ny:.3}, {nz:.3}) leaked across crease",
            );
        }
    }

    /// On a single flat quad (two triangles sharing an edge), the two
    /// faces have identical normals, so crease-aware must keep them in
    /// one smooth group and emit just 4 shared-vertex output verts —
    /// not the worst-case 6 (one per triangle corner). Validates that
    /// coplanar adjacent strips shade uniformly after a CSG cut.
    #[test]
    fn crease_keeps_coplanar_quad_as_4_verts() {
        let mut quad = Mesh::with_capacity(4, 6);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let v = |x: f64, y: f64| Point3::new(x, y, 0.0);
        quad.add_vertex(v(0.0, 0.0), n);
        quad.add_vertex(v(1.0, 0.0), n);
        quad.add_vertex(v(1.0, 1.0), n);
        quad.add_vertex(v(0.0, 1.0), n);
        quad.add_triangle(0, 1, 2);
        quad.add_triangle(0, 2, 3);

        smooth_normals_with_creases(&mut quad, 0.866);

        assert_eq!(
            quad.positions.len() / 3,
            4,
            "coplanar quad must keep 4 shared verts, got {}",
            quad.positions.len() / 3,
        );
        // All normals should point +Z.
        for chunk in quad.normals.chunks_exact(3) {
            assert!((chunk[0]).abs() < 1e-5);
            assert!((chunk[1]).abs() < 1e-5);
            assert!((chunk[2] - 1.0).abs() < 1e-5);
        }
    }
}
