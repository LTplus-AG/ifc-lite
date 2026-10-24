// SPDX-License-Identifier: MPL-2.0
use super::*;
// #7955: source-derived survey placement and bounded affine admission invariants.

#[test]
fn common_frame_subtracts_survey_translation_before_rotation() {
    // Two metre frames at a survey origin; left X points along world Y.
    let a = [
        0., 1., 0., 0., -1., 0., 0., 0., 0., 0., 1., 0., 1e9, 2e9, 3e9, 1.,
    ];
    let b = [
        1.,
        0.,
        0.,
        0.,
        0.,
        1.,
        0.,
        0.,
        0.,
        0.,
        1.,
        0.,
        1e9 + 3.,
        2e9 + 5.,
        3e9 + 7.,
        1.,
    ];
    let local = relative(a, b).unwrap();
    assert_eq!(&local[12..15], &[5., -3., 7.]);
    assert_eq!(&local[..3], &[0., -1., 0.]);
    assert_eq!(&local[4..7], &[1., 0., 0.]);
    assert_eq!(multiply(a, local), b);
}
#[test]
fn common_frame_refuses_scale_reflection_and_nonfinite_occurrences() {
    let identity = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    for (index, value) in [(0, 2.), (0, -1.), (12, f64::INFINITY), (3, 1.)] {
        let mut invalid = identity;
        invalid[index] = value;
        assert!(relative(identity, invalid).is_err());
    }
}

#[test]
fn admission_refuses_unbounded_projective_and_singular_matrices() {
    let mut m = [
        2., 0., 0., 0., 0.4, 3., 0., 0., 0.2, 0.3, 4., 0., 7., -4., 2., 1.,
    ];
    assert!(validate_affine(&m).is_ok());
    m[0] = -2.;
    assert!(validate_affine(&m).is_ok(), "reflection is affine");
    for (index, value) in [(0, f64::NAN), (12, 2e9), (3, 1e-9), (15, 2.)] {
        let mut bad = m;
        bad[index] = value;
        assert!(validate_affine(&bad).is_err(), "{index}={value}");
    }
    let mut singular = m;
    singular[8..11].copy_from_slice(&[0.; 3]);
    assert_eq!(validate_affine(&singular), Err("singular affine matrix"));
}
