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
