// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bridge between the pure-Rust kernel (which works on `Tri = [[f64;3];3]`) and
//! ifc-lite's `Mesh` (f32 positions/normals/indices) — the M6 integration
//! foundation. `subtract`/`union`/`intersection` here are what the
//! `ClippingProcessor` seam will eventually call.

use super::arrangement::{boolean, BoolOp, Tri};
use crate::mesh::Mesh;

/// `Mesh` → the kernel's triangle list (f32 → f64).
pub fn mesh_to_tris(m: &Mesh) -> Vec<Tri> {
    let vertex = |i: u32| {
        let b = (i as usize) * 3;
        [
            m.positions[b] as f64,
            m.positions[b + 1] as f64,
            m.positions[b + 2] as f64,
        ]
    };
    m.indices
        .chunks_exact(3)
        .map(|c| [vertex(c[0]), vertex(c[1]), vertex(c[2])])
        .collect()
}

fn face_normal(t: &Tri) -> [f32; 3] {
    let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    let n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 {
        [(n[0] / len) as f32, (n[1] / len) as f32, (n[2] / len) as f32]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// The kernel's triangle list → a `Mesh` (per-face flat normals, f64 → f32).
pub fn tris_to_mesh(tris: &[Tri]) -> Mesh {
    let mut m = Mesh::with_capacity(tris.len() * 3, tris.len() * 3);
    for t in tris {
        let n = face_normal(t);
        let base = (m.positions.len() / 3) as u32;
        for p in t {
            m.positions
                .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            m.normals.extend_from_slice(&n);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}

/// `host − cutter` as a `Mesh`.
pub fn subtract(host: &Mesh, cutter: &Mesh) -> Mesh {
    tris_to_mesh(&boolean(&mesh_to_tris(host), &mesh_to_tris(cutter), BoolOp::Difference))
}

/// `a ∪ b` as a `Mesh`.
pub fn union(a: &Mesh, b: &Mesh) -> Mesh {
    tris_to_mesh(&boolean(&mesh_to_tris(a), &mesh_to_tris(b), BoolOp::Union))
}

/// `a ∩ b` as a `Mesh`.
pub fn intersection(a: &Mesh, b: &Mesh) -> Mesh {
    tris_to_mesh(&boolean(&mesh_to_tris(a), &mesh_to_tris(b), BoolOp::Intersection))
}

#[cfg(test)]
mod tests {
    use super::super::arrangement::cube_mesh;
    use super::*;

    fn mesh_volume(m: &Mesh) -> f64 {
        let vertex = |i: u32| {
            let b = (i as usize) * 3;
            [
                m.positions[b] as f64,
                m.positions[b + 1] as f64,
                m.positions[b + 2] as f64,
            ]
        };
        m.indices
            .chunks_exact(3)
            .map(|c| {
                let (a, bb, cc) = (vertex(c[0]), vertex(c[1]), vertex(c[2]));
                let cr = [
                    bb[1] * cc[2] - bb[2] * cc[1],
                    bb[2] * cc[0] - bb[0] * cc[2],
                    bb[0] * cc[1] - bb[1] * cc[0],
                ];
                a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
            })
            .sum::<f64>()
            / 6.0
    }

    #[test]
    fn kernel_cuts_a_real_mesh() {
        // Round-trip through ifc-lite's Mesh: two cube meshes, subtract via the
        // kernel, and the result Mesh has the exact box−box volume.
        let host = tris_to_mesh(&cube_mesh(0.0, 2.0)); // vol 8
        let cutter = tris_to_mesh(&cube_mesh(1.0, 3.0)); // overlap [1,2]³ = 1
        let result = subtract(&host, &cutter);
        assert!(!result.indices.is_empty(), "subtract produced an empty mesh");
        let v = mesh_volume(&result);
        assert!((v - 7.0).abs() < 1e-3, "Mesh host−cutter volume = {v}, expected 7");
        // sanity: the round-tripped host mesh has volume 8
        assert!((mesh_volume(&host) - 8.0).abs() < 1e-4, "host round-trip volume wrong");
    }
}
