// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Degenerate-input tests for the exact BigRational tier. Split into a `_tests.rs`
//! file so `rational.rs` stays under the module-size ratchet.

use super::*;
use num_traits::ToPrimitive;

// Line pq lies in plane rst (d == 0): the exact λ/d is undefined. Pre-fix the
// BigRational division panicked ("denominator == 0"); it must now return the
// finite segment midpoint.
#[test]
fn lpi_point_parallel_line_plane_is_finite_not_panic() {
    let l = Lpi {
        p: [0.0, 0.0, 0.0],
        q: [1.0, 0.0, 0.0],
        r: [0.0, 0.0, 0.0],
        s: [1.0, 0.0, 0.0],
        t: [0.0, 1.0, 0.0],
    };
    let pt = lpi_point(&l);
    assert_eq!(pt[0], BigRational::from_float(0.5).unwrap());
    assert!(pt.iter().all(|c| c.to_f64().unwrap().is_finite()));
}

// Three parallel planes never meet at a point (d == 0): must fall back to a
// finite centroid, not divide by zero.
#[test]
fn tpi_point_parallel_planes_is_finite_not_panic() {
    let plane_at = |z: f64| [[0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]];
    let t = Tpi {
        planes: [plane_at(0.0), plane_at(1.0), plane_at(2.0)],
    };
    let pt = tpi_point(&t);
    assert!(pt.iter().all(|c| c.to_f64().unwrap().is_finite()));
}

// #7292: analytic determinant signs cover the shared exact tier directly,
// including products that underflow/overflow f64. No floating determinant or
// wrapper/helper equality is used as the oracle.
#[test]
fn issue_7292_exact_orientation_preserves_analytic_signs_across_scales() {
    for exponent in [-400, 0, 400] {
        let s = 2.0_f64.powi(exponent);
        let [a, b, c, d] = [
            [0.0; 3], [s, 0.0, 0.0], [0.0, s, 0.0], [0.0, 0.0, s],
        ];
        // Shewchuk convention: det(a-d,b-d,c-d) = -s^3.
        assert_eq!(orient3d_exact(a, b, c, d), Sign::Negative);
        assert_eq!(orient3d_exact(a, c, b, d), Sign::Positive);
        assert_eq!(orient3d_exact(a, b, c, [s, s, 0.0]), Sign::Zero);
        // These power-of-two shifts and their one-s increments are all
        // exactly representable; a common translation leaves the determinant.
        let shift = [8.0 * s, -16.0 * s, 32.0 * s];
        let translate = |p: [f64; 3]| std::array::from_fn(|k| p[k] + shift[k]);
        assert_eq!(orient3d_exact(translate(a), translate(b), translate(c), translate(d)), Sign::Negative);
    }
    // For B=0, C=X, D=Y, det(A-D,B-D,C-D) = A.z = 1/11 > 0.
    // The other two non-dyadic coordinates cannot affect this analytic sign.
    let point = [
        BigRational::new(1.into(), 3.into()),
        BigRational::new(1.into(), 7.into()),
        BigRational::new(1.into(), 11.into()),
    ];
    assert_eq!(orient3d_exact_pt(&point, [0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]), Sign::Positive);
}

// #7292: B is x-axis intersect 3x+y+z=1, hence (1/3,0,0).
// D intersects x=0,y=0, x+y+11z=1, hence (0,0,1/11).
// The production mixed-predicate arm has determinant -1/33 against A=0,C=Y.
fn mixed_lambda_fixture() -> [ImplicitPoint; 4] {
    [
        ImplicitPoint::Explicit([-0.0, 0.0, -0.0]),
        ImplicitPoint::Lpi(Lpi {
            p: [0., 0., 0.], q: [1., 0., 0.],
            r: [0., 1., 0.], s: [0., 0., 1.], t: [1., -2., 0.],
        }),
        ImplicitPoint::Explicit([0., 1., 0.]),
        ImplicitPoint::Tpi(Tpi { planes: [
            [[0., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            [[0., 0., 0.], [0., 0., 1.], [1., 0., 0.]],
            [[1., 0., 0.], [0., 1., 0.], [-10., 0., 1.]],
        ] }),
    ]
}

fn zero_denominator_lpi() -> ImplicitPoint {
    ImplicitPoint::Lpi(Lpi {
        p: [0., 0., 0.], q: [1., 0., 0.],
        r: [0., 0., 0.], s: [1., 0., 0.], t: [0., 1., 0.],
    })
}

#[test]
fn issue_7292_mixed_lambda_reuse_preserves_nondyadic_orientation() {
    let mut p = mixed_lambda_fixture();
    let orient = |p: &[ImplicitPoint; 4]| super::super::predicates::orient3d(&p[0], &p[1], &p[2], &p[3]);
    assert_eq!(orient(&p), Sign::Negative);
    p.swap(1, 2);
    assert_eq!(orient(&p), Sign::Positive);
    p[3] = ImplicitPoint::Explicit([0.; 3]);
    assert_eq!(orient(&p), Sign::Zero);
}

#[test]
fn issue_7292_mixed_zero_denominator_skips_later_nonfinite() {
    let mut p = mixed_lambda_fixture();
    p[1] = zero_denominator_lpi();
    p[2] = ImplicitPoint::Explicit([f64::NAN, 0., 0.]);
    assert_eq!(super::super::predicates::orient3d(&p[0], &p[1], &p[2], &p[3]), Sign::Zero);
}

#[test]
#[should_panic(expected = "kernel: non-finite coordinate reached the exact predicate")]
fn issue_7292_mixed_nonfinite_before_zero_denominator_still_panics() {
    let mut p = mixed_lambda_fixture();
    p[1] = ImplicitPoint::Explicit([f64::NAN, 0., 0.]);
    p[2] = zero_denominator_lpi();
    super::super::predicates::orient3d(&p[0], &p[1], &p[2], &p[3]);
}
