// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Hashes and component insertion order from the actual TypeScript engine.
use ifc_lite_diff::{DataFingerprintInput, DocumentValue as Value,
    build_data_fingerprint, build_component_fingerprint_entries,
    document_serde::from_document, sidecar_document::parse_ordered_json};
#[test]
fn issue_8042_all_fingerprint_strings_preserve_utf16_and_component_order() {
    let corpus = parse_ordered_json(include_str!("fingerprint_utf16_vectors.json")).unwrap();
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
