// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_geometry::document::retained_wire::{self as wire, AffineCertificate, MeshInfo};

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

// Refs #7955 E: wire admission must bound allocations before any stream read.
#[test]
fn m1_mesh_info_refuses_partial_and_over_budget_outputs() {
    let mut bytes = [0; 24];
    bytes[..4].copy_from_slice(&3u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    bytes[8..12].copy_from_slice(&1u32.to_le_bytes());
    let info = MeshInfo::decode(&bytes).unwrap();
    assert_eq!(info.buffer_bytes(160), Ok(160));
    assert!(info.buffer_bytes(159).is_err());
    bytes[20] = 1;
    assert!(MeshInfo::decode(&bytes)
        .unwrap()
        .buffer_bytes(4096)
        .is_err());
    assert!(MeshInfo::decode(&[0; 23]).is_err());
    assert!(MeshInfo::decode(&[0; 24]).unwrap().is_zero());
    assert!(MeshInfo::decode(&[0; 24])
        .unwrap()
        .buffer_bytes(4096)
        .is_err());
}

#[test]
fn m1_survey_frames_cancel_before_rotation_and_reject_reflections() {
    let mut a = IDENTITY;
    a[12] = 5_000_000.;
    a[13] = 6_000_000.;
    let mut b = a;
    b[12] += 0.125;
    let relative = wire::relative(a, b).unwrap();
    assert_eq!(relative[12], 0.125);
    assert_eq!(wire::multiply(a, relative), b);
    let mut reflected = IDENTITY;
    reflected[0] = -1.;
    assert!(wire::rigid(reflected).is_err());
    assert!(wire::validate_affine(&reflected).is_ok());
    reflected[0] = 0.;
    assert!(wire::validate_affine(&reflected).is_err());
}

#[test]
fn m1_affine_certificate_enforces_both_class_budgets_and_versions() {
    let mut bytes = [0; 56];
    bytes[0] = 1;
    bytes[4] = 1;
    for offset in [8, 32] {
        bytes[offset..offset + 4].copy_from_slice(&100_001u32.to_le_bytes());
        assert!(AffineCertificate::decode(&bytes).is_err());
        bytes[offset..offset + 4].copy_from_slice(&100_000u32.to_le_bytes());
        assert!(AffineCertificate::decode(&bytes).is_ok());
    }
    // Refs #7955: truncate a valid certificate so version rejection cannot
    // mask a missing length guard. Start with the otherwise complete payload.
    assert!(AffineCertificate::decode(&bytes).is_ok());
    for len in (0..56).rev() {
        assert!(AffineCertificate::decode(&bytes[..len]).is_err());
    }
    bytes[4] = 2;
    assert!(AffineCertificate::decode(&bytes).is_err());
}
