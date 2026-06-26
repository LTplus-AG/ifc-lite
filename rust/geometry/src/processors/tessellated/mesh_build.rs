// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::Mesh;

use super::polygonal::PolygonalFaceSetProcessor;

impl PolygonalFaceSetProcessor {
    #[inline]
    /// Flip every triangle's winding to face outward when the shell is
    /// inward-facing. Returns `true` if a (whole-shell) flip was applied — the
    /// texture path needs this to swap the parallel `TexCoordIndex` in lockstep
    /// (issue #961), or corners 1/2 of the UVs mirror on a flipped shell.
    pub(crate) fn orient_closed_shell_outward(positions: &[f32], indices: &mut [u32]) -> bool {
        if indices.len() < 3 || positions.len() < 9 {
            return false;
        }

        let vertex_count = positions.len() / 3;
        if vertex_count == 0 {
            return false;
        }

        // Mesh centroid
        let mut cx = 0.0f64;
        let mut cy = 0.0f64;
        let mut cz = 0.0f64;
        for p in positions.chunks_exact(3) {
            cx += p[0] as f64;
            cy += p[1] as f64;
            cz += p[2] as f64;
        }
        let inv_n = 1.0 / vertex_count as f64;
        cx *= inv_n;
        cy *= inv_n;
        cz *= inv_n;

        let mut sign_accum = 0.0f64;
        for tri in indices.chunks_exact(3) {
            let i0 = tri[0] as usize;
            let i1 = tri[1] as usize;
            let i2 = tri[2] as usize;
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }

            let p0 = (
                positions[i0 * 3] as f64,
                positions[i0 * 3 + 1] as f64,
                positions[i0 * 3 + 2] as f64,
            );
            let p1 = (
                positions[i1 * 3] as f64,
                positions[i1 * 3 + 1] as f64,
                positions[i1 * 3 + 2] as f64,
            );
            let p2 = (
                positions[i2 * 3] as f64,
                positions[i2 * 3 + 1] as f64,
                positions[i2 * 3 + 2] as f64,
            );

            let e1 = (p1.0 - p0.0, p1.1 - p0.1, p1.2 - p0.2);
            let e2 = (p2.0 - p0.0, p2.1 - p0.1, p2.2 - p0.2);
            let n = (
                e1.1 * e2.2 - e1.2 * e2.1,
                e1.2 * e2.0 - e1.0 * e2.2,
                e1.0 * e2.1 - e1.1 * e2.0,
            );

            let tc = (
                (p0.0 + p1.0 + p2.0) / 3.0,
                (p0.1 + p1.1 + p2.1) / 3.0,
                (p0.2 + p1.2 + p2.2) / 3.0,
            );
            let out = (tc.0 - cx, tc.1 - cy, tc.2 - cz);
            sign_accum += n.0 * out.0 + n.1 * out.1 + n.2 * out.2;
        }

        // If most triangles point inward, flip all winding.
        if sign_accum < 0.0 {
            for tri in indices.chunks_exact_mut(3) {
                tri.swap(1, 2);
            }
            return true;
        }
        false
    }

    #[inline]
    pub(crate) fn build_flat_shaded_mesh(positions: &[f32], indices: &[u32]) -> Mesh {
        let mut flat_positions: Vec<f32> = Vec::with_capacity(indices.len() * 3);
        let mut flat_normals: Vec<f32> = Vec::with_capacity(indices.len() * 3);
        let mut flat_indices: Vec<u32> = Vec::with_capacity(indices.len());

        let vertex_count = positions.len() / 3;
        let mut next_index: u32 = 0;

        for tri in indices.chunks_exact(3) {
            let i0 = tri[0] as usize;
            let i1 = tri[1] as usize;
            let i2 = tri[2] as usize;
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }

            let p0 = (
                positions[i0 * 3] as f64,
                positions[i0 * 3 + 1] as f64,
                positions[i0 * 3 + 2] as f64,
            );
            let p1 = (
                positions[i1 * 3] as f64,
                positions[i1 * 3 + 1] as f64,
                positions[i1 * 3 + 2] as f64,
            );
            let p2 = (
                positions[i2 * 3] as f64,
                positions[i2 * 3 + 1] as f64,
                positions[i2 * 3 + 2] as f64,
            );

            let e1 = (p1.0 - p0.0, p1.1 - p0.1, p1.2 - p0.2);
            let e2 = (p2.0 - p0.0, p2.1 - p0.1, p2.2 - p0.2);
            let nx = e1.1 * e2.2 - e1.2 * e2.1;
            let ny = e1.2 * e2.0 - e1.0 * e2.2;
            let nz = e1.0 * e2.1 - e1.1 * e2.0;
            let len = (nx * nx + ny * ny + nz * nz).sqrt();
            let (nx, ny, nz) = if len > 1e-12 {
                (nx / len, ny / len, nz / len)
            } else {
                (0.0, 0.0, 1.0)
            };

            for &idx in &[i0, i1, i2] {
                flat_positions.push(positions[idx * 3]);
                flat_positions.push(positions[idx * 3 + 1]);
                flat_positions.push(positions[idx * 3 + 2]);
                flat_normals.push(nx as f32);
                flat_normals.push(ny as f32);
                flat_normals.push(nz as f32);
                flat_indices.push(next_index);
                next_index += 1;
            }
        }

        Mesh {
            positions: flat_positions,
            normals: flat_normals,
            indices: flat_indices,
            rtc_applied: false,
            origin: [0.0; 3],        instance_meta: None, }
    }

    /// Like [`Self::build_flat_shaded_mesh`] but also emits a per-vertex UV
    /// array aligned 1:1 with the duplicated vertices (issue #961).
    ///
    /// `tex_coord_index` is parallel to `indices` (and already winding-flipped
    /// to match it); each triangle's three 1-based entries index `tex_coords`.
    /// Triangles dropped by the out-of-range vertex guard are dropped from both
    /// positions and UVs in lockstep, so the UV/vertex alignment is exact.
    /// Out-of-range texcoord corners fall back to (0, 0).
    pub(crate) fn build_flat_shaded_mesh_with_uvs(
        positions: &[f32],
        indices: &[u32],
        tex_coords: &[[f32; 2]],
        tex_coord_index: &[[u32; 3]],
    ) -> (Mesh, Vec<f32>) {
        let mut flat_positions: Vec<f32> = Vec::with_capacity(indices.len() * 3);
        let mut flat_normals: Vec<f32> = Vec::with_capacity(indices.len() * 3);
        let mut flat_indices: Vec<u32> = Vec::with_capacity(indices.len());
        let mut uvs: Vec<f32> = Vec::with_capacity((indices.len() / 3) * 6);

        let vertex_count = positions.len() / 3;
        let mut next_index: u32 = 0;

        for (tri_i, tri) in indices.chunks_exact(3).enumerate() {
            let i0 = tri[0] as usize;
            let i1 = tri[1] as usize;
            let i2 = tri[2] as usize;
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }

            // Face normal — identical computation to build_flat_shaded_mesh.
            let p0 = (positions[i0 * 3] as f64, positions[i0 * 3 + 1] as f64, positions[i0 * 3 + 2] as f64);
            let p1 = (positions[i1 * 3] as f64, positions[i1 * 3 + 1] as f64, positions[i1 * 3 + 2] as f64);
            let p2 = (positions[i2 * 3] as f64, positions[i2 * 3 + 1] as f64, positions[i2 * 3 + 2] as f64);
            let e1 = (p1.0 - p0.0, p1.1 - p0.1, p1.2 - p0.2);
            let e2 = (p2.0 - p0.0, p2.1 - p0.1, p2.2 - p0.2);
            let nx = e1.1 * e2.2 - e1.2 * e2.1;
            let ny = e1.2 * e2.0 - e1.0 * e2.2;
            let nz = e1.0 * e2.1 - e1.1 * e2.0;
            let len = (nx * nx + ny * ny + nz * nz).sqrt();
            let (nx, ny, nz) = if len > 1e-12 {
                (nx / len, ny / len, nz / len)
            } else {
                (0.0, 0.0, 1.0)
            };

            let tri_uv = tex_coord_index.get(tri_i);
            for (corner, &idx) in [i0, i1, i2].iter().enumerate() {
                flat_positions.push(positions[idx * 3]);
                flat_positions.push(positions[idx * 3 + 1]);
                flat_positions.push(positions[idx * 3 + 2]);
                flat_normals.push(nx as f32);
                flat_normals.push(ny as f32);
                flat_normals.push(nz as f32);
                // Use the authored texture coordinates directly. The optional
                // IfcSurfaceTexture.TextureTransform is intentionally NOT applied:
                // its Scale over-tiles the texture (the buildingSMART annex-E
                // reference renders these coords ~1:1), and the TexCoords already
                // carry any intended offset.
                let uv = tri_uv
                    .and_then(|t| {
                        let one_based = t[corner] as usize;
                        tex_coords.get(one_based.checked_sub(1)?).copied()
                    })
                    .unwrap_or([0.0, 0.0]);
                // Flip V: IFC texture coordinates use a bottom-left origin (v up,
                // OpenGL/STEP convention), but GPU sampling + glTF export use a
                // top-left origin. Converting here (Rust = single source) keeps the
                // image upright for every consumer (viewer, server, CLI, export)
                // instead of each one re-flipping. Verified against the
                // buildingSMART annex-E reference render.
                uvs.push(uv[0]);
                uvs.push(1.0 - uv[1]);
                flat_indices.push(next_index);
                next_index += 1;
            }
        }

        (
            Mesh {
                positions: flat_positions,
                normals: flat_normals,
                indices: flat_indices,
                rtc_applied: false,
                origin: [0.0; 3],            instance_meta: None, },
            uvs,
        )
    }
}
