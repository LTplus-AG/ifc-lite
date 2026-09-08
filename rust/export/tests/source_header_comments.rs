// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ISO 10303-21 allows a `/* ... */` comment wherever whitespace is allowed, so
//! a header that carries one is ordinary input, not malformed input.
//!
//! These pin the Rust reader against the TypeScript one in
//! `packages/parser/src/source-header.ts`. The two halves reading the same
//! header differently is what #3284 is, and fixing one half alone would have
//! replaced a shared blind spot with a live disagreement.
//!
//! Not case for case with `packages/parser/test/source-header.test.ts`, and
//! saying so rather than claiming a parity that is not there. That file has
//! three cases this one does not, and two of them cannot fail here: the `ß`
//! offset case and the `ſ` long-s case are both about building an uppercased
//! COPY and indexing the original with its offsets, which `eq_ignore_ascii_case`
//! never does. The third is a non-termination guard, which `Option` makes
//! unrepresentable on this side.
//!
//! What each case costs on the export path, which is why they are worth pinning
//! rather than filing: `export_step` falls back to its own defaults when
//! `parse_source_header` returns `None`, so case 1 silently substitutes
//! `ifc-lite` for the source file's author, organization and authorization.

use ifc_lite_export::source_header::parse_source_header;

fn header(records: &str) -> Vec<u8> {
    format!("ISO-10303-21;\nHEADER;\n{records}\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")
        .into_bytes()
}

const NAME_AND_SCHEMA: &str = concat!(
    "FILE_NAME('a.ifc','ts',('Jane'),('Acme'),'pp','Revit','auth');\n",
    "FILE_SCHEMA(('IFC4'));"
);

#[test]
fn an_apostrophe_in_a_comment_does_not_invert_quote_state() {
    // A comment with an odd number of apostrophes leaves a quote-toggling scan
    // inverted for the rest of the file, so no record is found and the whole
    // header is lost.
    let src = header(&format!(
        "/* John's export */\nFILE_DESCRIPTION(('d'),'2;1');\n{NAME_AND_SCHEMA}"
    ));
    let h = parse_source_header(&src).expect("header should parse");
    assert_eq!(h.name.as_deref(), Some("a.ifc"));
    assert_eq!(h.originating_system.as_deref(), Some("Revit"));
}

#[test]
fn a_comment_between_a_keyword_and_its_paren_does_not_lose_the_record() {
    let src = header(
        "FILE_DESCRIPTION(('d'),'2;1');\n\
         FILE_NAME('a.ifc','ts',('Jane'),('Acme'),'pp','Revit','auth');\n\
         FILE_SCHEMA /* the real one */ (('IFC2X3'));",
    );
    let h = parse_source_header(&src).expect("header should parse");
    assert_eq!(h.schema_identifiers, vec!["IFC2X3".to_string()]);
    assert_eq!(h.name.as_deref(), Some("a.ifc"));
}

#[test]
fn a_comma_in_a_comment_does_not_shift_every_later_field() {
    // Read as a separator it moves each argument one slot along, so the fields
    // do not come back empty, they come back holding their neighbour's value
    // plus fragments of the comment itself.
    let src = header(
        "FILE_DESCRIPTION(('d'),'2;1');\n\
         FILE_NAME('a.ifc','ts',('Jane'),('Acme'),/* pp, then sys */'pp','Revit','auth');\n\
         FILE_SCHEMA(('IFC4'));",
    );
    let h = parse_source_header(&src).expect("header should parse");
    assert_eq!(h.preprocessor_version.as_deref(), Some("pp"));
    assert_eq!(h.originating_system.as_deref(), Some("Revit"));
    assert_eq!(h.authorization.as_deref(), Some("auth"));
}

#[test]
fn an_unterminated_comment_does_not_swallow_the_records_after_it() {
    // Not a comment at all, so it costs one stray character. Running it to
    // end-of-text would lose the whole header to two mistyped characters.
    let src = header(&format!(
        "/* never closed\nFILE_DESCRIPTION(('d'),'2;1');\n{NAME_AND_SCHEMA}"
    ));
    let h = parse_source_header(&src).expect("header should parse");
    assert_eq!(h.name.as_deref(), Some("a.ifc"));
    assert_eq!(h.schema_identifiers, vec!["IFC4".to_string()]);
}

#[test]
fn the_accepted_whitespace_set_is_exactly_the_ascii_one() {
    // One hand-written list against one stdlib helper is how the halves came
    // apart: `u8::is_ascii_whitespace` follows the WhatWG set and EXCLUDES
    // vertical tab, while the TypeScript list includes it, so the two read
    // `FILE_SCHEMA\x0B(('IFC4X3'))` differently. It was a regression on this
    // side too, since the `char::is_whitespace` it replaced accepted VT.
    //
    // So the set is asserted byte by byte rather than delegated. The mirror of
    // this test is in `packages/parser/test/source-header.test.ts`.
    for sep in [' ', '\t', '\n', '\r', '\u{0B}', '\u{0C}'] {
        let src = header(&format!("FILE_SCHEMA{sep}(('IFC2X3'));"));
        let h = parse_source_header(&src)
            .unwrap_or_else(|| panic!("{sep:?} should separate a keyword from its paren"));
        assert_eq!(
            h.schema_identifiers,
            vec!["IFC2X3".to_string()],
            "separator {sep:?}"
        );
    }

    // And nothing outside it. U+00A0 is not whitespace in ISO 10303-21, so the
    // record is malformed and both halves decline it.
    //
    // Asserted as `is_none()` rather than "none OR an empty list". The looser
    // form passed whether the reader REJECTED the record or ACCEPTED it and
    // came back with nothing, so it could not tell those apart, and the
    // comment above it claims the first. It returns None today; pin that.
    let nbsp = header("FILE_SCHEMA\u{00A0}(('IFC2X3'));");
    assert!(parse_source_header(&nbsp).is_none());
}
