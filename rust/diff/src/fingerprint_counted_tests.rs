// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Counted holes, hole runs and engine length checks (#8114): every streamed
//! form equals the per-hole materialized text, and huge counts stay O(1).
use super::*;
use crate::input::{PropertySetInput, QuantitySetInput};
use crate::js_json::{cmp_sorted, stable_hash_json, stringify, utf16_length};
use crate::utf16::{cmp_code_units, stable_hash};

fn holes<T>(count: usize) -> SparseCollection<T> {
    let mut collection = SparseCollection::default();
    collection.push_holes(count);
    collection
}
fn entry(name: &str, value: PropertyValue) -> PropertyEntryInput { PropertyEntryInput { name: name.into(), value } }
fn with<T>(present: Vec<T>, count: usize) -> SparseCollection<T> {
    let mut collection: SparseCollection<T> = present.into();
    collection.push_holes(count);
    collection
}
/// The pre-#8114 shape: one item per hole. JSON.stringify writes `null` for a
/// hole; stableSerialize's map/join writes nothing between separators.
fn expand(value: &JsonValue, hole: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => JsonValue::Array(items.iter().flat_map(|item| match item {
            JsonValue::Holes(count) => vec![hole.clone(); *count],
            other => vec![expand(other, hole)],
        }).collect()),
        JsonValue::Object(entries) => JsonValue::Object(entries.iter().map(|(key, item)| (key.clone(), expand(item, hole))).collect()),
        other => other.clone(),
    }
}
fn units(text: &str) -> u64 { text.encode_utf16().count() as u64 }
fn text(value: &str) -> JsonValue { JsonValue::String(value.into()) }

fn samples() -> Vec<JsonValue> {
    let lone = JsonValue::String(JsString::from_units(vec![0xd800, 0x41]));
    let prefixes = [vec![], vec![text("A")], vec![text("A"), lone], vec![text("\u{10000}")],
        vec![text("\u{E000}"), JsonValue::Number(1.5)], vec![text("A"), text("A")]];
    let mut values = Vec::new();
    for count in 0..=5 {
        for prefix in &prefixes {
            let mut items = prefix.clone();
            if count > 0 { items.push(JsonValue::Holes(count)); }
            let array = JsonValue::Array(items);
            values.push(JsonValue::Object(vec![("name".into(), text("D")), ("properties".into(), array.clone())]));
            values.push(array);
        }
    }
    values
}

#[test]
fn issue_8114_hole_runs_serialize_hash_measure_and_compare_like_materialized_holes() {
    let values = samples();
    for value in &values {
        let json = stringify(&expand(value, &JsonValue::Null));
        let stable = stringify_sorted(&expand(value, &JsonValue::Holes(1)));
        assert_eq!(stringify(value), json);
        assert_eq!(stringify_sorted(value), stable);
        assert_eq!((utf16_length(value, false), utf16_length(value, true)), (units(&json), units(&stable)));
        assert_eq!(stable_hash_json(value), stable_hash(&json));
    }
    for a in &values {
        for b in &values {
            let expected = cmp_code_units(&stringify_sorted(&expand(a, &JsonValue::Holes(1))),
                &stringify_sorted(&expand(b, &JsonValue::Holes(1))));
            assert_eq!(cmp_sorted(a, b), expected, "{} vs {}", stringify_sorted(a), stringify_sorted(b));
        }
    }
}

/// Five locations; `count` holes in one of them.
fn located(location: usize, count: usize) -> DataFingerprintInput {
    let mut input = DataFingerprintInput { ifc_type: "IfcWall".into(), name: Some(JsString::from_units(vec![0xdc00])), ..Default::default() };
    let present = || entry("\u{10000}", PropertyValue::String("\u{E000}".into()));
    match location {
        0 => input.property_sets = with(vec![PropertySetInput { name: "P".into(), properties: vec![present()].into() }], count),
        1 => input.quantity_sets = with(vec![QuantitySetInput { name: "Q".into(), quantities: vec![present()].into() }], count),
        2 => input.type_assignments = holes(count),
        3 => input.property_sets = vec![PropertySetInput { name: "P".into(), properties: with(vec![present()], count) }].into(),
        _ => input.quantity_sets = vec![QuantitySetInput { name: "Q".into(), quantities: with(vec![present()], count) }].into(),
    }
    input
}
/// The materialized fingerprint text the pre-#8114 builder hashed.
fn materialized(input: &DataFingerprintInput) -> String {
    let sets = |sorted: Vec<(JsString, JsonValue)>, count| JsonValue::Array(with_holes(sorted.into_iter().map(|(_, set)| set).collect(), count));
    let mut object = core_attributes(input);
    object.push(("TypeAssignments".into(), JsonValue::Array(sorted_type_assignments(&input.type_assignments))));
    object.push(("PropertySets".into(), sets(sorted_property_sets(input), input.property_sets.holes())));
    object.push(("QuantitySets".into(), sets(sorted_quantity_sets(input), input.quantity_sets.holes())));
    stringify(&expand(&JsonValue::Object(object), &JsonValue::Null))
}
fn lengths(input: &DataFingerprintInput, components: bool, reject: bool) -> (Vec<u64>, bool) {
    let mut seen = Vec::new();
    let record = |length| { seen.push(length); if reject { Err(length) } else { Ok(()) } };
    let rejected = if components {
        build_component_fingerprint_entries_checked(input, record).is_err()
    } else {
        build_data_fingerprint_checked(input, record).is_err()
    };
    (seen, rejected)
}

#[test]
fn issue_8114_small_sparse_fingerprints_equal_the_materialized_text_and_check_its_length() {
    for location in 0..5 {
        for count in 0..=5 {
            let input = located(location, count);
            let json = materialized(&input);
            assert_eq!(build_data_fingerprint(&input), stable_hash(&json), "{location}/{count}");
            // A dense input offers no length; a sparse one offers the exact text length.
            let expected = if count == 0 { vec![] } else { vec![units(&json)] };
            assert_eq!(lengths(&input, false, false), (expected, false), "{location}/{count}");
            if location >= 2 {
                let members = match location {
                    2 => JsonValue::Array(sorted_type_assignments(&input.type_assignments)),
                    3 => JsonValue::Array(sorted_entries(&input.property_sets.present().next().unwrap().properties)),
                    _ => JsonValue::Array(sorted_entries(&input.quantity_sets.present().next().unwrap().quantities)),
                };
                let member_json = stringify(&expand(&members, &JsonValue::Null));
                let component = build_component_fingerprint_entries(&input);
                let key = ["type-assignment", "pset:P", "qset:Q"][location - 2];
                if location > 2 || count > 0 {
                    assert!(component.contains(&(key.into(), stable_hash(&member_json))), "{location}/{count}");
                }
                let expected = if count == 0 { vec![] } else { vec![units(&member_json)] };
                assert_eq!(lengths(&input, true, false), (expected, false), "{location}/{count}");
            }
        }
    }
}

#[test]
fn issue_8114_counted_max_length_holes_are_measured_and_rejected_before_hashing() {
    // 2^32 - 1 holes cost O(1) memory. If any pass walked or hashed them, this
    // test would not finish: rejection must come from arithmetic alone.
    let huge = u32::MAX as usize;
    for location in 0..5 {
        let (small, _) = lengths(&located(location, 1), false, true);
        let (large, rejected) = lengths(&located(location, huge), false, true);
        assert!(rejected, "{location}: the rejection is returned");
        assert_eq!(large, vec![small[0] + 5 * (huge as u64 - 1)], "{location}: one `,null` per further hole");
        if location >= 2 {
            let (members, rejected) = lengths(&located(location, huge), true, true);
            assert!(rejected);
            // `[`, the present member's JSON (absent for type assignments), `,null`s, `]`.
            let (small, _) = lengths(&located(location, 1), true, true);
            assert_eq!(members, vec![small[0] + 5 * (huge as u64 - 1)], "{location}: component text");
        }
    }
}

#[test]
fn issue_8114_tiebreak_lengths_precede_member_and_final_lengths_in_oracle_order() {
    let sparse = |name: &str, count| PropertySetInput { name: name.into(), properties: with(vec![], count) };
    let mut input = DataFingerprintInput { ifc_type: "IfcWall".into(), ..Default::default() };
    // Two `D` sets tie on name, so the oracle's sort stableSerializes both.
    input.property_sets = vec![sparse("D", 2), sparse("U", 1), sparse("D", 3)].into();
    input.quantity_sets = vec![QuantitySetInput { name: "Q".into(), quantities: holes(1) }].into();
    input.type_assignments = holes(1);
    let tiebreak = units("{\"name\":\"D\",\"properties\":[,,]}");
    assert_eq!(lengths(&input, false, false), (vec![tiebreak, units(&materialized(&input))], false));
    assert_eq!(lengths(&input, true, false),
        (vec![tiebreak, units("[null,null,null]"), units("[null]"), units("[null]")], false));
    // The first rejection stops before later collections and before hashing.
    assert_eq!(lengths(&input, false, true), (vec![tiebreak], true));
    assert_eq!(lengths(&input, true, true), (vec![tiebreak], true));
    // Like the oracle, a set's length error precedes its outer-hole TypeError.
    let mut outer = input.clone();
    outer.property_sets.push_holes(1);
    assert_eq!(lengths(&outer, true, true), (vec![tiebreak], true));
    // Dense input is never offered to the check.
    let dense = DataFingerprintInput { property_sets: vec![sparse("D", 0), sparse("D", 0)].into(), ..Default::default() };
    assert_eq!(build_data_fingerprint_checked(&dense, |_| Err(())), Ok(build_data_fingerprint(&dense)));
    assert_eq!(build_component_fingerprint_entries_checked(&dense, |_| Err(())), Ok(build_component_fingerprint_entries(&dense)));
}

#[test]
fn issue_8114_same_name_sets_order_by_hole_count_members_and_utf16_like_materialized_text() {
    let set = |name: JsString, present: Vec<PropertyEntryInput>, count| PropertySetInput { name, properties: with(present, count) };
    let a = || entry("A", PropertyValue::Number(1.0));
    let b = || entry("\u{10000}", PropertyValue::Null);
    let c = || entry("\u{E000}", PropertyValue::Bool(true));
    let names = [JsString::from("D"), JsString::from("\u{10000}"), JsString::from("\u{E000}"), JsString::from_units(vec![0xd800])];
    let mut sets = Vec::new();
    for name in &names {
        for count in [0, 1, 2, 5] {
            for present in [vec![], vec![a()], vec![a(), a()], vec![b()], vec![c(), a()]] {
                sets.push(set(name.clone(), present, count));
            }
        }
    }
    // Exact duplicates tie completely: the stable sort keeps their input order.
    sets.extend(sets.clone());
    for reverse in [false, true] {
        let mut order = sets.clone();
        if reverse { order.reverse(); }
        let input = DataFingerprintInput { property_sets: order.into(), ..Default::default() };
        let sorted: Vec<String> = sorted_property_sets(&input).iter().map(|(_, set)| stringify(set)).collect();
        // The pre-#8114 reference: a stable sort on name, then materialized text.
        let mut expected: Vec<(JsString, JsonValue)> = input.property_sets.present()
            .map(|set| (set.name.clone(), set_to_json(&set.name, "properties", &sorted_entries(&set.properties)))).collect();
        expected.sort_by(|x, y| x.0.cmp(&y.0).then_with(|| cmp_code_units(
            &stringify_sorted(&expand(&x.1, &JsonValue::Holes(1))), &stringify_sorted(&expand(&y.1, &JsonValue::Holes(1))))));
        assert_eq!(sorted, expected.iter().map(|(_, set)| stringify(set)).collect::<Vec<_>>(), "reverse {reverse}");
    }
}
