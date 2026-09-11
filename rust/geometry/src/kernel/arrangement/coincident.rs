// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The plane test behind regime 1 of the boolean classifier
//! (`classify::boolean_vids_components`): may a sub-triangle be classified as
//! lying ON a face of the other operand that its centroid was found on or
//! near?
//!
//! Split out of `classify.rs`, which is at its module-size budget, with issue
//! #4439.

use super::classify::dot3;

/// Are two raw (unnormalised) face normals within 45° of parallel — `cos² ≥ ½`,
/// evaluated as `2·(n₁·n₂)² ≥ |n₁|²·|n₂|²` so there is no sqrt, no division and
/// no normalisation: FMA-free f64 over the same products the callers already
/// form ⇒ byte-identical native == wasm.
///
/// Regime 1 classifies a sub-triangle as lying ON a coincident shared face of
/// the other operand and resolves it by NORMAL AGREEMENT. Coincidence is a
/// property of the two PLANES, and the centroid tests (`on_surface_tri`,
/// `near_on_surface_tri`) alone do not establish it: a sub-triangle need not
/// be anywhere near parallel to a face whose plane its centroid sits within
/// the band of. A genuine shared face — exactly coplanar, or a #1007 flush cap
/// left a few µm off a tilted plane by the per-axis snap — has `cos ≈ 1` (the
/// snap tilt over a ≥ 0.2 m face is < 1e-3 rad). A sub-triangle whose plane is
/// TRANSVERSAL to the covering face has no orientation to agree with, and
/// `dot > 0` then decides it on nothing. Issue #4439: a 23 µm-wide sliver of
/// an A face inside a thin notch, hugging the PERPENDICULAR B face it abuts
/// (`dot == 0` exactly), was kept as "not co-oriented" on a difference and
/// left the box open on an edge the exact ray-cast had already classified as
/// inside B. The #3353 `sweep_261` needle sits at 58° (`cos = 0.53`) to its
/// covering face and is the same defect (`issue_3353_vid_census_tests.rs`).
///
/// 45° is a definitely-not-coincident cutoff — three orders of magnitude from
/// any legitimate flush tilt — chosen as a clean power-of-two bound rather
/// than tuned to either case. A ZERO normal (an exactly degenerate
/// sub-triangle) passes: it has no plane to disagree with, so it keeps the
/// path it took before #4439. Extending that to NUMERICALLY zero normals (a
/// rounded collinear triple, transverse extent ≤ 2⁻³⁰ of the longest edge)
/// was measured on the corpus census and changed no host, so it is not done.
///
/// Both normals are first scaled by a power of two so their largest component
/// lies in `[0.5, 4)`. That scaling is EXACT (it only moves the exponent), so
/// the verdict is bit-for-bit the one the raw products give wherever those do
/// not under- or overflow — which is everywhere geometry is meaningful — and
/// stays correct where they do: the kernel boundary (`mesh_bridge`) accepts any
/// finite `f32`, and at ~1e38 m edge lengths the raw fourth-degree products
/// reach `inf`, where `inf >= inf` would call a 46° pair coincident; at the
/// other end a pair of ~1e-80 m normals flushes to `0 >= 0` and calls a
/// perpendicular pair coincident.
pub(super) fn coincident_planes(n_own: [f64; 3], n_face: [f64; 3]) -> bool {
    let (a, b) = (pow2_normalized(n_own), pow2_normalized(n_face));
    let d = dot3(a, b);
    2.0 * d * d >= dot3(a, a) * dot3(b, b)
}

/// `n` scaled by the power of two that puts its largest |component| in
/// `[0.5, 4)`; the zero vector (and anything non-finite) is returned as is. A
/// power-of-two scale is exact in IEEE 754 whenever the result is finite and
/// normal, which the clamp of the exponent field to `[1, 2046]` guarantees
/// for every finite input (a subnormal maximum is lifted to `< 2`, a maximum
/// at or above 2^1023 is brought to `< 4`).
fn pow2_normalized(n: [f64; 3]) -> [f64; 3] {
    let m = n[0].abs().max(n[1].abs()).max(n[2].abs());
    if m == 0.0 || !m.is_finite() {
        return n;
    }
    // Biased exponent of `m`: 0 for a subnormal, 2046 for the top binade.
    let e = (m.to_bits() >> 52) & 0x7ff;
    // 2^(1023 − e) has biased exponent 2046 − e; clamped to ≥ 1 so the scale
    // itself is a normal number and the scaled maximum stays below 4.
    let s = f64::from_bits((2046 - e).max(1) << 52);
    [n[0] * s, n[1] * s, n[2] * s]
}

#[cfg(test)]
mod tests {
    use super::coincident_planes;
    use crate::kernel::arrangement::classify::{cross3, sub_f64};

    /// A raw normal tilted `deg` degrees off +Z about the Y axis.
    fn tilted(deg: f64) -> [f64; 3] {
        let r = deg.to_radians();
        [r.sin(), 0.0, r.cos()]
    }

    #[test]
    fn parallel_and_antiparallel_faces_are_coincident_and_perpendicular_ones_are_not() {
        let z = [0.0, 0.0, 1.0];
        assert!(coincident_planes(z, [0.0, 0.0, 3.5]));
        assert!(coincident_planes(z, [0.0, 0.0, -0.25]));
        assert!(!coincident_planes(z, [1.0, 0.0, 0.0]));
        assert!(!coincident_planes(z, [0.0, -2.0, 0.0]));
    }

    #[test]
    fn the_cutoff_is_45_degrees_and_independent_of_either_magnitude() {
        for s in [1.0e-8, 1.0, 1.0e8] {
            let z = [0.0, 0.0, s];
            assert!(coincident_planes(z, tilted(44.0)), "44° at scale {s}");
            assert!(!coincident_planes(z, tilted(46.0)), "46° at scale {s}");
            // #3353 `sweep_261`: the needle sits 58° off its covering face.
            assert!(!coincident_planes(z, tilted(58.0)), "58° at scale {s}");
        }
    }

    /// The kernel boundary accepts any finite `f32`, so the raw fourth-degree
    /// products can over- or underflow; the exact power-of-two scaling must give
    /// the same 45° verdict at every finite magnitude, including mixed ones.
    #[test]
    fn the_verdict_survives_magnitudes_where_the_raw_products_overflow_or_underflow() {
        let scale = |v: [f64; 3], s: f64| [v[0] * s, v[1] * s, v[2] * s];
        let x = [1.0, 0.0, 0.0];
        let z = [0.0, 0.0, 1.0];
        for s in [1.0e-160, 1.0e-100, 1.0e100, 1.0e160, f64::MAX / 4.0, f64::MIN_POSITIVE / 8.0] {
            let zs = scale(z, s);
            assert!(coincident_planes(zs, scale(z, s)), "parallel at scale {s:e}");
            assert!(coincident_planes(zs, scale(tilted(44.0), s)), "44° at scale {s:e}");
            assert!(!coincident_planes(zs, scale(tilted(46.0), s)), "46° at scale {s:e}");
            assert!(!coincident_planes(zs, scale(x, s)), "perpendicular at scale {s:e}");
            // one operand huge, the other tiny (where the reciprocal is finite)
            if (1.0 / s).is_finite() {
                assert!(coincident_planes(zs, scale(z, 1.0 / s)), "parallel, mixed scales {s:e}");
                assert!(!coincident_planes(zs, scale(x, 1.0 / s)), "perpendicular, mixed scales {s:e}");
            }
        }
        // The raw form fails exactly there, which is why the scaling exists.
        let raw = |a: [f64; 3], b: [f64; 3]| {
            let d = super::dot3(a, b);
            2.0 * d * d >= super::dot3(a, a) * super::dot3(b, b)
        };
        assert!(raw(scale(z, 1.0e160), scale(tilted(46.0), 1.0e160)), "inf >= inf");
        assert!(raw(scale(z, 1.0e-160), scale(x, 1.0e-160)), "0 >= 0");
    }

    #[test]
    fn a_flush_cap_tilt_passes_and_a_zero_normal_keeps_the_old_path() {
        let z = [0.0, 0.0, 1.0];
        // #1007-class flush cap: the per-axis snap tilts a 0.2 m face by
        // < 1e-3 rad; that must stay a coincident face.
        assert!(coincident_planes(z, tilted(1.0e-3_f64.to_degrees())));
        // An exactly degenerate sub-triangle has no plane and is not re-decided
        // here (see the doc comment).
        assert!(coincident_planes([0.0, 0.0, 0.0], z));
    }

    /// Issue #4439: A's +Y face needle (the three vertices share their Y bit
    /// for bit, so the raw normal is exactly along +Y — 23 µm × 1.04 m)
    /// against B's +X face (raw normal `dy·dz` along +X). `dot == 0` exactly,
    /// which the sign test alone read as "not co-oriented" and kept.
    #[test]
    fn the_4439_needle_is_not_coincident_with_the_perpendicular_face_it_hugs() {
        let p = [
            [7.483367919921875, 8.65240478515625, 2.1023867130279541],
            [7.483344554901123, 8.65240478515625, 3.145187377929688],
            [7.483367919921875, 8.65240478515625, 3.143897294998169],
        ];
        let n_needle = cross3(sub_f64(p[1], p[0]), sub_f64(p[2], p[0]));
        assert_eq!((n_needle[0], n_needle[2]), (0.0, 0.0));
        assert!(n_needle[1] != 0.0, "a 23 µm sliver has a plane of its own");
        let n_b_xmax = [19.44, 0.0, 0.0];
        assert!(!coincident_planes(n_needle, n_b_xmax));
        assert!(!coincident_planes(n_b_xmax, n_needle));
    }
}
