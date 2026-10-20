// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared real box fixtures for integration and private report-contract tests.

use super::Mesh;

/// Axis-aligned box as a `Mesh`, each face subdivided `n`×`n`.
///
/// Triangle count is `12·n²`: `n = 1 → 12`, `n = 2 → 48`, `n = 4 → 192`. The
/// surface is identical for every `n` — only the tessellation changes — so any
/// quantity that varies across `n` is measuring the mesh, not the solid.
pub(super) fn box_mesh(lo: [f64; 3], hi: [f64; 3], n: usize) -> Mesh {
    assert!(n >= 1);
    let mut m = Mesh::new();
    let mut push = |p: [f64; 3]| -> u32 {
        let idx = (m.positions.len() / 3) as u32;
        m.positions.push(p[0] as f32);
        m.positions.push(p[1] as f32);
        m.positions.push(p[2] as f32);
        m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
        idx
    };
    for axis in 0..3usize {
        let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
        for (side, &w) in [lo[axis], hi[axis]].iter().enumerate() {
            for i in 0..n {
                for j in 0..n {
                    let fu = |k: usize| lo[u] + (hi[u] - lo[u]) * (k as f64) / (n as f64);
                    let fv = |k: usize| lo[v] + (hi[v] - lo[v]) * (k as f64) / (n as f64);
                    let corner = |cu: f64, cv: f64| {
                        let mut p = [0.0f64; 3];
                        p[axis] = w;
                        p[u] = cu;
                        p[v] = cv;
                        p
                    };
                    let a = push(corner(fu(i), fv(j)));
                    let b = push(corner(fu(i + 1), fv(j)));
                    let c = push(corner(fu(i + 1), fv(j + 1)));
                    let d = push(corner(fu(i), fv(j + 1)));
                    // Wind the low and high faces oppositely so the box is
                    // consistently outward-oriented.
                    if side == 0 {
                        m.indices.extend_from_slice(&[a, c, b, a, d, c]);
                    } else {
                        m.indices.extend_from_slice(&[a, b, c, a, c, d]);
                    }
                }
            }
        }
    }
    m
}

/// `box_mesh`, then every vertex mapped by the rotation `r` (row-major 3×3).
pub(super) fn rotated_box_mesh(lo: [f64; 3], hi: [f64; 3], n: usize, r: [[f64; 3]; 3]) -> Mesh {
    let mut m = box_mesh(lo, hi, n);
    for p in m.positions.chunks_exact_mut(3) {
        let v = [p[0] as f64, p[1] as f64, p[2] as f64];
        for k in 0..3 {
            p[k] = (r[k][0] * v[0] + r[k][1] * v[1] + r[k][2] * v[2]) as f32;
        }
    }
    m
}

/// The three tessellation levels every oracle sweeps: 12, 48 and 192 triangles.
pub(super) const TESSELLATIONS: [usize; 3] = [1, 2, 4];

/// Rotation by the exact Pythagorean angle `cos θ = 3/5, sin θ = 4/5` about Z.
///
/// The decimal entries are rounded binary64 values; the resulting mesh vertices
/// are rounded to f32 before the kernel reconciles them onto its snap grid.
pub(super) const ROT_Z_3_4_5: [[f64; 3]; 3] = [[0.6, -0.8, 0.0], [0.8, 0.6, 0.0], [0.0, 0.0, 1.0]];
