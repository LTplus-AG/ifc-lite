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
        (b"\xffIFC4X3\0", "IFC4X3"),
    ];
    for &(content, expected) in cases {
        assert_eq!(original_predicate(content), expected);
        assert_eq!(detect_schema_version(content), expected, "{content:?}");
    }
}

/// #4661: ISO 10303-21 keywords are case-insensitive, so a lowercase or
/// mixed-case `FILE_SCHEMA` header is legal input, not malformed input.
/// Before the fix, `detect_schema_version` searched case-sensitively and a
/// lowercase/mixed-case header silently fell through to the `"IFC2X3"`
/// default — this is the assertion that used to pin that wrong answer as
/// correct: `(b"ifc4x3", "IFC2X3")` in the case list above. It is replaced
/// here with the requirement that case never changes the detected schema,
/// checked against byte-identical fixtures that differ only in header case.
#[test]
fn schema_search_is_case_insensitive_4661() {
    let cases: &[(&[u8], &str)] = &[
        // Genuine IFC2X3 (no IFC4 literal at all, in any case) must still
        // detect as IFC2X3, so a fix that just returns "everything is IFC4"
        // cannot pass this test.
        (b"FILE_SCHEMA(('IFC2X3'));", "IFC2X3"),
        (b"file_schema(('ifc2x3'));", "IFC2X3"),
        (b"FILE_SCHEMA(('IFC4'));", "IFC4"),
        (b"file_schema(('ifc4'));", "IFC4"),
        (b"File_Schema(('Ifc4'));", "IFC4"),
        (b"FILE_SCHEMA(('IFC4X3'));", "IFC4X3"),
        (b"file_schema(('ifc4x3'));", "IFC4X3"),
        (b"File_Schema(('IFC4x3'));", "IFC4X3"),
        // The IFC4X3/IFC4 prefix relationship must hold under folding too:
        // an IFC4X3 file's embedded "ifc4" must not win as IFC4 because the
        // shorter literal happens to match first.
        (b"file_schema(('ifc4x3'));", "IFC4X3"),
        (b"ifc4x3", "IFC4X3"),
        (b"Ifc4X3", "IFC4X3"),
    ];
    for &(content, expected) in cases {
        assert_eq!(
            detect_schema_version(content),
            expected,
            "case-folded input {content:?}"
        );
    }
}

/// #4661: two fixtures byte-identical apart from `FILE_SCHEMA` header case
/// must detect the same schema. This is the RED-first repro from the issue:
/// before the fix, the lowercase fixture fell back to `"IFC2X3"` while the
/// uppercase one correctly detected `"IFC4X3"`.
#[test]
fn uppercase_and_lowercase_headers_detect_the_same_schema_4661() {
    const UPPER: &[u8] =
        b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    const LOWER: &[u8] =
        b"iso-10303-21;\nheader;\nfile_description((''),'2;1');\nfile_schema(('ifc4x3'));\nendsec;\ndata;\nendsec;\nend-iso-10303-21;\n";
    assert_eq!(UPPER.len(), LOWER.len(), "fixtures must be byte-identical apart from case");
    assert_eq!(detect_schema_version(UPPER), "IFC4X3");
    assert_eq!(detect_schema_version(LOWER), "IFC4X3");
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
