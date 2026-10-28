// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn empty_slots() -> Value {
    Value::Object(vec![("present".into(), Value::Array(vec![])), ("holes".into(), Value::Number(0.0))])
}
fn record() -> Value {
    Value::Object(vec![
        ("ifcType".into(), Value::String("IfcWall".into())),
        ("propertySets".into(), empty_slots()), ("quantitySets".into(), empty_slots()),
        ("typeAssignments".into(), empty_slots()),
        ("materials".into(), Value::Array(vec![])), ("classifications".into(), Value::Array(vec![])),
    ])
}
#[test]
fn issue_8042_packed_input_moves_lossless_strings_and_preserves_sparse_cardinality() {
    let text = JsString::from_units(vec![0xd800, 0, 65]);
    let mut value = record();
    value["name"] = Value::String(text.clone());
    value["typeAssignments"]["holes"] = Value::Number(7.0);
    value["propertySets"]["present"] = Value::Array(vec![Value::Object(vec![
        ("name".into(), Value::String("P".into())),
        ("members".into(), Value::Object(vec![
            ("holes".into(), Value::Number(2.0)),
            ("present".into(), Value::Array(vec![Value::Object(vec![
                ("name".into(), Value::String("V".into())), ("value".into(), Value::String(text.clone())),
            ])])),
        ])),
    ])]);
    let inputs = decode_inputs(Value::Array(vec![value])).unwrap();
    assert_eq!(inputs[0].name.as_ref().unwrap().units(), &[0xd800, 0, 65]);
    // Ownership invariant: no UTF-8 round trip or second UTF-16 allocation.
    assert_eq!(inputs[0].name.as_ref().unwrap().units().as_ptr(), text.units().as_ptr());
    assert_eq!(inputs[0].type_assignments.holes(), 7);
    let set = inputs[0].property_sets.present().next().unwrap();
    assert_eq!(set.properties.holes(), 2);
    assert_eq!(set.properties.present().next().unwrap().value, PropertyValue::String(text));
}
#[test]
fn issue_8042_packed_input_refuses_bad_fields_and_hole_counts() {
    for holes in [-1.0, 0.5, f64::INFINITY, f64::NAN] {
        let mut value = record(); value["propertySets"]["holes"] = Value::Number(holes);
        assert!(decode_inputs(Value::Array(vec![value])).is_err());
    }
    let mut value = record(); value["name"] = Value::Bool(true);
    assert!(decode_inputs(Value::Array(vec![value])).is_err());
    let Value::Object(mut fields) = record() else { unreachable!() };
    fields.push(("ifcType".into(), Value::String("IfcDoor".into())));
    assert!(decode_inputs(Value::Array(vec![Value::Object(fields)])).is_err());
    assert!(decode_inputs(Value::Array(vec![Value::Object(vec![])])).is_err());
}
