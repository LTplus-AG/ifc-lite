// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The IFC Z-up to WebGL Y-up frame, defined once.
//!
//! `S` maps `(x, y, z)` to `(x, z, -y)`; a proper rotation (det +1), so
//! `S⁻¹ = Sᵀ` maps `(x, y, z)` to `(x, -z, y)`.
//!
//! - **Points and vectors** swap components. The swap never folds the sign of
//!   zero: `-y` of `+0.0` is `-0.0`, in every copy on main.
//! - **Boxes** reverse min/max on the negated axis ([`aabb_zup_to_yup`]).
//! - **Matrices** are conjugated, `M' = S·M·Sᵀ`. Conjugating by a signed
//!   permutation moves each entry to `M'[r][c] = s(r)·s(c)·M[p(r)][p(c)]`, so it
//!   is done as exactly that, with `+ 0.0` folding the sign of zero. For every
//!   finite input this is bit-equal to the `S·M·Sᵀ` matmul (each matmul output
//!   is `0.0 + .. + (±m)`, which is `±m` with every zero positive). It is
//!   storage-agnostic: conjugation commutes with transposition, so it applies to
//!   row- and column-major arrays alike. A non-finite entry stays in its own
//!   slot instead of spreading `NaN` across a row.

use super::mat4::{M3, M4};
use std::ops::Neg;

/// `S` as a row-major 4x4 (linear part only).
pub const ZUP_TO_YUP: M4 = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, -1.0, 0.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];
/// `Sᵀ`.
pub const YUP_TO_ZUP: M4 = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 0.0, -1.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];

/// `(x, y, z)` to `(x, z, -y)`. Generic so f32 vertex buffers and f64 origins
/// share it; it monomorphises in the caller and always inlines.
#[inline]
pub fn zup_to_yup<T: Copy + Neg<Output = T>>(v: [T; 3]) -> [T; 3] {
    [v[0], v[2], -v[1]]
}

/// `(x, y, z)` to `(x, -z, y)`, the inverse of [`zup_to_yup`].
#[inline]
pub fn yup_to_zup<T: Copy + Neg<Output = T>>(v: [T; 3]) -> [T; 3] {
    [v[0], -v[2], v[1]]
}

/// [`zup_to_yup`] over a flat `x, y, z, ...` buffer. Only complete triplets are
/// rewritten; a 1-2 float tail is left alone.
#[inline]
pub fn zup_to_yup_in_place(buf: &mut [f32]) {
    for c in buf.chunks_exact_mut(3) {
        let (y, z) = (c[1], c[2]);
        c[1] = z;
        c[2] = -y;
    }
}

/// Swap an AABB `[minx, miny, minz, maxx, maxy, maxz]` from Z-up to Y-up.
/// Swapping `min`/`max` per component is WRONG: negating Y flips which corner
/// is the min along the new Z, so the new Z range is `[-maxY, -minY]`.
///
/// Generic so the f32 local bounds and the f64 world AABBs share one reversal.
#[inline]
pub fn aabb_zup_to_yup<T: Copy + Neg<Output = T>>(b: [T; 6]) -> [T; 6] {
    let [min_x, min_y, min_z, max_x, max_y, max_z] = b;
    [min_x, min_z, -max_y, max_x, max_z, -min_y]
}

/// `S·M·Sᵀ` for a Z-up matrix, as a signed permutation (see the module docs).
#[inline]
pub fn conjugate_zup_to_yup(m: &M4) -> M4 {
    conjugate4(m, [0, 2, 1, 3], [1.0, 1.0, -1.0, 1.0])
}

/// `Sᵀ·M·S`, the inverse of [`conjugate_zup_to_yup`].
#[inline]
pub fn conjugate_yup_to_zup(m: &M4) -> M4 {
    conjugate4(m, [0, 2, 1, 3], [1.0, -1.0, 1.0, 1.0])
}

/// [`conjugate_zup_to_yup`] for a 3x3 rotation.
#[inline]
pub fn conjugate3_zup_to_yup(m: &M3) -> M3 {
    let (p, s) = ([0usize, 2, 1], [1.0, 1.0, -1.0]);
    std::array::from_fn(|i| {
        let (r, c) = (i / 3, i % 3);
        s[r] * s[c] * m[p[r] * 3 + p[c]] + 0.0
    })
}

#[inline]
fn conjugate4(m: &M4, p: [usize; 4], s: [f64; 4]) -> M4 {
    std::array::from_fn(|i| {
        let (r, c) = (i / 4, i % 4);
        s[r] * s[c] * m[p[r] * 4 + p[c]] + 0.0
    })
}
