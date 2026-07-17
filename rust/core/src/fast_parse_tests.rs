// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn test_parse_coordinates_direct() {
    let bytes = b"((0.,0.,150.),(0.,40.,140.),(100.,0.,0.))";
    let coords = parse_coordinates_direct(bytes);

    assert_eq!(coords.len(), 9);
    assert!((coords[0] - 0.0).abs() < 0.001);
    assert!((coords[1] - 0.0).abs() < 0.001);
    assert!((coords[2] - 150.0).abs() < 0.001);
    assert!((coords[3] - 0.0).abs() < 0.001);
    assert!((coords[4] - 40.0).abs() < 0.001);
    assert!((coords[5] - 140.0).abs() < 0.001);
}

#[test]
fn test_parse_indices_direct() {
    let bytes = b"((1,2,3),(2,1,4),(5,6,7))";
    let indices = parse_indices_direct(bytes);

    assert_eq!(indices.len(), 9);
    // Should be 0-based (1-based converted)
    assert_eq!(indices[0], 0); // 1 -> 0
    assert_eq!(indices[1], 1); // 2 -> 1
    assert_eq!(indices[2], 2); // 3 -> 2
    assert_eq!(indices[3], 1); // 2 -> 1
    assert_eq!(indices[4], 0); // 1 -> 0
    assert_eq!(indices[5], 3); // 4 -> 3
}

#[test]
fn test_parse_indices_direct_rejects_out_of_range() {
    // 4294967297 = 2^32 + 1. Wrapping arithmetic would map it to 1 (→ 0
    // after the 1-based fixup), silently aliasing a valid-looking vertex.
    // Checked+saturate turns it into an obviously out-of-range sentinel
    // (u32::MAX - 1) the downstream bounds checks drop.
    let bytes = b"((4294967297,1,2))";
    let indices = parse_indices_direct(bytes);

    assert_eq!(indices.len(), 3);
    assert_eq!(
        indices[0],
        u32::MAX - 1,
        "overflowing index must saturate, not wrap to a valid vertex"
    );
    assert_eq!(indices[1], 0); // 1 -> 0
    assert_eq!(indices[2], 1); // 2 -> 1
}

#[test]
fn test_parse_indices_direct_boundary_values() {
    // 4294967295 = u32::MAX exactly: fits, no overflow, 1-based fixup applies.
    // 4294967296 = 2^32: first overflowing value, saturates to u32::MAX.
    // 4294967294 = u32::MAX - 1: fits.
    let bytes = b"((4294967295,4294967296,4294967294))";
    let indices = parse_indices_direct(bytes);
    assert_eq!(
        indices,
        vec![u32::MAX - 1, u32::MAX - 1, u32::MAX - 2],
        "boundary values must saturate deterministically"
    );
}

#[test]
fn test_parse_indices_direct_overflow_consumes_all_digits() {
    // After overflow is detected, remaining digits must still be consumed so
    // the parser resynchronizes on the next value instead of splitting the
    // huge number into several bogus indices.
    let bytes = b"((99999999999999999999999999,2))";
    let indices = parse_indices_direct(bytes);
    assert_eq!(indices, vec![u32::MAX - 1, 1]);
}

#[test]
fn test_parse_indices_direct_matches_old_wrapping_for_in_range_values() {
    // The checked/saturating parse must be byte-for-byte identical to the old
    // wrapping parse for every index that does NOT overflow u32 — i.e. all
    // valid inputs. Reference reimplementation of the pre-hardening logic:
    fn old_parse(bytes: &[u8]) -> Vec<u32> {
        let mut result = Vec::new();
        let mut pos = 0;
        let len = bytes.len();
        while pos < len {
            while pos < len && !bytes[pos].is_ascii_digit() {
                pos += 1;
            }
            if pos >= len {
                break;
            }
            let mut value: u32 = 0;
            while pos < len && bytes[pos].is_ascii_digit() {
                value = value
                    .wrapping_mul(10)
                    .wrapping_add((bytes[pos] - b'0') as u32);
                pos += 1;
            }
            result.push(value.saturating_sub(1));
        }
        result
    }

    let cases: &[&[u8]] = &[
        b"((1,2,3),(2,1,4),(5,6,7))",
        b"((0,1,4294967295))", // 0 (already 0 after saturating_sub) and u32::MAX
        b"((429496729,1000000000,999999999))",
        b"((10,200,3000),(40000,500000,6000000))",
    ];
    for bytes in cases {
        assert_eq!(
            parse_indices_direct(bytes),
            old_parse(bytes),
            "in-range parse changed for {:?}",
            std::str::from_utf8(bytes).unwrap()
        );
    }
}

#[test]
fn test_parse_scientific_notation() {
    let bytes = b"((1.5E-10,2.0e+5,-3.14))";
    let coords = parse_coordinates_direct(bytes);

    assert_eq!(coords.len(), 3);
    assert!((coords[0] - 1.5e-10).abs() < 1e-15);
    assert!((coords[1] - 2.0e5).abs() < 1.0);
    assert!((coords[2] - (-std::f32::consts::PI)).abs() < 0.01);
}

#[test]
fn test_parse_negative_numbers() {
    let bytes = b"((-1.0,-2.5,3.0))";
    let coords = parse_coordinates_direct(bytes);

    assert_eq!(coords.len(), 3);
    assert!((coords[0] - (-1.0)).abs() < 0.001);
    assert!((coords[1] - (-2.5)).abs() < 0.001);
    assert!((coords[2] - 3.0).abs() < 0.001);
}

#[test]
fn test_extract_coordinate_list() {
    let entity = b"#78=IFCCARTESIANPOINTLIST3D(((0.,0.,150.),(100.,0.,0.)));";
    let coords = extract_coordinate_list_from_entity(entity).unwrap();

    assert_eq!(coords.len(), 6);
    assert!((coords[0] - 0.0).abs() < 0.001);
    assert!((coords[2] - 150.0).abs() < 0.001);
    assert!((coords[3] - 100.0).abs() < 0.001);
}

#[test]
fn test_should_use_fast_path() {
    assert!(should_use_fast_path("IFCCARTESIANPOINTLIST3D"));
    assert!(should_use_fast_path("IFCTRIANGULATEDFACESET"));
    assert!(should_use_fast_path("IfcTriangulatedFaceSet"));
    assert!(!should_use_fast_path("IFCWALL"));
    assert!(!should_use_fast_path("IFCEXTRUDEDAREASOLID"));
}
