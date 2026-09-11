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
pub(super) fn coincident_planes(n_own: [f64; 3], n_face: [f64; 3]) -> bool {
    let d = dot3(n_own, n_face);
    2.0 * d * d >= dot3(n_own, n_own) * dot3(n_face, n_face)
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
