// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public predicate dispatch over `ImplicitPoint` configurations.
//!
//! M1 increment 1 implements the all-explicit and the LPI-first-argument
//! `orient3d` configurations against the exact (BigRational) tier. The faster
//! interval/expansion/semi-static tiers, the remaining implicit-argument
//! positions, the TPI cases, and indirect `orient2d` land in later increments —
//! each verified `≡` the exact tier here.

use super::rational;
use super::{ImplicitPoint, Sign};

/// Exact `orient3d` over a mix of explicit + implicit points.
pub fn orient3d(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, d: &ImplicitPoint) -> Sign {
    use ImplicitPoint::{Explicit, Lpi};
    match (a, b, c, d) {
        (Explicit(a), Explicit(b), Explicit(c), Explicit(d)) => {
            // Explicit fast path: Shewchuk adaptive predicate (FMA-free, exact sign).
            Sign::from_f64(geometry_predicates::orient3d(*a, *b, *c, *d))
        }
        (Lpi(l), Explicit(b), Explicit(c), Explicit(d)) => rational::lpi_orient3d(l, *b, *c, *d),
        _ => unimplemented!(
            "kernel::orient3d: this implicit-point configuration lands in a later M1 increment"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{rational, Lpi};
    use super::{orient3d, ImplicitPoint, Sign};

    fn e(p: [f64; 3]) -> ImplicitPoint {
        ImplicitPoint::Explicit(p)
    }

    /// Adversarial explicit-orient3d configurations (coplanar, building-scale
    /// off-plane, near-coincident large coords, sub-mm + mirrored tetra).
    fn battery() -> Vec<[[f64; 3]; 4]> {
        vec![
            [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 0.]], // coplanar -> 0
            [[0., 0., 12.3456789], [10., 0., 12.3456789], [0., 7., 12.3456789], [3.3, 2.1, 12.3456789 + 1e-9]],
            [[0., 0., 12.3456789], [10., 0., 12.3456789], [0., 7., 12.3456789], [3.3, 2.1, 12.3456789 - 1e-9]],
            [[1e7, 1e7, 0.], [1e7 + 1., 1e7, 0.], [1e7, 1e7 + 1., 0.], [1e7 + 0.5, 1e7 + 0.5, 1e-7]],
            [[0., 0., 0.], [1., 2., 3.], [-2., 1., 0.5], [0.5, 0.5, 0.5]],
            [[0., 0., 0.], [1., 1., 1.], [2., 2., 2.], [5., 1., 9.]], // collinear base -> 0
            [[0., 0., 0.], [1e-4, 0., 0.], [0., 1e-4, 0.], [0., 0., 1e-4]],
            [[0., 0., 0.], [0., 1e-4, 0.], [1e-4, 0., 0.], [0., 0., 1e-4]],
            [[-3., 2., 5.], [7., -1., 2.], [4., 4., -6.], [1.5, 0.0, 0.25]],
        ]
    }

    /// LPI cases: (line PQ ∩ plane RST), plus a query triangle (p2,p3,p4).
    fn lpi_cases() -> Vec<(Lpi, [f64; 3], [f64; 3], [f64; 3])> {
        vec![
            // vertical line ∩ z=0 plane -> (0.3,0.3,0); query triangle at z=1 (LPI below)
            (
                Lpi { p: [0.3, 0.3, -1.], q: [0.3, 0.3, 1.], r: [0., 0., 0.], s: [2., 0., 0.], t: [0., 2., 0.] },
                [0., 0., 1.], [1., 0., 1.], [0., 1., 1.],
            ),
            // same LPI, query triangle at z=-1 (LPI above)
            (
                Lpi { p: [0.3, 0.3, -1.], q: [0.3, 0.3, 1.], r: [0., 0., 0.], s: [2., 0., 0.], t: [0., 2., 0.] },
                [0., 0., -1.], [1., 0., -1.], [0., 1., -1.],
            ),
            // tilted line ∩ tilted plane
            (
                Lpi { p: [1., 1., 0.], q: [2., 3., 4.], r: [0., 0., 1.], s: [3., 0., 2.], t: [0., 3., 2.] },
                [5., -2., 0.], [-1., 4., 3.], [2., 2., -3.],
            ),
            // building-scale
            (
                Lpi { p: [12.3, 4.5, -2.], q: [12.3, 4.5, 6.], r: [0., 0., 3.1], s: [20., 0., 3.1], t: [0., 9., 3.1] },
                [10., 10., 10.], [-5., 0., 0.], [0., -5., 8.],
            ),
        ]
    }

    #[test]
    fn explicit_orient3d_matches_rational_oracle() {
        for cfg in battery() {
            let [a, b, c, d] = cfg;
            let fast = orient3d(&e(a), &e(b), &e(c), &e(d));
            let oracle = rational::orient3d_exact(a, b, c, d);
            assert_eq!(fast, oracle, "explicit orient3d != rational oracle on {cfg:?}");
        }
    }

    #[test]
    fn lpi_orient3d_matches_materialised_point() {
        // The homogenised LPI-orient3d must equal the direct orient3d on the
        // exact materialised λ/d point — proving the Λ′ + sign(d)-flip.
        for (l, p2, p3, p4) in lpi_cases() {
            let homog = rational::lpi_orient3d(&l, p2, p3, p4);
            let direct = rational::orient3d_exact_pt(&rational::lpi_point(&l), p2, p3, p4);
            assert_eq!(homog, direct, "LPI homogenisation/flip wrong for {l:?}");
            // sanity: these are non-degenerate, so the sign is definite
            assert_ne!(homog, Sign::Zero, "test LPI case should be off-plane: {l:?}");
        }
    }

    #[test]
    fn lpi_orient3d_sign_invariant_to_plane_winding() {
        // Re-wind the plane (swap S,T): flips sign(d) but the point + geometry
        // are identical, so the per-config flip must yield the SAME sign. This
        // is the test that catches a missing/extra `sign(d)` flip.
        for (l, p2, p3, p4) in lpi_cases() {
            let l_rewound = Lpi { s: l.t, t: l.s, ..l };
            assert_eq!(
                rational::lpi_orient3d(&l, p2, p3, p4),
                rational::lpi_orient3d(&l_rewound, p2, p3, p4),
                "LPI-orient3d sign changed under plane re-winding — the sign(d) flip is wrong/missing"
            );
        }
    }

    #[test]
    fn assemble_sign_per_config_flip() {
        use super::super::assemble_sign;
        // odd #negatives -> flip; even -> no flip; any zero -> Zero.
        assert_eq!(assemble_sign(Sign::Positive, &[Sign::Negative]), Sign::Negative);
        assert_eq!(assemble_sign(Sign::Positive, &[Sign::Negative, Sign::Negative]), Sign::Positive);
        assert_eq!(assemble_sign(Sign::Negative, &[Sign::Positive]), Sign::Negative);
        assert_eq!(assemble_sign(Sign::Positive, &[Sign::Zero]), Sign::Zero);
        assert_eq!(assemble_sign(Sign::Positive, &[]), Sign::Positive);
    }
}
