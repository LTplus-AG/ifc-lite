// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Row-major 4x4 matrices over `[f64; 16]` (`m[r * 4 + c]`), plus exact bridges
//! to `nalgebra::Matrix4<f64>` and the f32 boundary casts.

use super::v3::V3;
use nalgebra::Matrix4;

/// A row-major 4x4 matrix.
pub type M4 = [f64; 16];
/// A row-major 3x3 matrix.
pub type M3 = [f64; 9];

/// The determinant magnitude under which [`affine_inverse`] refuses a matrix
/// (a length^3 quantity). F2c moves this to `math::tol`.
pub const SINGULAR_DET_EPS: f64 = 1e-18;

/// The identity.
pub const IDENTITY: M4 = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];

/// `a . b`. Each entry accumulates from `0.0` over `k = 0..4`, so an all-zero
/// dot product is `+0.0`; this is the spelling export, processing, wasm and
/// the server already share.
#[inline]
pub fn mul(a: &M4, b: &M4) -> M4 {
    let mut out = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[r * 4 + k] * b[k * 4 + c];
            }
            out[r * 4 + c] = s;
        }
    }
    out
}

/// `m` applied to the point `p` (translation included; the affine last row is
/// not read).
#[inline]
pub fn transform_point(m: &M4, p: V3) -> V3 {
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

/// The linear part of `m` applied to `v` (no translation).
///
/// On a **column-major** array this computes `Mᵀ·v`: the ROWS of the row-major
/// reading are the COLUMNS of the matrix. That identity is how the site-local
/// frame applies an inverse rotation with the same op order.
#[inline]
pub fn transform_vector(m: &M4, v: V3) -> V3 {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
        m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
    ]
}

/// The 3x3 `r` applied to `v`.
#[inline]
pub fn apply3(r: &M3, v: V3) -> V3 {
    [
        r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
        r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
        r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
    ]
}

/// Swap rows and columns. Moves values only, so it is exact (and sign-of-zero
/// preserving).
#[inline]
pub fn transpose(m: &M4) -> M4 {
    [
        m[0], m[4], m[8], m[12], //
        m[1], m[5], m[9], m[13], //
        m[2], m[6], m[10], m[14], //
        m[3], m[7], m[11], m[15],
    ]
}

/// A pure translation by `t`.
#[inline]
pub fn translation(t: V3) -> M4 {
    [
        1.0, 0.0, 0.0, t[0], //
        0.0, 1.0, 0.0, t[1], //
        0.0, 0.0, 1.0, t[2], //
        0.0, 0.0, 0.0, 1.0,
    ]
}

/// Inverse of an AFFINE row-major matrix (last row `[0,0,0,1]`, which is not
/// read): the upper 3x3 by cofactors, the translation by `-R⁻¹·t`.
///
/// `None` iff the 3x3 determinant is not finite or `abs(det) <
/// SINGULAR_DET_EPS`, so a NaN placement is refused rather than inverted to
/// NaN.
#[inline]
pub fn affine_inverse(m: &M4) -> Option<M4> {
    let a = m[0]; let b = m[1]; let c = m[2];
    let d = m[4]; let e = m[5]; let f = m[6];
    let g = m[8]; let h = m[9]; let i = m[10];
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if !det.is_finite() || det.abs() < SINGULAR_DET_EPS {
        return None;
    }
    let inv_det = 1.0 / det;
    // Inverse of the 3x3 (row-major) via the transposed cofactor matrix.
    let r = [
        (e * i - f * h) * inv_det,
        (c * h - b * i) * inv_det,
        (b * f - c * e) * inv_det,
        (f * g - d * i) * inv_det,
        (a * i - c * g) * inv_det,
        (c * d - a * f) * inv_det,
        (d * h - e * g) * inv_det,
        (b * g - a * h) * inv_det,
        (a * e - b * d) * inv_det,
    ];
    let (tx, ty, tz) = (m[3], m[7], m[11]);
    // Translation of the inverse: -R⁻¹ · t.
    let it = [
        -(r[0] * tx + r[1] * ty + r[2] * tz),
        -(r[3] * tx + r[4] * ty + r[5] * tz),
        -(r[6] * tx + r[7] * ty + r[8] * tz),
    ];
    Some([
        r[0], r[1], r[2], it[0], //
        r[3], r[4], r[5], it[1], //
        r[6], r[7], r[8], it[2], //
        0.0, 0.0, 0.0, 1.0,
    ])
}

/// Row-major f64 to the **column-major** `[f32; 16]` glTF and GPU uploads
/// expect. The only f64 to f32 point besides [`to_f32`].
#[inline]
pub fn to_col_major_f32(m: &M4) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[c * 4 + r] = m[r * 4 + c] as f32;
        }
    }
    out
}

/// Elementwise f64 to f32, layout unchanged (row-major stays row-major).
#[inline]
pub fn to_f32(m: &M4) -> [f32; 16] {
    std::array::from_fn(|i| m[i] as f32)
}

/// nalgebra to row-major (the `InstanceMeta` convention).
#[inline]
pub fn from_na(m: &Matrix4<f64>) -> M4 {
    [
        m[(0, 0)], m[(0, 1)], m[(0, 2)], m[(0, 3)],
        m[(1, 0)], m[(1, 1)], m[(1, 2)], m[(1, 3)],
        m[(2, 0)], m[(2, 1)], m[(2, 2)], m[(2, 3)],
        m[(3, 0)], m[(3, 1)], m[(3, 2)], m[(3, 3)],
    ]
}

/// Row-major to nalgebra. Exact inverse of [`from_na`].
#[inline]
pub fn to_na(m: &M4) -> Matrix4<f64> {
    Matrix4::from_row_slice(m)
}

/// nalgebra's own **column-major** storage as an array: the layout of the
/// decoder's placement-transform memo, and bit-for-bit what
/// `Matrix4::from_column_slice` reads back.
#[inline]
pub fn col_major_array(m: &Matrix4<f64>) -> [f64; 16] {
    *m.as_slice()
        .first_chunk::<16>()
        .expect("Matrix4<f64> as_slice is exactly 16 elements")
}
