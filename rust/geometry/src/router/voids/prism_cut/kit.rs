// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The prism cut's small f64 vector kit: explicit component arithmetic, no
//! nalgebra matrix products, so no FMA can break native == wasm identity.
//!
//! F2a prism-kit exception (#7781 §3 row 10). `normalize`, `lerp` and `bits`
//! stay local. `normalize` refuses a length strictly below `1e-12` and
//! multiplies by the reciprocal; `math::v3::normalize` refuses `<= min_len`
//! and divides each component, so swapping it would move the last bit of
//! every unit vector the cut derives. `lerp` and `bits` have no `math::v3`
//! twin. `V2` is a ROUTER-7 site, moved as-is (no `math::v2` swap).

// ─────────────────────────── small f64 vector kit ───────────────────────────
// Explicit component arithmetic (no nalgebra matrix products) so no FMA can
// sneak in and break native==wasm byte identity.

pub(in crate::router::voids) type V3 = [f64; 3];
pub(super) type V2 = [f64; 2];

#[inline]
pub(in crate::router::voids) fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub(in crate::router::voids) fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub(in crate::router::voids) fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub(in crate::router::voids) fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
pub(in crate::router::voids) fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
pub(in crate::router::voids) fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
pub(in crate::router::voids) fn normalize(a: V3) -> Option<V3> {
    let n = norm(a);
    if !n.is_finite() || n < 1.0e-12 {
        None
    } else {
        Some(scale(a, 1.0 / n))
    }
}
#[inline]
pub(in crate::router::voids) fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}
#[inline]
pub(in crate::router::voids) fn bits(p: V3) -> [u64; 3] {
    [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()]
}
