// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Same-named sets keep one component key each (#8136).
use super::*;
use crate::input::{PropertySetInput, QuantitySetInput};

fn pset(name: &str, value: &str) -> PropertySetInput {
    let entry = PropertyEntryInput { name: "P".into(), value: PropertyValue::String(value.into()) };
    PropertySetInput { name: name.into(), properties: vec![entry].into() }
}
fn keys(entries: &[(JsString, String)]) -> Vec<String> {
    entries.iter().map(|(key, _)| String::from_utf16(key.units()).unwrap()).collect()
}
fn wall(sets: Vec<PropertySetInput>) -> DataFingerprintInput {
    let quantity = PropertyEntryInput { name: "V".into(), value: PropertyValue::String("1".into()) };
    let qset = |value: &str| QuantitySetInput { name: "Q".into(), quantities: vec![PropertyEntryInput { value: PropertyValue::String(value.into()), ..quantity.clone() }].into() };
    DataFingerprintInput { ifc_type: "IfcWall".into(), property_sets: sets.into(), quantity_sets: vec![qset("2"), qset("1")].into(), ..Default::default() }
}

#[test]
fn issue_8136_same_named_sets_get_prefix_ordinals_in_content_order() {
    let input = wall(vec![pset("X#2", "a"), pset("X", "b"), pset("X", "a"), pset("X", "c")]);
    let solo = build_component_fingerprint_entries(&input);
    assert_eq!(keys(&solo), ["attr:core", "pset:X", "pset#2:X", "pset#3:X", "pset:X#2", "qset:Q", "qset#2:Q"]);
    let (_, pair) = build_fingerprint_pair_checked(&input, |_| Ok::<(), ()>(())).unwrap();
    assert_eq!(pair, solo);
    // Every set has its own hash: the content-ordered first `X` ("a") is not
    // overwritten by the last, and differs from the second.
    assert_ne!(solo[1].1, solo[2].1);
}

#[test]
fn issue_8136_editing_one_duplicate_changes_a_component_key() {
    let before = build_component_fingerprints(&wall(vec![pset("X", "a"), pset("X", "b")]));
    let after = build_component_fingerprints(&wall(vec![pset("X", "a"), pset("X", "z")]));
    let changed: Vec<_> = before.iter().filter(|(key, hash)| after.get(*key) != Some(*hash)).map(|(key, _)| String::from_utf16(key.units()).unwrap()).collect();
    assert_eq!(changed, ["pset#2:X"]);
}
