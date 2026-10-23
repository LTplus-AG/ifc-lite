// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Byte-exact parity against the TypeScript engine.
//!
//! The expected values in `fingerprint_vectors.json` are the output of
//! `packages/diff/dist`, produced by running it rather than transcribing it
//! (`scripts/diff-parity-vectors.mjs`). A failure here means the two engines
//! disagree, which is a real defect in one of them: `@ifc-lite/merge` consumes
//! `stableHash` for its component snapshots, so a divergent hash would surface
//! as spurious merge conflicts rather than as a test failure.
//!
//! Note on object-valued properties: `serde_json`'s default map is sorted, so
//! the two `object-valued-property-key-order-*` cases arrive here already
//! normalized and cannot prove that this crate sorts them. That the sorting
//! exists and differs from insertion order is covered directly by the
//! `stringify` / `stringify_sorted` unit tests in `src/js_json_tests.rs`.

use std::collections::BTreeMap;

use ifc_lite_diff::input::{
    DataFingerprintInput, PropertyEntryInput, PropertySetInput, PropertyValue, QuantitySetInput,
    TypeAssignmentInput,
};
use ifc_lite_diff::{build_component_fingerprints, build_data_fingerprint, stable_hash};
use serde_json::Value;

const VECTORS: &str = include_str!("fingerprint_vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("fingerprint_vectors.json is not valid JSON")
}

fn opt_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Lift a fixture value into the crate's property-value type.
///
/// `null` is reached both by an explicit JSON `null` and by an absent key; the
/// engine treats the two alike, so no distinction is needed.
fn property_value(value: &Value) -> PropertyValue {
    match value {
        Value::Null => PropertyValue::Null,
        Value::Bool(flag) => PropertyValue::Bool(*flag),
        Value::Number(number) => PropertyValue::Number(
            number
                .as_f64()
                .expect("every fixture number is representable as f64"),
        ),
        Value::String(text) => PropertyValue::String(text.clone()),
        Value::Array(items) => PropertyValue::Array(items.iter().map(property_value).collect()),
        // JSON cannot hold a non-finite number, so the generator tags them.
        // Without this the fixture would hand us `null` where the expected
        // hash was computed from `NaN`, and the case would silently assert
        // something it does not carry.
        // Exact IEEE-754 bits, used where a case's subject IS number
        // formatting. `serde_json` does not round every decimal literal the
        // way V8 does -- it reads `123456789012345680000` one ULP low -- so a
        // formatting case carrying a decimal would fail against a correct
        // implementation. The `approx` sibling is for human review only.
        Value::Object(entries) if entries.contains_key("$f64") => {
            let hex = entries["$f64"].as_str().expect("$f64 tag is not a string");
            let bits = u64::from_str_radix(hex, 16).expect("$f64 tag is not hex");
            PropertyValue::Number(f64::from_bits(bits))
        }
        Value::Object(entries) if entries.len() == 1 && entries.contains_key("$nonfinite") => {
            let token = entries["$nonfinite"]
                .as_str()
                .expect("$nonfinite tag is not a string");
            PropertyValue::Number(match token {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                other => panic!("unrecognised $nonfinite token {other:?}"),
            })
        }
        Value::Object(entries) => PropertyValue::Object(
            entries
                .iter()
                .map(|(key, item)| (key.clone(), property_value(item)))
                .collect(),
        ),
    }
}

fn entries(value: &Value, key: &str) -> Vec<PropertyEntryInput> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| PropertyEntryInput {
                    name: opt_string(item, "name").unwrap_or_default(),
                    value: item.get("value").map(property_value).unwrap_or(PropertyValue::Null),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_input(value: &Value) -> DataFingerprintInput {
    DataFingerprintInput {
        ifc_type: opt_string(value, "ifcType").unwrap_or_default(),
        name: opt_string(value, "name"),
        description: opt_string(value, "description"),
        object_type: opt_string(value, "objectType"),
        predefined_type: opt_string(value, "predefinedType"),
        tag: opt_string(value, "tag"),
        property_sets: value
            .get("propertySets")
            .and_then(Value::as_array)
            .map(|sets| {
                sets.iter()
                    .map(|set| PropertySetInput {
                        name: opt_string(set, "name").unwrap_or_default(),
                        properties: entries(set, "properties"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        quantity_sets: value
            .get("quantitySets")
            .and_then(Value::as_array)
            .map(|sets| {
                sets.iter()
                    .map(|set| QuantitySetInput {
                        name: opt_string(set, "name").unwrap_or_default(),
                        quantities: entries(set, "quantities"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        type_assignments: value
            .get("typeAssignments")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| TypeAssignmentInput {
                        name: opt_string(item, "name"),
                        // `globalId` is present in the fixture precisely so a
                        // regression that started hashing it would show up as
                        // a mismatch. It has no field to land in here.
                        type_name: opt_string(item, "type"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        materials: string_list(value, "materials"),
        classifications: string_list(value, "classifications"),
    }
}

#[test]
fn stable_hash_matches_the_typescript_engine() {
    let vectors = vectors();
    let cases = vectors["stableHash"]
        .as_array()
        .expect("stableHash vectors missing");
    assert!(!cases.is_empty(), "fixture carries no stableHash vectors");

    for case in cases {
        let value = case["value"].as_str().expect("vector value is not a string");
        let expected = case["hash"].as_str().expect("vector hash is not a string");
        assert_eq!(
            stable_hash(value),
            expected,
            "stable_hash disagreed for {value:?}",
        );
    }
}

#[test]
fn fingerprints_match_the_typescript_engine() {
    let vectors = vectors();
    let cases = vectors["fingerprints"]
        .as_array()
        .expect("fingerprint vectors missing");
    assert!(!cases.is_empty(), "fixture carries no fingerprint cases");

    for case in cases {
        let id = case["id"].as_str().unwrap_or("<unnamed>");
        let input = parse_input(&case["input"]);

        let expected_data = case["dataHash"].as_str().expect("dataHash is not a string");
        assert_eq!(
            build_data_fingerprint(&input),
            expected_data,
            "dataHash disagreed for case {id:?}",
        );

        let expected_components: BTreeMap<String, String> = case["components"]
            .as_object()
            .expect("components is not an object")
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    value
                        .as_str()
                        .expect("component hash is not a string")
                        .to_owned(),
                )
            })
            .collect();

        assert_eq!(
            build_component_fingerprints(&input),
            expected_components,
            "component fingerprints disagreed for case {id:?}",
        );
    }
}

/// The two reversed-order cases must hash alike, which is the whole point of
/// the canonical projection. Asserted here rather than left implicit in the
/// fixture, so a future regeneration cannot quietly bless a divergence.
#[test]
fn member_and_key_order_do_not_change_the_hash() {
    let vectors = vectors();
    let by_id = |wanted: &str| -> Value {
        vectors["fingerprints"]
            .as_array()
            .expect("fingerprint vectors missing")
            .iter()
            .find(|case| case["id"].as_str() == Some(wanted))
            .unwrap_or_else(|| panic!("fixture case {wanted:?} is missing"))
            .clone()
    };

    for (a, b) in [
        (
            "pset-member-order-is-irrelevant",
            "pset-member-order-reversed",
        ),
        (
            "object-valued-property-key-order-irrelevant",
            "object-valued-property-key-order-reversed",
        ),
    ] {
        let left = build_data_fingerprint(&parse_input(&by_id(a)["input"]));
        let right = build_data_fingerprint(&parse_input(&by_id(b)["input"]));
        assert_eq!(left, right, "{a} and {b} should hash alike");
    }
}

/// Absent, empty, and all-blank material lists are one case to the hash.
#[test]
fn empty_materials_hash_like_absent_materials() {
    let vectors = vectors();
    let find = |wanted: &str| -> String {
        let case = vectors["fingerprints"]
            .as_array()
            .expect("fingerprint vectors missing")
            .iter()
            .find(|case| case["id"].as_str() == Some(wanted))
            .unwrap_or_else(|| panic!("fixture case {wanted:?} is missing"));
        build_data_fingerprint(&parse_input(&case["input"]))
    };
    assert_eq!(find("minimal"), find("materials-empty-equals-absent"));
}
