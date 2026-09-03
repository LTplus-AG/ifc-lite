// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parser/scanner.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `rust/core/src/columnar_index.rs` / `columnar_index_tests.rs`), which
//! also keeps `scanner.rs` inside its module-size ratchet budget.

use super::*;

#[test]
fn test_entity_scanner() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,$,$);
#3=IFCDOOR('guid3',$,$,$,$,$,$,$);
#4=IFCWALL('guid4',$,$,$,$,$,$,$);
"#;

    let mut scanner = EntityScanner::new(content);

    // Test next_entity
    let (id, type_name, _, _) = scanner.next_entity().unwrap();
    assert_eq!(id, 1);
    assert_eq!(type_name, "IFCPROJECT");

    // Test find_by_type
    scanner.reset();
    let walls = scanner.find_by_type("IFCWALL");
    assert_eq!(walls.len(), 2);
    assert_eq!(walls[0].0, 2);
    assert_eq!(walls[1].0, 4);

    // Test count_by_type
    scanner.reset();
    let counts = scanner.count_by_type();
    assert_eq!(counts.get("IFCPROJECT"), Some(&1));
    assert_eq!(counts.get("IFCWALL"), Some(&2));
    assert_eq!(counts.get("IFCDOOR"), Some(&1));
}

/// Regression for issue #654: CATIA exports a FILE_NAME whose first
/// argument contains a literal `#` inside the quoted string (the encoded
/// filename `'…\X0\2#.ifc'`). The scanner used to latch onto that `#`,
/// flip `find_entity_end`'s quote parity at the closing `'`, and silently
/// drop every entity in the file.
#[test]
fn test_entity_scanner_hash_in_header_filename() {
    let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n\
FILE_NAME('26-IFC\\X2\\00B1\\X0\\2#.ifc','2026-04-29T18:21:27',$,$,'CATIA','CATIA',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('guid2',$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    let mut scanner = EntityScanner::new(content);
    let counts = scanner.count_by_type();
    assert_eq!(counts.get("IFCPROJECT"), Some(&1));
    assert_eq!(counts.get("IFCWALL"), Some(&1));
}

/// Files without a DATA; marker (partial fragments, test fixtures) must
/// still scan from offset 0 — the HEADER-skip is best-effort.
#[test]
fn test_entity_scanner_no_header() {
    let content = "#1=IFCWALL('guid',$,$,$,$,$,$,$);\n";
    let mut scanner = EntityScanner::new(content);
    let (id, type_name, _, _) = scanner.next_entity().unwrap();
    assert_eq!(id, 1);
    assert_eq!(type_name, "IFCWALL");
}

/// HEADER fields are free-form strings — a description, comment, or
/// embedded filename could legally contain the literal text `DATA;`.
/// The seek must ignore matches inside quoted strings and land on the
/// real section marker.
#[test]
fn test_entity_scanner_data_marker_inside_header_string() {
    let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('section DATA; in description'),'2;1');\n\
FILE_NAME('weird DATA; name.ifc','2026-04-29T18:21:27',$,$,'a','b',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCWALL('guid',$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    let mut scanner = EntityScanner::new(content);
    let counts = scanner.count_by_type();
    assert_eq!(counts.get("IFCWALL"), Some(&1));
    // Confirm we landed at the real DATA;, not the one in the description.
    let pos = scanner.position();
    assert!(pos == content.len() || pos > content.find("ENDSEC;").unwrap());
}

/// `count` / `entity_count` must agree with the number of entities the
/// scanner walks (and with the entity index), while allocating nothing per
/// entity. It shares `next_entity`, so it inherits the header-skip and the
/// quote/comment guards for free.
#[test]
fn test_entity_count_matches_scan() {
    let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('has a #99 and DATA; inside'),'2;1');\n\
FILE_NAME('26-IFC\\X2\\00B1\\X0\\2#.ifc','2026-04-29T18:21:27',$,$,'a','b',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n\
/* a comment with #77= IFCWALL inside */\n\
#2=IFCWALL('guid2',$,$,$,'name with ; semicolon',$,$,$);\n\
#3=IFCDOOR('guid3',$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    // Free function.
    assert_eq!(entity_count(content), 3);
    // Method, from a fresh scanner.
    assert_eq!(EntityScanner::new(content).count(), 3);
    // Agrees with the per-type tally (which walks the same entities).
    let total: usize = EntityScanner::new(content).count_by_type().values().sum();
    assert_eq!(total, 3);
}

/// An empty / header-only buffer counts zero, never panics.
#[test]
fn test_entity_count_empty() {
    assert_eq!(entity_count(""), 0);
    assert_eq!(entity_count("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\n"), 0);
}

/// Issue #3395: an instance name above `u32::MAX` used to WRAP
/// (`wrapping_mul`/`wrapping_add`), so `#4294967297` was yielded as id `1`
/// and served entity `#1`'s span to everything downstream. It must be
/// skipped instead — and skipping it must not end the scan, or a single
/// oversized record would truncate the model from that byte on.
#[test]
fn test_entity_scanner_skips_express_id_above_u32() {
    let content = "#1=IFCWALL('a');\n#4294967297=IFCWALL('b');\n#2=IFCDOOR('c');\n";

    let mut scanner = EntityScanner::new(content);
    let mut ids = Vec::new();
    while let Some((id, _type_name, _start, _end)) = scanner.next_entity() {
        ids.push(id);
    }

    // Not [1, 1, 2]: the oversized record is gone, not aliased onto #1.
    // Not [1]: the records after it still load.
    assert_eq!(ids, vec![1, 2]);
    assert_eq!(scanner.skipped_oversized_ids(), 1);
}

/// The bound is inclusive: `u32::MAX` is a legitimate instance name and
/// must still load. A threshold has two directions.
#[test]
fn test_entity_scanner_admits_express_id_at_u32_max() {
    let content = "#4294967295=IFCWALL('a');\n#1=IFCDOOR('b');\n";

    let mut scanner = EntityScanner::new(content);
    let mut ids = Vec::new();
    while let Some((id, _type_name, _start, _end)) = scanner.next_entity() {
        ids.push(id);
    }

    assert_eq!(ids, vec![u32::MAX, 1]);
    assert_eq!(scanner.skipped_oversized_ids(), 0);
}

/// A run of leading zeros is longer than 9 digits but still small, so it
/// must take the checked path and come out exact rather than being refused
/// on length alone.
#[test]
fn test_entity_scanner_leading_zero_padded_id() {
    let content = "#0000000000000042=IFCWALL('a');\n";

    let mut scanner = EntityScanner::new(content);
    let (id, type_name, _, _) = scanner.next_entity().unwrap();
    assert_eq!(id, 42);
    assert_eq!(type_name, "IFCWALL");
    assert_eq!(scanner.skipped_oversized_ids(), 0);
}

/// Escaped single quotes (`''`) keep the string open per ISO 10303-21.
#[test]
fn test_entity_scanner_escaped_quote_in_header() {
    let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('it''s fine: DATA; inside'),'2;1');\n\
FILE_NAME('a','b',$,$,'c','d',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#7=IFCDOOR('guid',$,$,$,$,$,$,$);\n\
ENDSEC;\n";

    let mut scanner = EntityScanner::new(content);
    let counts = scanner.count_by_type();
    assert_eq!(counts.get("IFCDOOR"), Some(&1));
}

// ---------------------------------------------------------------------------
// A comment is trivia INSIDE a record too.
//
// ISO 10303-21 allows a comment anywhere whitespace is allowed. This scanner
// used to skip one only BETWEEN records, so two spec-legal shapes misparsed:
// `#1 /* n */ = IFCWALL(…);` failed the '=' check and produced no record at
// all, and `#2=IFCWALL('a', /* n; */ $);` ended at the ';' inside the comment,
// handing a truncated span to every downstream decoder.
//
// The TypeScript twins of these cases live in
// `packages/parser/test/step-comment-trivia.test.ts`; the two halves are a
// matched pair and must be changed together.
// ---------------------------------------------------------------------------

/// Every record `content` declares, as `(id, type, the bytes the scanner
/// claims it spans)`.
fn scan_spans(content: &str) -> Vec<(u32, String, String)> {
    let mut scanner = EntityScanner::new(content);
    let mut out = Vec::new();
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        out.push((id, type_name.to_string(), content[start..end].to_string()));
    }
    out
}

const DATA_PREAMBLE: &str = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n";

fn data_file(records: &[&str]) -> String {
    format!(
        "{DATA_PREAMBLE}{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    )
}

#[test]
fn comment_between_instance_name_and_equals_is_trivia() {
    let record = "#1 /* was #7 */ = IFCWALL('a',$);";
    assert_eq!(
        scan_spans(&data_file(&[record])),
        vec![(1, "IFCWALL".to_string(), record.to_string())]
    );
}

#[test]
fn semicolon_inside_a_comment_does_not_end_the_record() {
    let record = "#2=IFCWALL('a', /* pending; revise */ $);";
    assert_eq!(
        scan_spans(&data_file(&[record])),
        vec![(2, "IFCWALL".to_string(), record.to_string())]
    );
}

/// A comment between the `=` and the type name must not be read AS the type
/// name, and an `=` inside such a comment must not be mistaken for the
/// record's own — the `=` position comes from the validating walk, not from a
/// search over the record's bytes.
#[test]
fn comment_between_equals_and_type_name_is_trivia() {
    let record = "#3 /* a=b */ = /* c */ IFCWALL /* d */ ('a',$);";
    assert_eq!(
        scan_spans(&data_file(&[record])),
        vec![(3, "IFCWALL".to_string(), record.to_string())]
    );
}

/// Composition, direction one: a comment opener inside a string literal is
/// ordinary text.
#[test]
fn comment_opener_inside_a_string_literal_is_literal_text() {
    let record = "#4=IFCWALL('rev /* pending */ note',$);";
    assert_eq!(
        scan_spans(&data_file(&[record])),
        vec![(4, "IFCWALL".to_string(), record.to_string())]
    );
}

/// Composition, direction two: a quote inside a comment does not open a
/// string. An in-comment apostrophe used to flip the terminator scan's quote
/// parity and swallow the record's `;`.
#[test]
fn quote_inside_a_comment_is_comment_text() {
    let record = "#5=IFCWALL(/* don't reuse */ 'a',$);";
    assert_eq!(
        scan_spans(&data_file(&[record])),
        vec![(5, "IFCWALL".to_string(), record.to_string())]
    );
}

#[test]
fn records_after_a_commented_one_still_scan() {
    let first = "#7 /* x */ = IFCWALL('a', /* y; */ $);";
    let second = "#8=IFCSLAB('b',$);";
    assert_eq!(
        scan_spans(&data_file(&[first, second])),
        vec![
            (7, "IFCWALL".to_string(), first.to_string()),
            (8, "IFCSLAB".to_string(), second.to_string()),
        ]
    );
}

/// The pre-existing rule this must not break: a record that is entirely
/// inside a comment is not a record.
#[test]
fn a_commented_out_record_is_still_not_a_record() {
    let live = "#10=IFCSLAB('b',$);";
    assert_eq!(
        scan_spans(&data_file(&["/* #9=IFCWALL('x',$); */", live])),
        vec![(10, "IFCSLAB".to_string(), live.to_string())]
    );
}

/// An unterminated comment inside a record leaves it with no terminator, so
/// the record is refused and the scan ends — the same answer
/// `skip_step_comment` gives, rather than inventing an end.
#[test]
fn unterminated_comment_inside_a_record_ends_the_scan() {
    let content = data_file(&["#11=IFCWALL('a', /* never closes $);"]);
    assert_eq!(scan_spans(&content), vec![]);
}

#[test]
fn comment_free_records_scan_unchanged() {
    let first = "#11=IFCWALL('a',$);";
    let second = "#12=IFCSLAB($,$);";
    assert_eq!(
        scan_spans(&data_file(&[first, second])),
        vec![
            (11, "IFCWALL".to_string(), first.to_string()),
            (12, "IFCSLAB".to_string(), second.to_string()),
        ]
    );
}

// ---------------------------------------------------------------------------
// `has_non_null_attribute`: the scanner's span is now comment-aware (above),
// but the attribute-decode layer -- this function included -- was still
// comment-blind (#3673's follow-up note). A comment preceding a `$` used to
// read as a non-null value, because the leading-whitespace skip stopped at
// the comment's own `/` rather than treating the comment as trivia too.
// ---------------------------------------------------------------------------

#[test]
fn has_non_null_attribute_treats_a_comment_before_dollar_as_still_null() {
    let content = "#1=IFCWALL(/* c1 */ $);";
    let scanner = EntityScanner::new(content);
    assert!(!scanner.has_non_null_attribute(0, content.len(), 0));
}

#[test]
fn has_non_null_attribute_treats_a_comment_before_a_value_as_non_null() {
    let content = "#1=IFCWALL(/* c1 */ 'a');";
    let scanner = EntityScanner::new(content);
    assert!(scanner.has_non_null_attribute(0, content.len(), 0));
}

/// A comma inside a comment must not count as an attribute separator: the
/// real target attribute (index 1) is the `$` after the comment, not the
/// comment's own `b'` fragment.
#[test]
fn has_non_null_attribute_comma_inside_a_comment_does_not_split_attributes() {
    let content = "#1=IFCWALL('a', /* x, y */ $);";
    let scanner = EntityScanner::new(content);
    assert!(!scanner.has_non_null_attribute(0, content.len(), 1));
}

/// A `$` written literally inside a comment must not fool the check the other
/// way: attribute 0 here is `'a'`, not the comment's `$`.
#[test]
fn has_non_null_attribute_dollar_inside_a_comment_is_comment_text() {
    let content = "#1=IFCWALL(/* was $ */ 'a');";
    let scanner = EntityScanner::new(content);
    assert!(scanner.has_non_null_attribute(0, content.len(), 0));
}

#[test]
fn has_non_null_attribute_comment_free_records_unchanged() {
    let content = "#1=IFCWALL('a',$,5);";
    let scanner = EntityScanner::new(content);
    assert!(scanner.has_non_null_attribute(0, content.len(), 0));
    assert!(!scanner.has_non_null_attribute(0, content.len(), 1));
    assert!(scanner.has_non_null_attribute(0, content.len(), 2));
}
