// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Helpers for the demesher session (`simplify_session`): a fallback normal
//! rebuild and the finite-placement guard. The affine inverse (one threshold,
//! D22), frame swaps and matrix products live in `ifc_lite_geometry::math`. Split
//! from `simplify_session.rs` to keep it inside its `module_size_ratchet`
//! budget.

use ifc_lite_geometry::math::frame::conjugate_yup_to_zup;

/// Undo the boundary's `S·M·Sᵀ` (`math::frame::conjugate_yup_to_zup`), or
/// `None` for a non-finite matrix. The old matmul spread any NaN/inf over the
/// whole matrix, so `affine_inverse` refused it as singular; the exact
/// signed permutation (D24) keeps it in its own slot, where a NaN translation
/// would invert "fine" and ship NaN positions. This keeps the refusal (#7772).
pub(crate) fn finite_yup_to_zup(m: &[f64; 16]) -> Option<[f64; 16]> {
    m.iter().all(|v| v.is_finite()).then(|| conjugate_yup_to_zup(m))
}

/// Area-weighted per-vertex normals for a simplified mesh whose input had no
/// (or mismatched) normals. Good enough for the render preview; the IFC
/// output omits normals anyway (consumers compute flat normals).
pub(crate) fn averaged_vertex_normals(positions: &[f32], indices: &[u32]) -> Vec<f32> {
    let n_verts = positions.len() / 3;
    let mut acc = vec![0.0f64; n_verts * 3];
    for tri in indices.chunks_exact(3) {
        let p = |i: u32| -> [f64; 3] {
            let i = i as usize * 3;
            [
                positions[i] as f64,
                positions[i + 1] as f64,
                positions[i + 2] as f64,
            ]
        };
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        // Cross product magnitude is 2x area — natural weighting.
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        for &i in tri {
            let base = i as usize * 3;
            acc[base] += n[0];
            acc[base + 1] += n[1];
            acc[base + 2] += n[2];
        }
    }
    let mut out = Vec::with_capacity(n_verts * 3);
    for chunk in acc.chunks_exact(3) {
        let len_sq = chunk[0] * chunk[0] + chunk[1] * chunk[1] + chunk[2] * chunk[2];
        if len_sq > 1e-24 {
            let inv = 1.0 / len_sq.sqrt();
            out.extend_from_slice(&[
                (chunk[0] * inv) as f32,
                (chunk[1] * inv) as f32,
                (chunk[2] * inv) as f32,
            ]);
        } else {
            out.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
    }
    out
}
