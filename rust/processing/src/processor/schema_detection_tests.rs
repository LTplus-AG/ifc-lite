// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::detect_schema_version;

/// A complete STEP header declaring `schema` (raw bytes, so a test can declare
/// non-UTF-8 or oddly cased identifiers), followed by `data` as the model body.
fn file(schema: &[u8], data: &[u8]) -> Vec<u8> {
    [
        b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('".as_slice(),
        schema,
        b"'));\nENDSEC;\nDATA;\n",
        data,
        b"\nENDSEC;\nEND-ISO-10303-21;\n",
    ]
    .concat()
}

/// The pre-#7691 classification, kept as the oracle for ONE declared
/// identifier: within the declaration it is still the rule (IFC4X3 first,
/// then IFC4, else the IFC2X3 default); only its scope moved to the header.
fn identifier_oracle(identifier: &[u8]) -> &'static str {
    let upper = identifier.to_ascii_uppercase();
    if upper.windows(6).any(|window| window == b"IFC4X3") {
        "IFC4X3"
    } else if upper.windows(4).any(|window| window == b"IFC4") {
        "IFC4"
    } else {
        "IFC2X3"
    }
}

#[test]
fn declared_schemas_classify_into_three_families() {
    let cases: &[(&[u8], &str)] = &[
        (b"IFC2X3", "IFC2X3"),
        (b"IFC2X3_TC1", "IFC2X3"),
        (b"IFC4", "IFC4"),
        (b"IFC4X1", "IFC4"),
        (b"IFC4X2", "IFC4"),
        (b"IFC4_ADD2_TC1", "IFC4"),
        (b"IFC4X3", "IFC4X3"),
        (b"IFC4X3_ADD2", "IFC4X3"),
    ];
    for &(schema, expected) in cases {
        assert_eq!(detect_schema_version(&file(schema, b"")), expected, "{schema:?}");
    }
}

/// No `FILE_SCHEMA` declaration at all (or no header at all) is the IFC2X3
/// default, not a panic and not a newer schema.
#[test]
fn an_undeclared_schema_defaults_to_ifc2x3() {
    for content in [
        b"".as_slice(),
        b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
        b"#1=IFCWALL('IFC4X3 in a value with no header at all',$,$,$,$,$,$,$);",
    ] {
        assert_eq!(detect_schema_version(content), "IFC2X3", "{content:?}");
    }
}

/// PROCESSING-5 (#7691): only the HEADER's declaration counts. Schema-like
/// text in a DATA value, in a header string, or in a comment used to win over
/// it (the whole-file substring search of #3987), while the server's
/// `/parse/metadata` (its own header-only copy) ignored it, so the two routes
/// reported different schemas for one upload.
#[test]
fn schema_like_text_outside_the_declaration_does_not_count_7691() {
    let in_data = file(b"IFC2X3", b"#1=IFCLABEL('converted from IFC4X3');");
    assert_eq!(detect_schema_version(&in_data), "IFC2X3", "a DATA value");

    let filled = b"ISO-10303-21;\nHEADER;\n\
        FILE_DESCRIPTION(('mentions FILE_SCHEMA((''IFC4X3''));'),'2;1');\n\
        /* FILE_SCHEMA(('IFC4X3')); */\n\
        FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
        #1=IFCDOCUMENTINFORMATION('IFC4X3',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);\nENDSEC;";
    assert_eq!(detect_schema_version(filled), "IFC4", "a header string and a comment");

    let undeclared = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\n\
        #1=IFCTEXT('mentions FILE_SCHEMA((IFC4X3)) in a comment field');\nENDSEC;";
    assert_eq!(detect_schema_version(undeclared), "IFC2X3", "a declaration-shaped DATA value");
}

/// #4661: ISO 10303-21 keywords are case-insensitive, so a lowercase or
/// mixed-case `FILE_SCHEMA` header is legal input, not malformed input, and
/// must not fall through to the `"IFC2X3"` default.
#[test]
fn schema_search_is_case_insensitive_4661() {
    let cases: &[(&[u8], &str)] = &[
        (b"FILE_SCHEMA(('IFC2X3'));", "IFC2X3"),
        (b"file_schema(('ifc2x3'));", "IFC2X3"),
        (b"FILE_SCHEMA(('IFC4'));", "IFC4"),
        (b"file_schema(('ifc4'));", "IFC4"),
        (b"File_Schema(('Ifc4'));", "IFC4"),
        (b"FILE_SCHEMA(('IFC4X3'));", "IFC4X3"),
        (b"file_schema(('ifc4x3'));", "IFC4X3"),
        (b"File_Schema(('IFC4x3'));", "IFC4X3"),
    ];
    for &(declaration, expected) in cases {
        let content = [b"iso-10303-21;\nheader;\n".as_slice(), declaration, b"\nendsec;\ndata;\nendsec;\n"].concat();
        assert_eq!(detect_schema_version(&content), expected, "case-folded input {declaration:?}");
    }
}

/// #4661: two fixtures byte-identical apart from header case must detect the
/// same schema.
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

/// `"IFC4X3"` contains `"IFC4"`, so the IFC4X3 test must come first or match
/// precisely. Exercise the identifier rule across chunk boundaries, every
/// prefix/suffix truncation, adjacent occurrences and non-UTF-8 bytes, against
/// the raw-window oracle (#3987's matrix, now inside the declaration).
#[test]
fn declared_identifier_matches_raw_window_oracle_3987() {
    let chunks: &[&[u8]] = &[
        b"", b"I", b"IF", b"IFC", b"IFC4", b"IFC4X", b"IFC4X3", b"ifc4x3",
        b"FC4X3", b"C4X3", b"4X3", b"X3", b"3", b"\0\xff", b"IFC2X3",
    ];
    for &left in chunks {
        for &middle in chunks {
            for &right in chunks {
                let identifier = [left, middle, right].concat();
                assert_eq!(
                    detect_schema_version(&file(&identifier, b"")),
                    identifier_oracle(&identifier),
                    "{identifier:?}"
                );
            }
        }
    }
}

/// Several declared identifiers: the newest family any of them names wins,
/// as the substring rule always resolved a multi-schema declaration.
#[test]
fn a_multi_schema_declaration_reports_its_newest_family() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3','IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;";
    assert_eq!(detect_schema_version(content), "IFC4X3");
}
