// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `mat4`: bit equality against the expanded formulas and the old copies'
//! behaviour, plus the nalgebra bridges.

use super::mat4::*;
use super::v3_tests::Rng;
use nalgebra::Matrix4;

fn m4(rng: &mut Rng) -> M4 {
    std::array::from_fn(|_| rng.f64())
}

fn bits_eq(a: &[f64], b: &[f64]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

#[test]
fn mul_is_the_zero_initialised_triple_loop() {
    let mut rng = Rng(0xA5A5_1234_DEAD_BEEF);
    for _ in 0..5_000 {
        let (a, b) = (m4(&mut rng), m4(&mut rng));
        let mut want = [0.0f64; 16];
        for r in 0..4 {
            for c in 0..4 {
                // Written out, k = 0..4, left to right, starting from +0.0.
                want[r * 4 + c] = 0.0
                    + a[r * 4] * b[c]
                    + a[r * 4 + 1] * b[4 + c]
                    + a[r * 4 + 2] * b[8 + c]
                    + a[r * 4 + 3] * b[12 + c];
            }
        }
        assert!(bits_eq(&mul(&a, &b), &want));
    }
    // An all-zero dot product is +0.0, whatever the operand signs.
    let neg = [-0.0f64; 16];
    assert!(mul(&neg, &IDENTITY).iter().all(|v| v.to_bits() == 0));
}

#[test]
fn point_and_vector_transforms_match_the_expanded_rows() {
    let mut rng = Rng(99);
    for _ in 0..5_000 {
        let m = m4(&mut rng);
        let p = rng.v3();
        let tp = transform_point(&m, p);
        let tv = transform_vector(&m, p);
        for r in 0..3 {
            let lin = m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2];
            assert_eq!(tv[r].to_bits(), lin.to_bits());
            assert_eq!(tp[r].to_bits(), (lin + m[r * 4 + 3]).to_bits());
        }
        let r3: M3 = std::array::from_fn(|_| rng.f64());
        let a = apply3(&r3, p);
        for r in 0..3 {
            let want = r3[r * 3] * p[0] + r3[r * 3 + 1] * p[1] + r3[r * 3 + 2] * p[2];
            assert_eq!(a[r].to_bits(), want.to_bits());
        }
    }
}

#[test]
fn transform_vector_on_a_column_major_array_is_the_transpose_product() {
    let m = Matrix4::new(
        1.0, 2.0, 3.0, 0.0, //
        4.0, 5.0, 6.0, 0.0, //
        7.0, 8.0, 9.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    );
    let v = [1.0, 10.0, 100.0];
    let got = transform_vector(&col_major_array(&m), v);
    let want = m.transpose() * nalgebra::Vector4::new(v[0], v[1], v[2], 0.0);
    assert_eq!(got, [want.x, want.y, want.z]);
}

#[test]
fn transpose_translation_identity_and_bridges() {
    let mut rng = Rng(5);
    let m = m4(&mut rng);
    assert!(bits_eq(&transpose(&transpose(&m)), &m));
    assert_eq!(transpose(&m)[1], m[4]);
    assert_eq!(transform_point(&translation([1.0, 2.0, 3.0]), [0.0; 3]), [1.0, 2.0, 3.0]);
    assert_eq!(to_na(&IDENTITY), Matrix4::<f64>::identity());
    let na = Matrix4::from_fn(|r, c| (r * 4 + c) as f64 + 0.5);
    assert!(bits_eq(&from_na(&na), &m_from_rows(&na)));
    assert!(bits_eq(&to_na(&from_na(&na)).as_slice(), &na.as_slice()));
    // Column-major storage is the transpose of the row-major reading.
    assert!(bits_eq(&col_major_array(&na), &transpose(&from_na(&na))));
    assert_eq!(Matrix4::from_column_slice(&col_major_array(&na)), na);
}

fn m_from_rows(na: &Matrix4<f64>) -> M4 {
    std::array::from_fn(|i| na[(i / 4, i % 4)])
}

#[test]
fn f32_casts_are_the_only_narrowing_and_keep_their_layout() {
    let mut rng = Rng(11);
    let m = m4(&mut rng);
    let f = to_f32(&m);
    let cm = to_col_major_f32(&m);
    for r in 0..4 {
        for c in 0..4 {
            assert_eq!(f[r * 4 + c].to_bits(), (m[r * 4 + c] as f32).to_bits());
            assert_eq!(cm[c * 4 + r].to_bits(), (m[r * 4 + c] as f32).to_bits());
        }
    }
}

/// The cofactor inverse as export and processing wrote it, with the policy the
/// home chose (`!finite || < 1e-18`). The arithmetic is the spec.
fn reference_inverse(m: &M4) -> Option<M4> {
    let det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
        + m[2] * (m[4] * m[9] - m[5] * m[8]);
    if !det.is_finite() || det.abs() < 1e-18 {
        return None;
    }
    let (a, b, c, d, e, f, g, h, i) = (m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);
    let k = 1.0 / det;
    let r = [
        (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
        (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
        (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k,
    ];
    let t = [m[3], m[7], m[11]];
    let it = |j: usize| -(r[j * 3] * t[0] + r[j * 3 + 1] * t[1] + r[j * 3 + 2] * t[2]);
    Some([
        r[0], r[1], r[2], it(0), r[3], r[4], r[5], it(1), r[6], r[7], r[8], it(2), 0.0, 0.0, 0.0,
        1.0,
    ])
}

#[test]
fn affine_inverse_matches_the_reference_and_refuses_singular_or_non_finite() {
    let mut rng = Rng(0x1357_9BDF);
    for _ in 0..5_000 {
        let m = m4(&mut rng);
        match (affine_inverse(&m), reference_inverse(&m)) {
            (Some(x), Some(y)) => assert!(bits_eq(&x, &y)),
            (None, None) => {}
            (x, y) => panic!("policy drift: {x:?} vs {y:?}"),
        }
    }
    let mut nan = IDENTITY;
    nan[3] = 5.0;
    assert!(affine_inverse(&nan).is_some());
    nan[0] = f64::NAN;
    assert!(affine_inverse(&nan).is_none(), "a NaN placement is refused, not inverted to NaN");
    let tiny = translation([0.0; 3]).map(|v| v * 1e-7);
    assert!(affine_inverse(&tiny).is_none(), "det 1e-21 is below SINGULAR_DET_EPS");
    assert!(affine_inverse(&[0.0; 16]).is_none());
}

#[test]
fn affine_inverse_composes_to_identity_for_a_rigid_placement() {
    let (s, c) = 0.6f64.sin_cos();
    let m = [c, -s, 0.0, 12.5, s, c, 0.0, -3.0, 0.0, 0.0, 1.0, 7.0, 0.0, 0.0, 0.0, 1.0];
    let p = mul(&m, &affine_inverse(&m).unwrap());
    for (got, want) in p.iter().zip(IDENTITY) {
        assert!((got - want).abs() < 1e-12);
    }
}
