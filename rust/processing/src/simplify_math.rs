// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Frame/matrix helpers for the demesher session (`simplify_session`):
//! Y-up <-> Z-up swaps matching the wasm boundary convention, affine 4x4
//! inversion for the placement chain, and a fallback normal rebuild. Split
//! from `simplify_session.rs` to keep it inside its `module_size_ratchet`
//! budget.

/// WebGL Y-up -> IFC Z-up (inverse of the boundary swap `[x, z, -y]`).
#[inline]
pub(crate) fn yup_to_zup(v: [f64; 3]) -> [f64; 3] {
    [v[0], -v[2], v[1]]
}

/// IFC Z-up -> WebGL Y-up (the boundary swap). `pub(crate)` for the sibling
/// `simplify_session_tests.rs` (split out for the module-size ratchet).
#[inline]
pub(crate) fn zup_to_yup(v: [f64; 3]) -> [f64; 3] {
    [v[0], v[2], -v[1]]
}

/// Undo the boundary's matrix conjugation `M' = S * M * S^T`
/// (`zero_copy::mesh::swap_zup_to_yup_mat4`): `M = S^T * M' * S`.
pub(crate) fn conjugate_yup_to_zup(m: &[f64; 16]) -> [f64; 16] {
    // S maps Z-up to Y-up: rows of the permutation with the sign flip.
    #[rustfmt::skip]
    const S: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, -1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    #[rustfmt::skip]
    const ST: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, -1.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    matmul_row_major(&matmul_row_major(&ST, m), &S)
}

pub(crate) fn matmul_row_major(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0; 16];
    for r in 0..4 {
        for c in 0..4 {
            let mut acc = 0.0;
            for k in 0..4 {
                acc += a[r * 4 + k] * b[k * 4 + c];
            }
            out[r * 4 + c] = acc;
        }
    }
    out
}

#[inline]
pub(crate) fn transform_point_row_major(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

/// Inverse of an affine row-major 4x4 (placement chains are affine: last row
/// [0,0,0,1]). `None` when the linear block is singular.
pub(crate) fn invert_affine_row_major(m: &[f64; 16]) -> Option<[f64; 16]> {
    let a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    let t = [m[3], m[7], m[11]];
    let det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6])
        + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if !det.is_finite() || det.abs() < 1e-24 {
        return None;
    }
    let inv_det = 1.0 / det;
    let inv = [
        (a[4] * a[8] - a[5] * a[7]) * inv_det,
        (a[2] * a[7] - a[1] * a[8]) * inv_det,
        (a[1] * a[5] - a[2] * a[4]) * inv_det,
        (a[5] * a[6] - a[3] * a[8]) * inv_det,
        (a[0] * a[8] - a[2] * a[6]) * inv_det,
        (a[2] * a[3] - a[0] * a[5]) * inv_det,
        (a[3] * a[7] - a[4] * a[6]) * inv_det,
        (a[1] * a[6] - a[0] * a[7]) * inv_det,
        (a[0] * a[4] - a[1] * a[3]) * inv_det,
    ];
    let it = [
        -(inv[0] * t[0] + inv[1] * t[1] + inv[2] * t[2]),
        -(inv[3] * t[0] + inv[4] * t[1] + inv[5] * t[2]),
        -(inv[6] * t[0] + inv[7] * t[1] + inv[8] * t[2]),
    ];
    Some([
        inv[0], inv[1], inv[2], it[0], inv[3], inv[4], inv[5], it[1], inv[6], inv[7], inv[8],
        it[2], 0.0, 0.0, 0.0, 1.0,
    ])
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
