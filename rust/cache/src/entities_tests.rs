// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::HashSet;

use super::*;

fn entity(id: u32, type_name: &str, name: Option<&str>) -> EntityMetadata {
    EntityMetadata {
        entity_id: id,
        type_name: type_name.to_owned(),
        global_id: Some(format!("guid-{id}")),
        name: name.map(str::to_owned),
        description: None,
        object_type: None,
        tag: None,
        predefined_type: None,
        has_geometry: type_name == "IFCWALL",
    }
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

#[test]
fn section_is_columnar_with_triples_before_the_raw_type_column() {
    let mut strings = StringTable::new();
    let rows = [
        entity(10, "IFCWALL", Some("W")),
        entity(11, "IFCSLAB", None),
        entity(12, "IFCWALL", Some("W")),
    ];
    let bytes = write_entities(&mut strings, &rows, &RowFacts::default());
    let n = rows.len();
    let triples_at = 4 + n * (4 + 2 + 4 * 4 + 1 + 4 * 3);
    assert_eq!(word(&bytes, 0), 3);
    // Two distinct types, IfcWall spanning rows 0..3 though row 1 interleaves.
    assert_eq!(u16::from_le_bytes([bytes[triples_at], bytes[triples_at + 1]]), 2);
    assert_eq!(word(&bytes, triples_at + 4), 0);
    assert_eq!(word(&bytes, triples_at + 8), 3);
    assert_eq!(bytes.len(), triples_at + 2 + 2 * 10 + n * 4);
}

#[test]
fn a_dollar_name_is_the_null_index_and_types_are_flagged() {
    let mut strings = StringTable::new();
    let rows = [entity(1, "IFCSLAB", None), entity(2, "IFCWALLTYPE", Some("T"))];
    let bytes = write_entities(&mut strings, &rows, &RowFacts::default());
    let name_at = 4 + 2 * 4 + 2 * 2 + 2 * 4;
    assert_eq!(word(&bytes, name_at), crate::strings::NULL_INDEX);
    let flags_at = 4 + 2 * (4 + 2 + 4 * 4);
    assert_eq!(bytes[flags_at], 0);
    assert_eq!(bytes[flags_at + 1], flags::IS_TYPE);
}

#[test]
fn raw_type_name_is_the_pascal_case_schema_name() {
    let ty = ifc_type_from_keyword("IFCPUMP");
    assert_eq!(canonical_name(&ty, "IFCPUMP"), "IfcPump");
    let unknown = ifc_type_from_keyword("IFCNOTACLASS");
    assert_eq!(canonical_name(&unknown, "IFCNOTACLASS"), "IFCNOTACLASS");
}

#[test]
fn issue_4930_an_explicit_empty_name_is_the_empty_slot_not_the_null_index() {
    let mut strings = StringTable::new();
    let rows = [entity(1, "IFCSLAB", None), entity(2, "IFCSLAB", None)];
    let facts = RowFacts { empty_names: HashSet::from([2]), ..RowFacts::default() };
    let bytes = write_entities(&mut strings, &rows, &facts);
    let name_at = 4 + 2 * 4 + 2 * 2 + 2 * 4;
    assert_eq!(word(&bytes, name_at), crate::strings::NULL_INDEX, "`$` stays absent");
    assert_eq!(word(&bytes, name_at + 4), 0, "`''` is the empty string, slot 0");
}

#[test]
fn issue_4666_has_geometry_is_the_rows_own_representation_not_the_class_guess() {
    let mut strings = StringTable::new();
    // Both rows are IfcWall, which the data model flags by class; only #2 has a body.
    let rows = [entity(1, "IFCWALL", Some("W")), entity(2, "IFCWALL", Some("W"))];
    let facts = RowFacts { own_representation: HashSet::from([2]), ..RowFacts::default() };
    let bytes = write_entities(&mut strings, &rows, &facts);
    let flags_at = 4 + 2 * (4 + 2 + 4 * 4);
    assert_eq!([bytes[flags_at], bytes[flags_at + 1]], [0, flags::HAS_GEOMETRY]);
}
