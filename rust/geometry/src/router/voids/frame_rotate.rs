// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rotating a mesh into and out of a host's own placement frame (the
//! parametric rect-cut path), with an explicit non-FMA dot product.

use crate::{Mesh, Point3};
use nalgebra::Matrix3;

// ── Parametric placement-frame cut helpers (see `try_param_rect_cut`). ───────────

/// Rotate `(x,y,z)` by the orthonormal 3×3 `r` with an explicit, non-FMA dot product
/// so the result is bit-identical native==wasm (the byte-identity contract forbids the
/// fused-multiply-add `nalgebra`'s matrix product may emit).
#[inline]
pub(super) fn rotate_point(r: &Matrix3<f64>, x: f64, y: f64, z: f64) -> [f64; 3] {
    [
        r[(0, 0)] * x + r[(0, 1)] * y + r[(0, 2)] * z,
        r[(1, 0)] * x + r[(1, 1)] * y + r[(1, 2)] * z,
        r[(2, 0)] * x + r[(2, 1)] * y + r[(2, 2)] * z,
    ]
}

/// Index of the smallest half-extent (the wall thickness / penetration axis).
/// The first minimum wins a tie; a NaN half-extent is never the minimum
/// unless all three are NaN (ROUTER-30, #7674: this was
/// `partial_cmp(..).unwrap()`, which aborts on NaN).
pub(super) fn thin_axis(half: &[f64; 3]) -> usize {
    (0..3)
        .min_by(|&a, &b| crate::cmp_f64_nan_last(half[a], half[b]))
        .unwrap_or(0)
}

/// If `m` is a signed permutation matrix (each row one entry ≈±1, the rest ≈0, with
/// distinct dominant columns), return the per-row `(source-column, sign)` map; else
/// `None`. Used to align an opening's axes with the host frame.
pub(super) fn signed_permutation_map(m: &Matrix3<f64>, tol: f64) -> Option<[(usize, f64); 3]> {
    let mut out = [(0usize, 1.0f64); 3];
    let mut used = [false; 3];
    for i in 0..3 {
        let (mut best, mut best_abs, mut second) = (0usize, 0.0, 0.0);
        for j in 0..3 {
            let a = m[(i, j)].abs();
            if a > best_abs {
                second = best_abs;
                best_abs = a;
                best = j;
            } else if a > second {
                second = a;
            }
        }
        if best_abs < 1.0 - tol || second > tol || used[best] {
            return None;
        }
        used[best] = true;
        out[i] = (best, m[(i, best)].signum());
    }
    Some(out)
}

/// Rotate a world mesh into frame F (`v_F = Rᵀ(v − center)`); small coords. Normals are
/// dropped (the cellular cut recomputes per-face flat normals).
pub(super) fn rotate_mesh_into_frame(mesh: &Mesh, rt: &Matrix3<f64>, center: &Point3<f64>) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for c in mesh.positions.chunks_exact(3) {
        let p = rotate_point(
            rt,
            c[0] as f64 - center.x,
            c[1] as f64 - center.y,
            c[2] as f64 - center.z,
        );
        positions.push(p[0] as f32);
        positions.push(p[1] as f32);
        positions.push(p[2] as f32);
    }
    // A frame-transformed cut intermediate is not an instanceable occurrence,
    // and is pre-placement (issue #1474 fields don't apply here either).
    let normals = vec![0.0; positions.len()];
    mesh.reframed_like(positions, normals, mesh.indices.clone(), [0.0; 3])
}

/// Rotate a frame-F mesh into a LOCAL-FRAME world mesh: positions are `R·v_F` (small,
/// near origin — NOT shifted by `center`) and `origin = center`, so `world = origin +
/// position` for the renderer. Keeping positions small is what makes the cut survive
/// f32 storage + `clean_degenerate` at building/national-grid magnitude (a world-coord
/// store there erodes opening seams into holes — see `Mesh::clean_degenerate`).
pub(super) fn rotate_mesh_from_frame(mesh: &Mesh, r: &Matrix3<f64>, center: &Point3<f64>) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for c in mesh.positions.chunks_exact(3) {
        let p = rotate_point(r, c[0] as f64, c[1] as f64, c[2] as f64);
        positions.push(p[0] as f32);
        positions.push(p[1] as f32);
        positions.push(p[2] as f32);
    }
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for c in mesh.normals.chunks_exact(3) {
        let p = rotate_point(r, c[0] as f64, c[1] as f64, c[2] as f64);
        normals.push(p[0] as f32);
        normals.push(p[1] as f32);
        normals.push(p[2] as f32);
    }
    // COMPOSE the input's own origin rather than assigning over it, and ROTATE
    // it first: `mesh` is in frame F, so its origin is a frame-F offset. A
    // nested local-frame cut returns a non-zero origin here and assigning would
    // drop it. A no-op for the origin-0 callers.
    let o = rotate_point(r, mesh.origin[0], mesh.origin[1], mesh.origin[2]);
    // A frame-transformed cut intermediate is not an instanceable occurrence,
    // and is pre-placement (issue #1474 fields don't apply here either).
    let origin = [center.x + o[0], center.y + o[1], center.z + o[2]];
    mesh.reframed_like(positions, normals, mesh.indices.clone(), origin)
}

