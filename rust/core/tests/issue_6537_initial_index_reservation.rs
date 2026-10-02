// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6537: bytes that are comments must not cause source-sized index allocation.
//! The reservation budget bounds initial allocation, never accepted records.
use ifc_lite_core::{build_entity_index, ColumnarEntityIndex};

const HEADER: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n";

#[test]
fn sparse_comment_input_has_bounded_table_and_preserves_last_duplicate() {
    let mut content = String::from(HEADER);
    content.push_str("/*");
    content.extend(std::iter::repeat_n(' ', 8 * 1024 * 1024));
    content.push_str("*/\n#7=IFCCARTESIANPOINT((1.,2.,3.));\n#11=IFCLABEL('quoted #99=IFCLABEL(''not a record'');');\n");
    let last = content.len();
    let replacement = "#7=IFCCARTESIANPOINT((4.,5.,6.));";
    content.push_str(replacement);
    content.push_str("\nENDSEC;END-ISO-10303-21;");
    let map = build_entity_index(&content);
    assert_eq!(map.len(), 2);
    assert!(map.capacity() <= 131_072, "two actual records must not reserve a table proportional to 8 MiB of comments; capacity={}", map.capacity());
    assert_eq!(map.get(&7), Some(&(last, last + replacement.len())));
    assert!(!map.contains_key(&99));
    let columns = ColumnarEntityIndex::from_scan(&content);
    assert_eq!(columns.len(), map.len());
    for (&id, &span) in &map { assert_eq!(columns.lookup(id), Some(span)); }
}

#[test]
fn dense_input_grows_past_initial_budget_without_losing_any_record() {
    let mut content = String::from(HEADER);
    let mut expected = Vec::new();
    for id in 1..=140_000u32 {
        let start = content.len();
        content.push_str(&format!("#{id}=IFCCARTESIANPOINT((1.,2.,3.));"));
        expected.push((id, start, content.len()));
        content.push('\n');
    }
    content.push_str("ENDSEC;END-ISO-10303-21;");
    let map = build_entity_index(&content);
    let columns = ColumnarEntityIndex::from_scan(&content);
    assert_eq!(map.len(), expected.len());
    assert_eq!(columns.len(), expected.len());
    for (id, start, end) in expected {
        assert_eq!(map.get(&id), Some(&(start, end)));
        assert_eq!(columns.lookup(id), Some((start, end)));
    }
}
