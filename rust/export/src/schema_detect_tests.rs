// SPDX-License-Identifier: MPL-2.0
//! Tests for `schema_detect.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved with the function they cover when `detect_schema` and `find_unquoted`
//! left `step_text.rs`. Exempt from the module-size ratchet via the `_tests.rs`
//! suffix convention.

use super::*;

#[test]
fn detect_schema_finds_file_schema_past_the_old_4096_byte_cutoff() {
    // `detect_schema` used to scan only the first 4096 bytes looking for
    // `FILE_SCHEMA`. A real STEP header can push FILE_SCHEMA past that
    // point when an earlier header field (e.g. DESCRIPTION) carries long
    // text. Pad the header well past 4096 bytes before FILE_SCHEMA and
    // confirm the schema is still found instead of silently falling back
    // to the `IFC4` default.
    let padding = "x".repeat(5000);
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('{padding}'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
    );
    assert!(
        content.len() > 4096,
        "test fixture must exceed the old 4096-byte cutoff"
    );
    assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
}

#[test]
fn detect_schema_does_not_read_a_commented_out_declaration() {
    // `detect_schema` drives schema CONVERSION on export, so reading a comment
    // as structure does not lose a field, it converts the file to the wrong
    // schema. A commented-out old declaration is exactly how a file picks up a
    // second FILE_SCHEMA line, and the commented one comes first.
    let content = "ISO-10303-21;\nHEADER;\n/* was FILE_SCHEMA(('IFC2X3')); */\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    assert_eq!(detect_schema(content.as_bytes()), "IFC4X3");
}

#[test]
fn detect_schema_survives_an_apostrophe_in_a_comment() {
    // An odd apostrophe count inside a comment inverts quote state for the rest
    // of the file, so the real FILE_SCHEMA reads as quoted and the schema falls
    // back to the default -- IFC4 for a file that says IFC2X3.
    let content = "ISO-10303-21;\nHEADER;\n/* John's export */\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
}

#[test]
fn detect_schema_does_not_take_a_quote_inside_a_comment_as_the_label() {
    // With the comment AFTER the keyword, the keyword search is not what is
    // under test: the label search is, and it was taking the first apostrophe
    // it saw. The two cases above put the comment on its own line BEFORE
    // FILE_SCHEMA, which the keyword search handles alone, so they passed with
    // this defect live and gave false assurance about the whole path.
    let commented_out = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA /* was 'IFC2X3' */ (('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\n";
    assert_eq!(detect_schema(commented_out.as_bytes()), "IFC4X3");

    // Worse than a wrong schema: the label goes into the exported header
    // through `escape()`, so this one shipped `s */ ((` as the schema name.
    let apostrophe =
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA /* Jane's */ (('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\n";
    assert_eq!(detect_schema(apostrophe.as_bytes()), "IFC4X3");

    // Inside the argument list rather than before it.
    let inside =
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA((/* 'IFC2X3' */'IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\n";
    assert_eq!(detect_schema(inside.as_bytes()), "IFC4X3");
}

#[test]
fn detect_schema_does_not_borrow_the_next_record_s_first_string() {
    // The label scan used to run to the end of the header, so a FILE_SCHEMA
    // with no label at all took the first apostrophe it could find, which is
    // the NEXT record's first argument. That value is then written into the
    // exported header through `escape()`.
    let leak = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(());\nFILE_NAME('leak.ifc','',(''),(''),'','','');\nENDSEC;\nDATA;\nENDSEC;\n";
    assert_eq!(detect_schema(leak.as_bytes()), "IFC4");

    // A record with no parens never raises depth, and a stray `)` puts depth at
    // -1 where `== 0` could never bring it back. Both left the scan unbounded,
    // so the first version of this bound closed neither.
    let no_parens = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA;\nFILE_NAME('leak.ifc','',(''),(''),'','','');\nENDSEC;\n";
    assert_eq!(detect_schema(no_parens.as_bytes()), "IFC4");
    let stray_paren = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA);\nFILE_NAME('leak.ifc','',(''),(''),'','','');\nENDSEC;\n";
    assert_eq!(detect_schema(stray_paren.as_bytes()), "IFC4");
}

#[test]
fn detect_schema_reads_a_doubled_apostrophe_as_part_of_the_label() {
    // `''` is an escaped apostrophe (ISO 10303-21 6.3.2.4), so the literal does
    // not end there. Taking the first `'` gave `IFC` where both header readers
    // give `IFC'4X3`, which is the two halves of one crate disagreeing about
    // the same bytes.
    let doubled = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC''4X3'));\nENDSEC;\nDATA;\nENDSEC;\n";
    assert_eq!(detect_schema(doubled.as_bytes()), "IFC'4X3");

    // Un-doubled here so `escape()` can re-double it, exactly as the backslash
    // case above does. Without that the doubling COMPOUNDS every time a file
    // goes through the merge path. Returning the raw slice also disagreed with
    // `parse_source_header`, which decodes, so one crate answered two different
    // things about the same bytes.

    // A file truncated inside its own label has no label. This used to compute
    // an end index one short of the start: it underflowed in debug and panicked
    // on the slice in release, on attacker-supplied bytes.
    let truncated = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3";
    assert_eq!(detect_schema(truncated.as_bytes()), "IFC4");
    let bare_quote = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('";
    assert_eq!(detect_schema(bare_quote.as_bytes()), "IFC4");
}

#[test]
fn detect_schema_ignores_endsec_literal_text_inside_a_quoted_string() {
    // Bug: the header-end scan for `ENDSEC;` was a raw byte search with
    // no quote awareness. A header field whose string VALUE happens to
    // contain the literal text `ENDSEC;` truncates the header early,
    // before the real FILE_SCHEMA entry is ever reached, silently
    // falling back to the IFC4 default.
    let content =
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('note: not an ENDSEC; marker'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
            .to_string();
    assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
}

#[test]
fn detect_schema_ignores_file_schema_literal_text_inside_a_quoted_string() {
    // Bug: the FILE_SCHEMA locate was also a raw byte search with no
    // quote awareness. A header field whose string VALUE embeds the
    // literal text `FILE_SCHEMA` before the real entry causes the scan
    // to match inside the quoted field instead, and the quote-hunt that
    // follows picks up the wrong (or no) label.
    let content =
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('mentions FILE_SCHEMA in passing'),'2;1');\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
            .to_string();
    assert_eq!(detect_schema(content.as_bytes()), "IFC4X3");
}

#[test]
fn detect_schema_handles_doubled_apostrophe_escape_before_the_real_endsec() {
    // A header field value containing a literal apostrophe, escaped per
    // ISO 10303-21 by doubling (`''`), must not desynchronize the
    // quote-tracking scanner's in/out-of-string state. Wrong parity here
    // would (depending on direction) either treat real header text as
    // still-quoted or treat the ENDSEC;/FILE_SCHEMA text that follows as
    // quoted, and either way defeat the fix.
    let content =
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('O''Brien''s model'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
            .to_string();
    assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
}

/// `detect_schema` extracts the RAW (still STEP-escaped) text between the
/// first two apostrophes following `FILE_SCHEMA`. Both `step.rs`'s
/// `source_schema` fallback and `merged.rs` feed that text straight into
/// `escape()` when the header is re-written, which doubles `\` again -- so
/// `detect_schema` must un-double `\\` itself first, or a schema label
/// carrying a literal `\` would round-trip corrupted (four backslashes out
/// for two in). No real schema label (IFC2X3, IFC4, IFC4X3_ADD2, ...)
/// contains a backslash, so this never fires on a real file; this test pins
/// the un-double -> re-escape seam with a synthetic label.
#[test]
fn detect_schema_un_doubles_backslash_before_escape_re_doubles_it() {
    let source = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC\\\\4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    assert_eq!(detect_schema(source.as_bytes()), "IFC\\4");
}
