// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `frame`: the "proved once" unit. The signed-permutation conjugation equals
//! the `S·M·Sᵀ` matmul it replaces, compared by `to_bits()`, including the
//! sign of zero.

use super::frame::*;
use super::mat4::{mul, transpose, M3, M4};
use super::v3_tests::Rng;

fn bits_eq(a: &[f64], b: &[f64]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

/// A matrix with a mix of zeros, signed zeros, subnormals and 1e7-scale terms,
/// and whole zero rows/columns on some draws.
fn matrix(rng: &mut Rng) -> M4 {
    let mut m: M4 = std::array::from_fn(|_| rng.f64());
    if rng.next().is_multiple_of(5) {
        let k = (rng.next() % 4) as usize;
        for j in 0..4 {
            m[k * 4 + j] = if rng.next().is_multiple_of(2) { 0.0 } else { -0.0 };
            m[j * 4 + k] = if rng.next().is_multiple_of(2) { 0.0 } else { -0.0 };
        }
    }
    m
}

#[test]
fn conjugation_equals_the_matmul_bit_for_bit() {
    let mut rng = Rng(0xC0FF_EE00_1234_5678);
    for _ in 0..20_000 {
        let m = matrix(&mut rng);
        let old_fwd = mul(&mul(&ZUP_TO_YUP, &m), &YUP_TO_ZUP);
        let old_inv = mul(&mul(&YUP_TO_ZUP, &m), &ZUP_TO_YUP);
        assert!(bits_eq(&conjugate_zup_to_yup(&m), &old_fwd));
        assert!(bits_eq(&conjugate_yup_to_zup(&m), &old_inv));
        // Storage-agnostic: conjugation commutes with transposition.
        assert!(bits_eq(
            &conjugate_zup_to_yup(&transpose(&m)),
            &transpose(&conjugate_zup_to_yup(&m)),
        ));
    }
}

#[test]
fn conjugation_folds_negative_zero_and_keeps_non_finite_local() {
    let mut m = [0.0; 16];
    m[5] = -0.0;
    m[6] = -0.0;
    assert!(conjugate_zup_to_yup(&m).iter().all(|v| v.to_bits() == 0), "every zero is +0.0");
    let mut n = [1.0; 16];
    n[5] = f64::NAN;
    assert_eq!(conjugate_zup_to_yup(&n).iter().filter(|v| v.is_nan()).count(), 1);
}

#[test]
fn the_two_conjugations_are_inverse_and_fix_the_identity() {
    let mut rng = Rng(3);
    let m = matrix(&mut rng);
    assert!(bits_eq(&conjugate_yup_to_zup(&conjugate_zup_to_yup(&m)), &m.map(|v| v + 0.0)));
    assert!(bits_eq(&conjugate_zup_to_yup(&super::mat4::IDENTITY), &super::mat4::IDENTITY));
}

#[test]
fn the_3x3_conjugation_equals_the_3x3_matmul() {
    // The server's `P·R·Pᵀ`, with its 0.0-initialised accumulator.
    fn mul3(a: &M3, b: &M3) -> M3 {
        std::array::from_fn(|i| {
            let (r, c) = (i / 3, i % 3);
            let mut s = 0.0;
            for k in 0..3 {
                s += a[r * 3 + k] * b[k * 3 + c];
            }
            s
        })
    }
    let p: M3 = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0];
    let pt: M3 = [1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0];
    let mut rng = Rng(77);
    for _ in 0..10_000 {
        let r: M3 = std::array::from_fn(|_| rng.f64());
        assert!(bits_eq(&conjugate3_zup_to_yup(&r), &mul3(&mul3(&p, &r), &pt)));
    }
}

#[test]
fn point_swaps_are_exact_inverses_and_do_not_fold_zero() {
    assert_eq!(zup_to_yup([1.0, 2.0, 3.0]), [1.0, 3.0, -2.0]);
    assert_eq!(yup_to_zup([1.0, 3.0, -2.0]), [1.0, 2.0, 3.0]);
    assert_eq!(zup_to_yup([1.0f32, 2.0, 3.0]), [1.0, 3.0, -2.0]);
    assert_eq!(zup_to_yup([0.0f64, 0.0, 0.0])[2].to_bits(), (-0.0f64).to_bits());
    let mut rng = Rng(8);
    for _ in 0..1_000 {
        let v = rng.v3();
        assert!(bits_eq(&yup_to_zup(zup_to_yup(v)), &v));
    }
}

#[test]
fn in_place_rewrites_complete_triplets_only() {
    let mut buf = [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    zup_to_yup_in_place(&mut buf);
    assert_eq!(buf, [1.0, 3.0, -2.0, 4.0, 6.0, -5.0, 7.0, 8.0]);
}

#[test]
fn aabb_swap_reverses_min_max_on_the_negated_axis() {
    // y spans [2, 5] in Z-up, so the new z spans [-5, -2], not [-2, -5].
    let world = aabb_zup_to_yup([1.0f64, 2.0, 3.0, 4.0, 5.0, 6.0]);
    assert_eq!(world, [1.0, 3.0, -5.0, 4.0, 6.0, -2.0]);
    assert!(world[2] <= world[5]);
    assert_eq!(aabb_zup_to_yup([1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0]), [1.0, 3.0, -5.0, 4.0, 6.0, -2.0]);
    // A national-grid f64 box survives exactly.
    let ifc = [2_600_000.000_5_f64, 1_200_000.000_5, 0.0, 2_600_001.000_5, 1_200_001.000_5, 3.0];
    assert_eq!(aabb_zup_to_yup(ifc), [ifc[0], ifc[2], -ifc[4], ifc[3], ifc[5], -ifc[1]]);
}
