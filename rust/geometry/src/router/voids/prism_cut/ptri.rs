// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One host triangle in f64 (`PTri`), and the promotion from and demotion
//! back to a `Mesh`.

use super::kit::{cross, normalize, sub, V3};
use crate::math::aabb::Aabb3;
use crate::mesh::Mesh;

/// One host triangle in f64 (positions + per-vertex normals), host-local frame.
#[derive(Clone)]
pub(super) struct PTri {
    pub(super) p: [V3; 3],
    pub(super) n: [V3; 3],
}

impl PTri {
    #[inline]
    pub(super) fn aabb(&self) -> (V3, V3) {
        let mut bounds = Aabb3 {
            min: self.p[0],
            max: self.p[0],
        };
        for &v in &self.p[1..] {
            bounds.extend(v);
        }
        let (lo, hi) = (bounds.min, bounds.max);
        (lo, hi)
    }
}

/// Promote a `Mesh` to the f64 triangle list, folding nothing (the mesh is
/// taken in its own frame — `origin` semantics are preserved by the caller).
pub(super) fn ptris_from_mesh(mesh: &Mesh) -> Option<Vec<PTri>> {
    // Reject structurally malformed meshes outright: `chunks_exact(3)` below
    // silently drops any trailing partial triple, so a positions/indices length
    // that is not a multiple of 3 would rebuild the solid missing its tail data
    // while every emitted index still passed its bounds check.
    if !mesh.positions.len().is_multiple_of(3) || !mesh.indices.len().is_multiple_of(3) {
        return None;
    }
    let vc = mesh.positions.len() / 3;
    let have_normals = mesh.normals.len() == mesh.positions.len();
    let mut out = Vec::with_capacity(mesh.indices.len() / 3);
    for t in mesh.indices.chunks_exact(3) {
        if t.iter().any(|&i| i as usize >= vc) {
            return None;
        }
        let read = |i: u32| -> V3 {
            let b = i as usize * 3;
            [
                mesh.positions[b] as f64,
                mesh.positions[b + 1] as f64,
                mesh.positions[b + 2] as f64,
            ]
        };
        let p = [read(t[0]), read(t[1]), read(t[2])];
        if p.iter().any(|v| v.iter().any(|c| !c.is_finite())) {
            return None;
        }
        let n = if have_normals {
            let rn = |i: u32| -> V3 {
                let b = i as usize * 3;
                [
                    mesh.normals[b] as f64,
                    mesh.normals[b + 1] as f64,
                    mesh.normals[b + 2] as f64,
                ]
            };
            [rn(t[0]), rn(t[1]), rn(t[2])]
        } else {
            let fnrm =
                normalize(cross(sub(p[1], p[0]), sub(p[2], p[0]))).unwrap_or([0.0, 0.0, 1.0]);
            [fnrm, fnrm, fnrm]
        };
        out.push(PTri { p, n });
    }
    Some(out)
}

/// Store the f64 triangle list back to an f32 `Mesh` in the host's frame.
/// Per-triangle vertices (no sharing, no welding — #846); normals normalized
/// with the triangle's geometric normal as fallback.
pub(super) fn mesh_from_ptris(tris: &[PTri], template: &Mesh) -> Mesh {
    let mut positions = Vec::with_capacity(tris.len() * 9);
    let mut normals = Vec::with_capacity(tris.len() * 9);
    let mut indices = Vec::with_capacity(tris.len() * 3);
    for (i, t) in tris.iter().enumerate() {
        let face = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0])))
            .unwrap_or([0.0, 0.0, 1.0]);
        for v in 0..3 {
            positions.push(t.p[v][0] as f32);
            positions.push(t.p[v][1] as f32);
            positions.push(t.p[v][2] as f32);
            let n = normalize(t.n[v]).unwrap_or(face);
            normals.push(n[0] as f32);
            normals.push(n[1] as f32);
            normals.push(n[2] as f32);
        }
        let base = (i * 3) as u32;
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    template.reframed_like(positions, normals, indices, template.origin)
}
