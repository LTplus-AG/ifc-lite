// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::detect_schema_version;

fn original_predicate(content: &[u8]) -> &'static str {
    if content.windows(6).any(|window| window == b"IFC4X3") {
        "IFC4X3"
    } else if content.windows(4).any(|window| window == b"IFC4") {
        "IFC4"
    } else {
        "IFC2X3"
    }
}

/// #3987: this optimization retains substring compatibility, not header parsing.
#[test]
fn schema_search_preserves_anywhere_precedence_3987() {
    let cases: &[(&[u8], &str)] = &[
        (b"", "IFC2X3"),
        (b"FILE_SCHEMA(('IFC2X3'));", "IFC2X3"),
        (b"FILE_SCHEMA(('IFC4'));", "IFC4"),
        (b"IFC4...IFC4X3", "IFC4X3"),
        (b"IFC4X3...IFC4", "IFC4X3"),
        (b"FILE_SCHEMA(('IFC2X3'));DATA;#1=IFCLABEL('IFC4X3');", "IFC4X3"),
        (b"/* IFC4X3 */ FILE_SCHEMA(('IFC4'));", "IFC4X3"),
        (b"IFCIFC4X3", "IFC4X3"),
        (b"IFC4IFC4X3", "IFC4X3"),
        (b"IFC4XIFC4X3", "IFC4X3"),
        (b"IFC4IFC4", "IFC4"),
        (b"IFC4X", "IFC4"),
        (b"IFC4X2", "IFC4"),
        (b"ifc4x3", "IFC2X3"),
        (b"\xffIFC4X3\0", "IFC4X3"),
    ];
    for &(content, expected) in cases {
        assert_eq!(original_predicate(content), expected);
        assert_eq!(detect_schema_version(content), expected, "{content:?}");
    }
}

/// IFC4 has no self-overlapping prefix/suffix, so skipping the first match
/// cannot hide a second IFC4X3 match. Exercise matches across chunk boundaries,
/// all prefix/suffix truncations, adjacent occurrences, and non-UTF8 bytes.
#[test]
fn schema_search_matches_raw_window_oracle_3987() {
    let chunks: &[&[u8]] = &[
        b"", b"I", b"IF", b"IFC", b"IFC4", b"IFC4X", b"IFC4X3",
        b"FC4X3", b"C4X3", b"4X3", b"X3", b"3", b"\0\xff", b"IFC2X3",
    ];
    for &left in chunks {
        for &middle in chunks {
            for &right in chunks {
                let content = [left, middle, right].concat();
                assert_eq!(detect_schema_version(&content), original_predicate(&content),
                    "{content:?}");
            }
        }
    }
}
