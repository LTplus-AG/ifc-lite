// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The two surface channels behind the geometry fingerprint — split out of
//! `geom_hash.rs` to keep it under the house 400-line rule.
//!
//! ## Why the fingerprint is not over triangles
//!
//! A triangulator's DIAGONAL CHOICE is not a shape:
//! `tests/triangulation_invariance.rs` says outright that "nothing downstream
//! is entitled to depend on which one it gets". A fingerprint over triangles
//! does depend on it — a flat quad re-split along its other diagonal is a
//! different triangle set, and hashed differently. A triangle-based fingerprint
//! therefore reports an element as reshaped even when its vertices, surface,
//! area, centroid and bounding box are all identical, because one coplanar quad
//! was cut the other way.
//!
//! So [`super::GeometryHasher`] hashes a SURFACE instead, and the two things it
//! hashes are computed here: the identity of the PLANE a triangle lies in
//! together with that triangle's exact integer area ([`plane_of`]), and the
//! hash of one distinct quantized vertex ([`vertex_hash`]).
//!
//! Everything here is exact integer arithmetic over already-quantized
//! coordinates. That is the point: an area or a normal recomputed in floating
//! point would land on either side of a rounding boundary depending on how the
//! surface happened to be cut, which is the very dependency being removed.

use super::{fold_i64, mix64};

/// Fold one wide signed integer as its two 64-bit halves. Plane coefficients
/// are exact `i128` products of quantized coordinates and do not fit `i64`.
#[inline]
fn fold_i128(acc: u64, v: i128) -> u64 {
    let bits = v as u128;
    fold_i64(fold_i64(acc, bits as u64 as i64), (bits >> 64) as u64 as i64)
}

/// The cross product of two edges of a quantized triangle — twice its area
/// vector, exactly, in `i128` so the quantized-coordinate products cannot
/// overflow. `None` when the three corners are colinear (which includes the
/// coincident case), i.e. exactly when the triangle is degenerate after
/// quantization and carries no shape signal.
pub(super) fn edge_cross(tri: &[[i64; 3]; 3]) -> Option<[i128; 3]> {
    let e1 = [
        tri[1][0] as i128 - tri[0][0] as i128,
        tri[1][1] as i128 - tri[0][1] as i128,
        tri[1][2] as i128 - tri[0][2] as i128,
    ];
    let e2 = [
        tri[2][0] as i128 - tri[0][0] as i128,
        tri[2][1] as i128 - tri[0][1] as i128,
        tri[2][2] as i128 - tri[0][2] as i128,
    ];
    let cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    (cross != [0, 0, 0]).then_some(cross)
}

/// Greatest common divisor, Euclid. `gcd(x, 0) == x`, so a normal with zero
/// components (every axis-aligned face) reduces correctly.
#[inline]
fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a
}

/// The exact plane a quantized triangle lies in, and its area weight.
///
/// `cross` is the integer cross product of two of the triangle's edges, so it
/// is `g * n` for the primitive (component-gcd-reduced) integer normal `n` and
/// a positive integer `g`. Reducing to `n` makes the key equal for every
/// triangle in the plane whatever its size, and `g` is then twice the
/// triangle's area in units of `|n|` — the same unit for every triangle in that
/// plane, so summing `g` per plane gives that plane's total area exactly, in
/// integers, with no float rounding anywhere.
///
/// The sign is canonicalised (first non-zero component positive) so a plane and
/// its opposite orientation key the same: winding is not shape.
pub(super) struct TrianglePlane {
    pub(super) key: u64,
    /// Twice the triangle's area, in units of `|n|`. `> 0` for any triangle
    /// with a non-zero `cross`.
    pub(super) weight: u128,
}

/// Key the plane of a non-degenerate quantized triangle. `cross` must be
/// non-zero; `point` is any corner of the triangle (all give the same key).
pub(super) fn plane_of(cross: [i128; 3], point: &[i64; 3]) -> TrianglePlane {
    let weight = gcd(
        gcd(cross[0].unsigned_abs(), cross[1].unsigned_abs()),
        cross[2].unsigned_abs(),
    );
    let g = weight as i128;
    let mut n = [cross[0] / g, cross[1] / g, cross[2] / g];
    // Canonical sign: first non-zero component positive. `cross` is non-zero,
    // so some component is.
    if n.iter().find(|c| **c != 0).is_some_and(|c| *c < 0) {
        n = [-n[0], -n[1], -n[2]];
    }
    // Plane offset. Constant across the plane for the canonicalised `n`, and
    // computed after the sign flip so both orientations agree on it.
    let d = n[0] * point[0] as i128 + n[1] * point[1] as i128 + n[2] * point[2] as i128;

    let mut h = 0x5bd1_e995_u64; // arbitrary non-zero seed
    for c in n {
        h = fold_i128(h, c);
    }
    TrianglePlane { key: mix64(fold_i128(h, d)), weight }
}

/// Hash one distinct quantized vertex, for the commutative vertex-set sum.
#[inline]
pub(super) fn vertex_hash(v: &[i64; 3]) -> u64 {
    let mut h = 0x27d4_eb2f_u64; // arbitrary non-zero seed, distinct from the plane seed
    for c in v {
        h = fold_i64(h, *c);
    }
    mix64(h)
}
