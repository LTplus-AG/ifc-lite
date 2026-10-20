// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fixed anti-vacuity corpus for the positional-read scanner.
//!
//! This oracle is intentionally independent of `read_scan::ACCESSORS` and the
//! production allowlist. Its exact sites ensure every supported reader stays
//! visible even after legitimate source debt reaches zero.

use super::read_scan::{Read, Reads};

pub const CORPUS: &str = "fn canary(entity: &Entity, bytes: &[u8], parts: &[u8], i: usize) {\n\
    entity.get(1);\n\
    entity.get_ref(2);\n\
    entity.get_refs(3);\n\
    entity.get_float(4);\n\
    entity.get_string(5);\n\
    entity.get_list(6);\n\
    entity.is_present(7);\n\
    entity.attr(8);\n\
    entity.ref_at(9);\n\
    entity.ref_list_at(10);\n\
    entity.real_at(11);\n\
    entity.int_at(12);\n\
    entity.string_at(13);\n\
    entity.enum_at(14);\n\
    entity.logical_at(15);\n\
    entity.binary_at(16);\n\
    entity.list_at(17);\n\
    let _ = entity.attributes[18];\n\
    nth_attr(bytes, 19);\n\
    nth_attr_int(bytes, 0, 20);\n\
    nth_attribute_is_present(bytes, 21);\n\
    parts.get(22); // not-an-attribute: slice position\n\
    entity.get(slot::IfcWall::NAME.index());\n\
    entity.attr(SLOT);\n\
    entity.get(i + 1);\n\
    // entity.get(23);\n\
    let _text = \"entity.get_ref(24)\";\n\
    #[cfg(test)]\n\
    mod tests { fn ignored() { entity.get(25); } }\n\
    #[test]\n\
    fn ignored_test_item() { entity.get(26); }\n\
    fn production_after_test_items() { entity.get_ref(27); }\n\
}\n";

// Expected `(line, text)` pairs are fixed independently of the corpus scanner.
const EXPECTED_COUNTED: &[(usize, &str)] = &[
    (2, "get(1)"),
    (3, "get_ref(2)"),
    (4, "get_refs(3)"),
    (5, "get_float(4)"),
    (6, "get_string(5)"),
    (7, "get_list(6)"),
    (8, "is_present(7)"),
    (9, "attr(8)"),
    (10, "ref_at(9)"),
    (11, "ref_list_at(10)"),
    (12, "real_at(11)"),
    (13, "int_at(12)"),
    (14, "string_at(13)"),
    (15, "enum_at(14)"),
    (16, "logical_at(15)"),
    (17, "binary_at(16)"),
    (18, "list_at(17)"),
    (19, "attributes[18]"),
    (20, "nth_attr(19)"),
    (21, "nth_attr_int(20)"),
    (22, "nth_attribute_is_present(21)"),
    (33, "get_ref(27)"),
];
const EXPECTED_MARKED: &[(usize, &str)] = &[(23, "get(22)")];

fn sites(reads: &[Read]) -> Vec<(usize, String)> {
    reads.iter().map(|read| (read.line, read.text.clone())).collect()
}

/// Validate arbitrary scanner output so tests can prove that empty and
/// partially blind scanner results fail with a recognizable diagnostic.
pub fn validate(reads: &Reads) -> Result<(), String> {
    let expected_counted: Vec<(usize, String)> = EXPECTED_COUNTED.iter().map(|&(line, text)| (line, text.into())).collect();
    let expected_marked: Vec<(usize, String)> = EXPECTED_MARKED.iter().map(|&(line, text)| (line, text.into())).collect();
    let actual_counted = sites(&reads.counted);
    let actual_marked = sites(&reads.marked);
    if actual_counted != expected_counted || actual_marked != expected_marked {
        return Err(format!(
            "scanner canary: expected {} counted sites {expected_counted:?} and marked sites {expected_marked:?}; found counted sites {actual_counted:?} and marked sites {actual_marked:?}",
            expected_counted.len()
        ));
    }
    Ok(())
}

pub fn assert_scanner_canary(scan: impl Fn(&str) -> Reads) {
    validate(&scan(CORPUS)).unwrap_or_else(|error| panic!("{error}"));
}
