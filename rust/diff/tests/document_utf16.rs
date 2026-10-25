// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{JsString, DocumentValue as Value,
    document_serde::{from_document, to_document},
    sidecar_document::{parse_ordered_json, serialize_sidecar}};
use std::collections::{HashMap, HashSet};
fn distinct() -> Vec<JsString> {
    vec![JsString::from_units(vec![0xd800]), JsString::from_units(vec![0xdc00]),
        "�".into(), "\\ud800".into(), "𐀀".into(), "\u{e000}".into()]
}
#[test]
fn issue_8042_string_order_hash_equality_case_and_typed_document_roundtrip() {
    let strings = distinct();
    assert_eq!(strings.iter().cloned().collect::<HashSet<_>>().len(), strings.len());
    let mut ordered = strings.clone(); ordered.sort();
    assert_eq!(ordered, vec![strings[3].clone(), strings[0].clone(), strings[4].clone(), strings[1].clone(), strings[5].clone(), strings[2].clone()]);
    let value = JsString::from_units(vec![0xfeff, 0x61, 0xd800, 0xdf, 0xdc00, 0x20]);
    assert_eq!(value.normalized_class().units(), &[0x41, 0xd800, 0x53, 0x53, 0xdc00]);
    let map: HashMap<JsString, Vec<JsString>> = strings.iter().cloned().map(|s| (s.clone(), vec![s])).collect();
    let doc = to_document(&map).unwrap();
    let decoded: HashMap<JsString, Vec<JsString>> = from_document(doc).unwrap();
    assert_eq!(map, decoded);
    assert!(from_document::<JsString>(Value::Array(vec![])).is_err());
    assert!(strings[0].as_str().is_none());
    assert_eq!(strings[4].as_str(), Some("𐀀"));
}
#[test]
fn issue_8042_document_string_marker_does_not_reinterpret_user_objects() {
    let object = parse_ordered_json(r#"{"ifc-lite::JsString":[55296],"\\ud800":"literal","\ud800":"lone"}"#).unwrap();
    assert_eq!(to_document(&object).unwrap(), object);
    assert!(serde_json::to_string(&distinct()[0]).is_err(), "scalar serde must never silently emit unit arrays");
    assert_eq!(serialize_sidecar(&to_document(&distinct()[0]).unwrap()), "\"\\ud800\"\n");
}

#[test]
fn issue_8042_default_string_has_the_same_identity_and_scalar_view_as_empty() {
    let default = JsString::default();
    let empty: JsString = "".into();
    assert_eq!(default, empty);
    assert_eq!(default.as_str(), Some(""));
    let set: HashSet<_> = [default, empty].into_iter().collect();
    assert_eq!(set.len(), 1);
}
