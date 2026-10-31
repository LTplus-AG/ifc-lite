// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Hashes and component insertion order from the actual TypeScript engine.
use ifc_lite_diff::{DataFingerprintInput, DocumentValue as Value,
    build_data_fingerprint, build_component_fingerprint_entries,
    document_serde::from_document, sidecar_document::parse_ordered_json};
#[test]
fn issue_8042_all_fingerprint_strings_preserve_utf16_and_component_order() {
    let corpus = parse_ordered_json(include_str!("fixtures/fingerprint_utf16_vectors.json")).unwrap();
    let cases = corpus.as_array().unwrap();
    assert_eq!(cases.len(), 57);
    for case in cases {
        let input: DataFingerprintInput = from_document(case["input"].clone()).unwrap();
        assert_eq!(build_data_fingerprint(&input), case["hash"].as_str().unwrap(), "{:?}", case["name"]);
        let components = Value::Array(build_component_fingerprint_entries(&input).into_iter()
            .map(|(key, hash)| Value::Array(vec![Value::String(key), Value::String(hash.into())])).collect());
        assert_eq!(components, case["components"], "{:?}", case["name"]);
    }
}

#[test]
fn issue_8042_document_dto_preserves_negative_zero_and_nonfinite_property_numbers() {
    use ifc_lite_diff::{DataFingerprintInput, PropertyValue};
    let numbers = [-0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY];
    for number in numbers {
        let input: DataFingerprintInput = from_document(Value::Object(vec![
            ("propertySets".into(), Value::Array(vec![Value::Object(vec![
                ("name".into(), Value::String("set".into())),
                ("properties".into(), Value::Array(vec![Value::Object(vec![
                    ("name".into(), Value::String("value".into())),
                    ("value".into(), Value::Number(number)),
                ])])),
            ])])),
        ])).unwrap();
        let set = input.property_sets.present().next().expect("present property set");
        let entry = set.properties.present().next().expect("present property");
        let PropertyValue::Number(actual) = entry.value else { panic!("expected number") };
        assert_eq!(actual.to_bits(), number.to_bits());
    }
}

#[test]
fn issue_8042_lazy_scalar_view_does_not_change_string_identity() {
    use std::{collections::{HashMap, BTreeSet}, hash::{DefaultHasher, Hash, Hasher}};
    use ifc_lite_diff::JsString;
    for units in [vec![0xd800], vec![0xd800, 0xdc00], vec![65, 0, 66]] {
        let value = JsString::from_units(units.clone());
        let clone = value.clone();
        let independent = JsString::from_units(units);
        let hash = |s: &JsString| { let mut h = DefaultHasher::new(); s.hash(&mut h); h.finish() };
        let before = hash(&value);
        let map = HashMap::from([(value.clone(), 42)]);
        let order = BTreeSet::from([value.clone()]);
        let _ = clone.as_str();
        assert_eq!(hash(&value), before);
        assert_eq!(value, independent);
        assert_eq!(map.get(&independent), Some(&42));
        assert!(order.contains(&independent));
    }
}
