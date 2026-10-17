// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 3-vectors over `[f64; 3]`. Every function is FMA-free with the op order
//! written out; see the [module conventions](super).

/// A 3-vector.
pub type V3 = [f64; 3];

#[inline]
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

/// `a0*b0 + a1*b1 + a2*b2`, left to right, never fused.
#[inline]
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Right-handed cross product, each component `x*y - z*w` unfused.
#[inline]
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Euclidean length, `dot(a, a).sqrt()`. (Not `hypot`: the two differ in the
/// last bit, and every site on main uses this spelling.)
#[inline]
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

/// Distance, `norm(sub(a, b))`. Bit-equal to the `powi(2)` spelling: `powi(x, 2)`
/// lowers to `x * x`.
#[inline]
pub fn dist(a: V3, b: V3) -> f64 {
    norm(sub(a, b))
}

/// `v / |v|`, or `None` when the length is not finite or is `<= min_len`.
///
/// The threshold is the caller's: pass `0.0` to refuse only a zero (or
/// non-finite) vector, or a scale-appropriate epsilon. A NaN component gives a
/// NaN length and so `None`. Each caller's degenerate fallback (zero vector,
/// `+Z`, the input itself) is an explicit `.unwrap_or(..)` at the call site.
/// Divides each component (not a reciprocal multiply), as every site does.
#[inline]
pub fn normalize(v: V3, min_len: f64) -> Option<V3> {
    let len = norm(v);
    if !len.is_finite() || len <= min_len {
        return None;
    }
    Some([v[0] / len, v[1] / len, v[2] / len])
}

/// The unnormalised triangle normal `cross(b - a, c - a)`; its length is twice
/// the triangle's area.
#[inline]
pub fn tri_normal(a: V3, b: V3, c: V3) -> V3 {
    cross(sub(b, a), sub(c, a))
}

/// Flip `n` so its largest-magnitude component is positive, so a face and its
/// antipodal opposite collapse onto one direction. Ties break x, y, z. A NaN
/// component never wins a comparison, and `-0.0 < 0.0` is false, so neither
/// flips the vector.
///
/// The same rule as clash's `canonical` (`rust/clash/src/canonical.rs`), which
/// is TS-parity-locked and so cannot be shared; `canonical_parity_tests` pins
/// the two together bit for bit.
#[inline]
pub fn canonical(n: V3) -> V3 {
    let (ax, ay, az) = (n[0].abs(), n[1].abs(), n[2].abs());
    let mut idx = 0usize;
    if ay > ax && ay >= az {
        idx = 1;
    } else if az > ax && az > ay {
        idx = 2;
    }
    if n[idx] < 0.0 {
        [-n[0], -n[1], -n[2]]
    } else {
        n
    }
}
