// SPDX-License-Identifier: MPL-2.0
use super::*;

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

#[test]
fn certificate_decoding_is_strict() {
    let mut bytes = vec![0; 56];
    bytes[0] = 1;
    bytes[4] = 1;
    bytes[8 + 4] = 12;
    bytes[8 + 28] = 6;
    let certificate = AffineCertificate::decode(&bytes).unwrap();
    assert_eq!(certificate.source_classes()[1], 12);
    assert_eq!(certificate.source_classes()[7], 6);
    for (index, value) in [(0, 2), (4, 0)] {
        let mut bad = bytes.clone();
        bad[index] = value;
        assert!(AffineCertificate::decode(&bad).is_err());
    }
    assert!(AffineCertificate::decode(&bytes[..52]).is_err());
    let mut over = bytes.clone();
    over[8 + 24..8 + 28].copy_from_slice(&100_001u32.to_le_bytes());
    assert!(AffineCertificate::decode(&over).is_err());
}
