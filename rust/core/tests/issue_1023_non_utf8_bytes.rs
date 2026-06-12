// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};

fn fixture() -> Vec<u8> {
    let mut bytes = b"ISO-10303-21;\nHEADER;\nFILE_NAME('caf?',$,$,$,$,$,$);\nENDSEC;\nDATA;\n#1=IFCWALL('guid',$,'M?rz',$,$,$,$,$);\n#2=IFCCARTESIANPOINT((1.,2.,3.));\nENDSEC;\nEND-ISO-10303-21;\n".to_vec();
    for byte in &mut bytes {
        if *byte == b'?' {
            *byte = 0xe9;
        }
    }
    bytes
}

#[test]
fn issue_1023_scanner_accepts_non_utf8_and_preserves_offsets() {
    let bytes = fixture();
    let expected_start = bytes
        .windows(b"#1=IFCWALL".len())
        .position(|window| window == b"#1=IFCWALL")
        .unwrap();

    let mut scanner = EntityScanner::new(&bytes);
    let (id, type_name, start, end) = scanner.next_entity().unwrap();

    assert_eq!(id, 1);
    assert_eq!(type_name, "IFCWALL");
    assert_eq!(start, expected_start);
    assert_eq!(&bytes[start..end], &fixture()[start..end]);
}

#[test]
fn issue_1023_decoder_lossily_decodes_only_the_invalid_string() {
    let bytes = fixture();
    let index = build_entity_index(&bytes);
    let mut decoder = EntityDecoder::with_index(&bytes, index);

    let wall = decoder.decode_by_id(1).unwrap();
    assert_eq!(wall.get_string(2), Some("M\u{fffd}rz"));

    let point = decoder.decode_by_id(2).unwrap();
    assert_eq!(point.get_list(0).unwrap().len(), 3);
    assert!(decoder.get_raw_bytes(1).unwrap().contains(&0xe9));
}
