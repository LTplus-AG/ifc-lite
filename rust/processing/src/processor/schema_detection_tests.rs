// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::detect_schema_version;

/// Shared with the TS parser's suite
/// (`packages/parser/test/schema-version-parity-7691.test.ts`).
const VECTORS: &str = include_str!("../../../core/tests/fixtures/schema_version_vectors.json");

/// PROCESSING-5 / SERVER-18 (#7691): every shared vector classifies to the
/// answer the TS parser's `detectSchemaVersion` gives. Covers first-recognised
/// wins, the IFC5 family, GUID/DATA/header-string decoys, case, comments, BOM,
/// absent/empty/unset declarations, malformed headers and the 256 KiB window.
#[test]
fn shared_vectors_match_the_ts_parser_7691() {
    let doc: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let vectors = doc["vectors"].as_array().unwrap();
    assert!(vectors.len() > 10, "the vector file lost its cases");
    let mut failures = Vec::new();
    for v in vectors {
        let pad = "x".repeat(v["pad"].as_u64().unwrap_or(0) as usize);
        let content = v["content"].as_str().unwrap().replace("{PAD}", &pad);
        let got = detect_schema_version(content.as_bytes());
        if got != v["expected"].as_str().unwrap() {
            failures.push(format!("{}: got {got}, expected {}", v["name"], v["expected"]));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Base's whole-file search matched `ifc4` inside a GUID, so an IFC2X3 model
/// with such a GUID (schependomlaan, ISSUE_098) reported IFC4 (#7691).
#[test]
fn a_guid_containing_ifc4_does_not_override_the_declaration_7691() {
    let mut content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n".to_vec();
    // Past the 2000-byte head the fallback reads, like a real model body.
    content.extend(std::iter::repeat_n(b'\n', 4000));
    content.extend_from_slice(b"#9=IFCWALL('2w9qcp9R8Ifc4r6a7mXG16',$,$,$,$,$,$,$);\nENDSEC;\n");
    assert_eq!(detect_schema_version(&content), "IFC2X3");
}

/// Non-UTF-8 bytes (which the JSON vectors cannot carry) neither panic nor
/// hide a declaration, in the header or in the head-scan fallback.
#[test]
fn non_utf8_bytes_are_tolerated() {
    let declared = b"ISO-10303-21;\nHEADER;\nFILE_NAME('\xe9\xff',$,$,$,$,$,$);\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\n";
    assert_eq!(detect_schema_version(declared), "IFC4X3");
    assert_eq!(detect_schema_version(b"\xff\xfe IFC2X3 \x80"), "IFC2X3");
}
