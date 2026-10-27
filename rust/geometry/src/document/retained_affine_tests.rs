// SPDX-License-Identifier: MPL-2.0
use super::*;
// #7955: fixed wire version, rational representation and bounded class counts.

#[test]
fn certificate_decoding_is_strict() {
    let mut bytes = vec![0; 56];
    bytes[0] = 1;
    bytes[4] = 1;
    bytes[8 + 4] = 12;
    bytes[8 + 28] = 6;
    let certificate = AffineCertificate::decode(&bytes).unwrap();
    assert_eq!(certificate.representation(), "generic-rational-brep-v1");
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
