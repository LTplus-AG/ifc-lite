// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Invariants of the typed document bridge (#8042, review findings on #8104):
//! JS key order, the full serde enum contract and exact 64-bit integer bounds.
use ifc_lite_diff::{JsString, DocumentValue as Value,
    document_serde::{from_document, to_document},
    sidecar_document::{parse_ordered_json, serialize_sidecar}};
use serde::{Deserialize, Serialize, Serializer, de::DeserializeOwned};
use std::collections::BTreeMap;

fn parse(text: &str) -> Value { parse_ordered_json(text).unwrap() }
fn keys(value: &Value) -> Vec<JsString> {
    let Value::Object(entries) = value else { panic!("expected an object, got {value:?}") };
    entries.iter().map(|(key, _)| key.clone()).collect()
}
fn names(expected: &[&str]) -> Vec<JsString> { expected.iter().map(|&key| key.into()).collect() }

/// A map whose iteration order the test controls, unlike `BTreeMap`/`HashMap`.
struct Pairs<K>(Vec<(K, i32)>);
impl<K: Serialize> Serialize for Pairs<K> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(key, value)| (key, value)))
    }
}

#[test]
fn pr_8104_typed_maps_use_javascript_integer_index_key_order() {
    // The review's failing input: lexicographic "10" < "2", JS enumerates 2 first.
    let tree = BTreeMap::from([("10", 1), ("2", 2)]);
    let doc = to_document(&tree).unwrap();
    assert_eq!(keys(&doc), names(&["2", "10"]));
    assert_eq!(doc, parse(r#"{"10":1,"2":2}"#), "must equal the shared ordered_object result");
    assert_eq!(from_document::<BTreeMap<String, i32>>(doc).unwrap(),
        BTreeMap::from([("10".into(), 1), ("2".into(), 2)]));

    // Canonical index boundaries: u32::MAX - 1 is an index, u32::MAX and
    // non-canonical spellings are ordinary keys that keep insertion order.
    let source = [("b", 0), ("4294967295", 1), ("a", 2), ("4294967294", 3), ("01", 4),
        ("-1", 5), ("7", 6), ("0", 7), ("1e3", 8), ("2", 9), ("+3", 10), ("4294967296", 11)];
    let doc = to_document(Pairs(source.to_vec())).unwrap();
    assert_eq!(keys(&doc), names(&["0", "2", "7", "4294967294",
        "b", "4294967295", "a", "01", "-1", "1e3", "+3", "4294967296"]));
    let json = format!("{{{}}}", source.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect::<Vec<_>>().join(","));
    assert_eq!(doc, parse(&json));

    // A lone surrogate is never an index and must not disturb the others.
    let lone = JsString::from_units(vec![0xd800]);
    let doc = to_document(Pairs(vec![(lone.clone(), 1), ("3".into(), 2), ("z".into(), 3)])).unwrap();
    assert_eq!(keys(&doc), vec!["3".into(), lone.clone(), "z".into()]);
    assert_eq!(serialize_sidecar(&doc), "{\n  \"3\": 2,\n  \"\\ud800\": 1,\n  \"z\": 3\n}\n");
}

#[test]
fn pr_8104_struct_fields_follow_the_same_key_order() {
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Renamed { name: i32, #[serde(rename = "10")] ten: i32, #[serde(rename = "2")] two: i32 }
    let value = Renamed { name: 1, ten: 10, two: 2 };
    let doc = to_document(&value).unwrap();
    assert_eq!(keys(&doc), names(&["2", "10", "name"]));
    assert_eq!(from_document::<Renamed>(doc).unwrap(), value);
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
enum Shape {
    Unit,
    Newtype(i32),
    Text(JsString),
    Tuple(i32, String),
    Struct { id: u8, tag: Option<String> },
    Keyed { #[serde(rename = "10")] ten: u8, #[serde(rename = "2")] two: u8 },
    Nested(Box<Shape>),
}

#[test]
fn pr_8104_every_serde_enum_variant_round_trips_through_documents() {
    let lone = JsString::from_units(vec![0x61, 0xdc00]);
    let cases = vec![
        Shape::Unit,
        Shape::Newtype(-7),
        Shape::Text(lone),
        Shape::Tuple(3, "x".into()),
        Shape::Struct { id: 9, tag: Some("t".into()) },
        Shape::Struct { id: 0, tag: None },
        Shape::Keyed { ten: 10, two: 2 },
        Shape::Nested(Box::new(Shape::Nested(Box::new(Shape::Tuple(1, "deep".into()))))),
    ];
    for case in &cases {
        let doc = to_document(case).unwrap();
        assert_eq!(&from_document::<Shape>(doc).unwrap(), case, "{case:?}");
    }
    // Containers of enums, and enums nested in options.
    let map: BTreeMap<String, Shape> = cases.into_iter().enumerate().map(|(i, s)| (i.to_string(), s)).collect();
    assert_eq!(from_document::<BTreeMap<String, Shape>>(to_document(&map).unwrap()).unwrap(), map);
    let some = Some(Shape::Newtype(1));
    assert_eq!(from_document::<Option<Shape>>(to_document(&some).unwrap()).unwrap(), some);
    assert_eq!(from_document::<Option<Shape>>(Value::Null).unwrap(), None);
}

#[test]
fn pr_8104_enum_documents_use_the_externally_tagged_serde_json_shape() {
    for (case, json) in [
        (Shape::Unit, r#""Unit""#),
        (Shape::Newtype(1), r#"{"Newtype":1}"#),
        (Shape::Tuple(1, "x".into()), r#"{"Tuple":[1,"x"]}"#),
        (Shape::Struct { id: 2, tag: None }, r#"{"Struct":{"id":2,"tag":null}}"#),
        (Shape::Keyed { ten: 10, two: 2 }, r#"{"Keyed":{"2":2,"10":10}}"#),
        (Shape::Nested(Box::new(Shape::Newtype(1))), r#"{"Nested":{"Newtype":1}}"#),
    ] {
        assert_eq!(to_document(&case).unwrap(), parse(json), "{case:?}");
        assert_eq!(from_document::<Shape>(parse(json)).unwrap(), case, "{json}");
        if !matches!(case, Shape::Keyed { .. }) {
            // serde_json agrees, so documents and JSON transport stay interchangeable.
            assert_eq!(serde_json::to_string(&case).unwrap(), json);
        }
    }
}

#[test]
fn pr_8104_malformed_enum_documents_are_rejected() {
    let lone = JsString::from_units(vec![0xd800]);
    let rejected = [
        parse(r#"{"Unit":null,"Newtype":1}"#), // two variants
        parse("{}"),                           // no variant
        parse("1"), parse("null"), parse("true"), parse("[]"), // not an enum encoding
        parse(r#"{"Unit":1}"#),                // content on a unit variant
        parse(r#""Newtype""#), parse(r#""Tuple""#), parse(r#""Struct""#), // missing content
        parse(r#"{"Newtype":"x"}"#),           // wrong content type
        parse(r#"{"Tuple":{"a":1}}"#), parse(r#"{"Tuple":[1]}"#),
        parse(r#"{"Struct":[2,null]}"#), parse(r#"{"Struct":{"id":300,"tag":null}}"#),
        parse(r#"{"Missing":null}"#), parse(r#""Missing""#),
        Value::String(lone.clone()),           // non-scalar variant names never match
        Value::Object(vec![(lone, Value::Null)]),
    ];
    for doc in rejected {
        assert!(from_document::<Shape>(doc.clone()).is_err(), "{doc:?} must be rejected");
    }
    // serde_json also accepts a null payload for a unit variant.
    assert_eq!(from_document::<Shape>(parse(r#"{"Unit":null}"#)).unwrap(), Shape::Unit);
}

fn number<T: DeserializeOwned>(n: f64) -> Option<T> { from_document(Value::Number(n)).ok() }

#[test]
fn pr_8104_sixty_four_bit_integer_bounds_reject_instead_of_saturating() {
    // `i64::MAX as f64` and `u64::MAX as f64` round up to 2^63 and 2^64, which
    // are out of range and used to saturate silently.
    assert_eq!(number::<i64>(9223372036854775808.0), None);
    assert_eq!(number::<i64>(9223372036854774784.0), Some(9223372036854774784));
    assert_eq!(number::<i64>(-9223372036854775808.0), Some(i64::MIN));
    assert_eq!(number::<i64>(-9223372036854777856.0), None);
    assert_eq!(number::<u64>(18446744073709551616.0), None);
    assert_eq!(number::<u64>(18446744073709549568.0), Some(18446744073709549568));
    assert_eq!(number::<u64>(9223372036854775808.0), Some(1u64 << 63));
    assert_eq!(number::<u64>(0.0), Some(0));
    assert_eq!(number::<u64>(-0.0), Some(0));
    assert_eq!(number::<u64>(-1.0), None);
    // Serialization is lossy for i64::MAX (a JS number cannot hold it); the
    // bridge now reports that on the way back rather than returning MAX.
    assert_eq!(from_document::<i64>(to_document(i64::MAX).unwrap()).ok(), None);
    assert_eq!(from_document::<u64>(to_document(u64::MAX).unwrap()).ok(), None);
}

#[test]
fn pr_8104_narrower_integer_bounds_and_non_integers_keep_their_contract() {
    assert_eq!((number::<i8>(-128.0), number::<i8>(127.0)), (Some(i8::MIN), Some(i8::MAX)));
    assert_eq!((number::<i8>(-129.0), number::<i8>(128.0)), (None, None));
    assert_eq!((number::<u8>(0.0), number::<u8>(255.0)), (Some(0), Some(u8::MAX)));
    assert_eq!((number::<u8>(-1.0), number::<u8>(256.0)), (None, None));
    assert_eq!((number::<i16>(-32768.0), number::<i16>(32767.0)), (Some(i16::MIN), Some(i16::MAX)));
    assert_eq!((number::<i16>(-32769.0), number::<i16>(32768.0)), (None, None));
    assert_eq!((number::<u16>(65535.0), number::<u16>(65536.0)), (Some(u16::MAX), None));
    assert_eq!((number::<i32>(-2147483648.0), number::<i32>(2147483647.0)), (Some(i32::MIN), Some(i32::MAX)));
    assert_eq!((number::<i32>(-2147483649.0), number::<i32>(2147483648.0)), (None, None));
    assert_eq!((number::<u32>(4294967295.0), number::<u32>(4294967296.0)), (Some(u32::MAX), None));
    for bad in [1.5, -0.5, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(number::<i64>(bad), None, "{bad}");
        assert_eq!(number::<u64>(bad), None, "{bad}");
        assert_eq!(number::<i32>(bad), None, "{bad}");
    }
    // Exactly representable integers beyond 2^53 are still valid i64 values.
    assert_eq!(number::<i64>(9007199254740993.0), Some(9007199254740992));
}

#[test]
fn pr_8104_index_mut_inserts_new_keys_in_canonical_object_order() {
    let mut doc = parse(r#"{"name":"x","3":true}"#);
    assert_eq!(keys(&doc), names(&["3", "name"]));
    doc["0"] = Value::Number(0.0);
    doc["10"] = Value::Number(10.0);
    doc["2"] = Value::Number(2.0);
    doc["zeta"] = Value::Number(6.0);
    doc["4294967295"] = Value::Number(1.0); // not an index: appended
    doc["01"] = Value::Number(1.0);
    doc["4294967294"] = Value::Number(4.0); // largest index: after 10, before name
    doc["3"] = Value::Bool(false); // existing key: value replaced, position kept
    assert_eq!(keys(&doc), names(&["0", "2", "3", "10", "4294967294", "name", "zeta", "4294967295", "01"]));
    assert_eq!(doc["3"], false);
    let oracle = parse(r#"{"name":"x","zeta":6,"4294967295":1,"01":1,"4294967294":4,"10":10,"3":false,"2":2,"0":0}"#);
    assert_eq!(doc, oracle);
    assert_eq!(serialize_sidecar(&doc), serialize_sidecar(&oracle));
}
