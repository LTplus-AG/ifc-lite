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

// #7292: non-dyadic coordinates and all three projection axes have analytic
// determinant signs, independent of floating predicates or wrapper equality.
#[test]
fn issue_7292_materialized_orientation_has_analytic_signs_on_all_axes() {
    let point = [
        BigRational::new(1.into(), 3.into()),
        BigRational::new(1.into(), 7.into()),
        BigRational::new(1.into(), 11.into()),
    ];
    let zero = vec([-0.0, 0.0, -0.0]);
    for (axis, i, j, normal_sign) in [
        (DropAxis::X, 1, 2, Sign::Positive),
        (DropAxis::Y, 0, 2, Sign::Negative),
        (DropAxis::Z, 0, 1, Sign::Positive),
    ] {
        let mut u = [0.0; 3];
        let mut v = [0.0; 3];
        u[i] = 1.0;
        v[j] = 1.0;
        let (u, v) = (vec(u), vec(v));
        // det(A-V, -V, U-V) is respectively A.x, -A.y, A.z.
        assert_eq!(orient3d_pts(&point, &zero, &u, &v), normal_sign);
        assert_eq!(orient3d_pts(&point, &zero, &v, &u), normal_sign.flip());
        // Projected det(A-U, -U) = A[j] > 0 on each retained plane.
        assert_eq!(orient2d_pts(&point, &zero, &u, axis), Sign::Positive);
        assert_eq!(orient2d_pts(&point, &u, &zero, axis), Sign::Negative);
        let mut on_edge = zero.clone();
        on_edge[i] = point[i].clone();
        assert_eq!(orient2d_pts(&on_edge, &zero, &u, axis), Sign::Zero);
        on_edge[j] = point[j].clone();
        assert_eq!(orient3d_pts(&on_edge, &zero, &u, &v), Sign::Zero);
    }
}
