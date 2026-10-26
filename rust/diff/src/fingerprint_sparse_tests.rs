// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::input::{PropertySetInput, QuantitySetInput, TypeAssignmentInput};
use crate::sparse_collection::{Slot, SparseCollection};

fn holes<T>(count: usize) -> SparseCollection<T> {
    SparseCollection((0..count).map(|_| Slot::Hole).collect())
}

#[test]
fn issue_8042_sparse_json_and_stable_tokens_are_distinct() {
    for (count, json, stable) in [(1, "[null]", "[]"), (2, "[null,null]", "[,]")] {
        let value = JsonValue::Array(sorted_entries(&holes(count)));
        assert_eq!(stringify(&value), json);
        assert_eq!(stringify_sorted(&value), stable);
    }
    let dense_null = JsonValue::Array(vec![JsonValue::Null]);
    assert_eq!(stringify_sorted(&dense_null), "[null]");
}

#[test]
fn issue_8042_sorted_entries_keep_every_hole_and_duplicate() {
    let entry = |name: &str| Slot::Present(PropertyEntryInput {
        name: name.into(), value: PropertyValue::Number(f64::INFINITY),
    });
    let input = SparseCollection(vec![Slot::Hole, entry("B"), Slot::Hole, entry("A"), entry("A")]);
    let reordered = SparseCollection(vec![entry("A"), entry("B"), entry("A"), Slot::Hole, Slot::Hole]);
    let json = stringify(&JsonValue::Array(sorted_entries(&input)));
    assert_eq!(json, "[{\"name\":\"A\",\"value\":\"Infinity\"},{\"name\":\"A\",\"value\":\"Infinity\"},{\"name\":\"B\",\"value\":\"Infinity\"},null,null]");
    assert_eq!(sorted_entries(&input), sorted_entries(&reordered));
}

#[test]
fn issue_8042_all_five_locations_retain_hole_cardinality() {
    for location in 0..5 {
        let make = |count| {
            let mut input = DataFingerprintInput { ifc_type: "IfcWall".into(), ..Default::default() };
            match location {
                0 => input.property_sets = holes(count),
                1 => input.quantity_sets = holes(count),
                2 => input.type_assignments = holes::<TypeAssignmentInput>(count),
                3 => input.property_sets = vec![PropertySetInput { name: "P".into(), properties: holes(count) }].into(),
                _ => input.quantity_sets = vec![QuantitySetInput { name: "Q".into(), quantities: holes(count) }].into(),
            }
            input
        };
        assert_ne!(build_data_fingerprint(&make(0)), build_data_fingerprint(&make(1)));
        assert_ne!(build_data_fingerprint(&make(1)), build_data_fingerprint(&make(2)));
        if location >= 2 {
            assert_ne!(build_component_fingerprints(&make(1)), build_component_fingerprints(&make(2)));
        }
    }
}

#[test]
fn issue_8042_duplicate_set_ties_use_empty_hole_tokens_and_stable_order() {
    let empty = PropertySetInput { name: "D".into(), properties: holes(0) };
    let sparse = PropertySetInput { name: "D".into(), properties: holes(1) };
    let make = |sets: Vec<PropertySetInput>| DataFingerprintInput { property_sets: sets.into(), ..Default::default() };
    let forward = make(vec![empty.clone(), sparse.clone()]);
    let reverse = make(vec![sparse, empty]);
    let sorted = sorted_property_sets(&forward);
    assert_eq!(stringify_sorted(&sorted[0].1), stringify_sorted(&sorted[1].1));
    assert_ne!(build_data_fingerprint(&forward), build_data_fingerprint(&reverse));
    assert_ne!(build_component_fingerprints(&forward), build_component_fingerprints(&reverse));
}

#[test]
#[should_panic(expected = "component property sets require present records")]
fn issue_8042_native_components_reject_outer_property_set_holes() {
    let input = DataFingerprintInput { property_sets: holes(1), ..Default::default() };
    build_component_fingerprints(&input);
}

#[test]
#[should_panic(expected = "component quantity sets require present records")]
fn issue_8042_native_components_reject_outer_quantity_set_holes() {
    let input = DataFingerprintInput { quantity_sets: holes(1), ..Default::default() };
    build_component_fingerprints(&input);
}

// #8042/#8114: serialized arrays cannot express a hole, so a `null` element is
// a present value that the TypeScript oracle rejects on `.name`, never a hole.
#[test]
fn issue_8114_serialized_null_records_are_rejected_not_holes_in_every_collection() {
    use crate::document_serde::from_document;
    use crate::DocumentValue as Value;
    let object = |fields: Vec<(&str, Value)>| Value::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect());
    let set = |members: &str, content: Vec<Value>| object(vec![("name", Value::String("S".into())),
        (members, Value::Array(content))]);
    let cases = [
        ("propertySets", Value::Array(vec![Value::Null])),
        ("quantitySets", Value::Array(vec![Value::Null])),
        ("typeAssignments", Value::Array(vec![Value::Null])),
        ("propertySets", Value::Array(vec![set("properties", vec![Value::Null])])),
        ("quantitySets", Value::Array(vec![set("quantities", vec![Value::Null])])),
    ];
    for (field, value) in cases {
        let input = object(vec![("ifcType", Value::String("IfcWall".into())), (field, value)]);
        assert!(from_document::<DataFingerprintInput>(input).is_err(), "{field}: present null must not decode as a hole");
    }
}

#[test]
fn issue_8114_serialized_absent_null_and_empty_collections_stay_equivalent_and_dense() {
    use crate::document_serde::from_document;
    use crate::DocumentValue as Value;
    let decode = |field: Option<Value>| -> DataFingerprintInput {
        let mut fields = vec![("ifcType".into(), Value::String("IfcWall".into()))];
        fields.extend(field.map(|value| ("propertySets".into(), value)));
        from_document(Value::Object(fields)).unwrap()
    };
    for input in [decode(None), decode(Some(Value::Null)), decode(Some(Value::Array(vec![])))] {
        assert_eq!(input.property_sets.0.len(), 0);
    }
    let present = decode(Some(Value::Array(vec![Value::Object(vec![
        ("name".into(), Value::String("S".into())), ("properties".into(), Value::Array(vec![])),
    ])])));
    assert_eq!((present.property_sets.0.len(), present.property_sets.holes()), (1, 0));
}
