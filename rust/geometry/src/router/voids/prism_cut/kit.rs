// SPDX-License-Identifier: MPL-2.0
//! Explicit component arithmetic retained for native/WASM identity.
pub(in crate::router::voids) use crate::math::v3::{V3, dot, sub, add, scale, cross, norm};
pub(in crate::router::voids) type V2 = [f64; 2];

// Prism exception: strict <1e-12 refusal and reciprocal multiplication.
#[inline]
pub(in crate::router::voids) fn normalize(a: V3) -> Option<V3> {
    let n = norm(a);
    if !n.is_finite() || n < 1.0e-12 {
        None
    } else {
        Some(scale(a, 1.0 / n))
    }
}
// Prism exception: retain this explicit component operation order.
#[inline]
pub(in crate::router::voids) fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}
// Prism cache keys preserve raw floating-point bits, including signed zero.
#[inline]
pub(in crate::router::voids) fn bits(p: V3) -> [u64; 3] {
    [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()]
}
