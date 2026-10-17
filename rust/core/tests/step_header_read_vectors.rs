// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F4-2 (#7778): the header reader and the scanner's `DATA;` search agree on
//! one keyword finder and one window.
//!
//! The shared vectors (`fixtures/step_header_read_vectors.json`) are also read
//! by `packages/parser/test/source-header-read-vectors.test.ts`. The scanner
//! cases below are Rust-only: the TypeScript scanner has its own marker walk.

use ifc_lite_core::parser::header::{
    declared_schemas_bounded, decode_string_list, extract_record_args, split_top_level,
    MAX_HEADER_BYTES,
};
use ifc_lite_core::EntityScanner;

fn strings(value: &serde_json::Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

#[test]
fn header_reader_matches_the_shared_vectors() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/step_header_read_vectors.json")).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 10, "the fixture shrank to {} cases", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let pad = " ".repeat(case["padBefore"].as_u64().unwrap_or(0) as usize);
        let text = case["text"].as_str().unwrap().replace("{pad}", &pad);
        if let Some(expected) = case.get("schemas") {
            assert_eq!(declared_schemas_bounded(text.as_bytes()), strings(expected), "{name}: schemas");
        }
        if let Some(expected) = case.get("description") {
            let record = extract_record_args(&text, "FILE_DESCRIPTION").expect(name);
            let parts = split_top_level(&record);
            assert_eq!(decode_string_list(&parts[0]), strings(expected), "{name}: description");
        }
    }
}

/// The ids a scanner yields from `content`.
fn ids(content: &str) -> Vec<u32> {
    let mut scanner = EntityScanner::new(content);
    let mut out = Vec::new();
    while let Some((id, ..)) = scanner.next_entity() {
        out.push(id);
    }
    out
}

const BODY: &str = "#1=IFCWALL('a',$);\nENDSEC;\nEND-ISO-10303-21;\n";

/// CORE-9: the marker is a keyword like any other. Before F4-2 it was the
/// exact bytes `DATA;`, so only the first marker spelling found the section
/// start: for the others the scan began at the top of the file and read `#99`,
/// a record inside a header literal, as part of the model.
#[test]
fn the_data_marker_is_a_keyword_not_an_exact_byte_string() {
    let decoy = "FILE_DESCRIPTION(('#99=IFCWALL($); decoy'),'2;1');\n";
    for marker in ["DATA;", "DATA ;", "data;", "DATA\n/* c */;", "DATA('model',('IFC4'));", "Data ( 'm' , ( 'IFC4' ) ) ;"] {
        let file = format!("ISO-10303-21;\nHEADER;\n{decoy}ENDSEC;\n{marker}\n{BODY}");
        assert_eq!(ids(&file), vec![1], "marker {marker:?}");
    }
}

/// `METADATA;` ends in the bytes `DATA;`; a header field can say so too.
#[test]
fn a_longer_identifier_ending_in_data_is_not_the_marker() {
    let file = format!(
        "ISO-10303-21;\nHEADER;\nMETADATA;\nFILE_DESCRIPTION(('#99=IFCWALL($); decoy'),'2;1');\nENDSEC;\nDATA;\n{BODY}"
    );
    assert_eq!(ids(&file), vec![1]);
}

/// CORE-9: the scanner searched 256 KiB, the header reader 64 KiB. One window.
#[test]
fn the_scanner_and_the_header_reader_share_one_window() {
    assert_eq!(MAX_HEADER_BYTES, 256 * 1024);
    let pad = "/* ".to_owned() + &"x".repeat(100_000) + " */\n";
    let file = format!("ISO-10303-21;\nHEADER;\n{pad}ENDSEC;\nDATA;\n{BODY}");
    assert_eq!(ids(&file), vec![1]);
    // Past the window there is no marker to find: the scan starts at the top
    // and still finds the one record, the partial-file behaviour.
    let far = " ".repeat(MAX_HEADER_BYTES);
    let file = format!("ISO-10303-21;\nHEADER;\n{far}DATA;\n{BODY}");
    assert_eq!(ids(&file), vec![1]);
}

/// A hostile header costs one pass: a `/*` that never closes ends the search
/// instead of being re-tried at every later `/*` (the old `Lex` memo).
#[test]
fn a_run_of_unclosed_comment_openers_is_one_pass() {
    use ifc_lite_core::parser::header::{find_keyword_then, Then};
    let hostile = format!("HEADER;\n{}\nFILE_SCHEMA((", "/* ".repeat(80_000));
    assert!(!hostile.contains("*/"));
    assert_eq!(find_keyword_then(hostile.as_bytes(), b"FILE_SCHEMA", Then::Paren), None);
    let packed = format!("HEADER;\n{}FILE_SCHEMA((", "/*x*/".repeat(50_000));
    let hit = find_keyword_then(packed.as_bytes(), b"FILE_SCHEMA", Then::Paren).unwrap();
    assert_eq!(hit.then, packed.len() - 2);
}
