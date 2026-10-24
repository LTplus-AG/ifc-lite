// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Invariants of the typed document bridge (#8042, review findings on #8104):
//! JS key order, the full serde enum contract and exact 64-bit integer bounds.
use ifc_lite_diff::{JsString, DocumentValue as Value,
    document_serde::{from_document, to_document},
    sidecar_document::{parse_ordered_json, serialize_sidecar}};
use serde::{Deserialize, Deserializer, Serialize, Serializer,
    de::{DeserializeOwned, IgnoredAny, MapAccess, SeqAccess, Visitor}};
use std::{collections::BTreeMap, fmt};

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
        parse(r#"{"Struct":{"id":300,"tag":null}}"#), parse(r#"{"Struct":null}"#),
        parse(r#"{"Struct":1}"#), parse(r#"{"Struct":"x"}"#),
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

/// Both transports must agree on `text`: the same verdict and, when it is
/// accepted, the same value. `serde_json` is the oracle for the serde contract.
fn accepts<T: DeserializeOwned + PartialEq + fmt::Debug>(text: &str) -> bool {
    let json = serde_json::from_str::<T>(text);
    let doc = from_document::<T>(parse(text));
    match (&json, &doc) {
        (Ok(a), Ok(b)) => assert_eq!(a, b, "{text}"),
        (Err(_), Err(_)) => {},
        _ => panic!("serde_json and the document bridge disagree on {text}: {json:?} vs {doc:?}"),
    }
    doc.is_ok()
}
fn check<T: DeserializeOwned + PartialEq + fmt::Debug>(cases: &[(&str, bool)]) {
    for &(text, expected) in cases {
        assert_eq!(accepts::<T>(text), expected, "{} <- {text}", std::any::type_name::<T>());
    }
}

#[derive(Debug, PartialEq, Deserialize)]
struct Pair(i32, i32);
#[derive(Debug, PartialEq, Deserialize)]
struct Point { x: i32, y: i32 }
#[derive(Debug, PartialEq, Deserialize)]
struct Holder { pair: (i32, i32) }

#[test]
fn pr_8104_plain_tuples_reject_short_and_long_sequences() {
    check::<(i32, String)>(&[
        ("[]", false), ("[1]", false),                         // too short
        (r#"[1,"x"]"#, true),                                  // exact
        (r#"[1,"x",2]"#, false), (r#"[1,"x",null]"#, false), (r#"[1,"x",[]]"#, false), // too long
        (r#"["x",1]"#, false), (r#"[1.5,"x"]"#, false),        // wrong element types
        ("null", false), ("1", false), ("true", false), (r#""ab""#, false), // not a sequence
        (r#"{"a":1}"#, false), (r#"[[1,"x"]]"#, false),
    ]);
    check::<(i32,)>(&[("[]", false), ("[1]", true), ("[1,2]", false), ("1", false)]);
    check::<[u8; 3]>(&[("[1,2]", false), ("[1,2,3]", true), ("[1,2,3,4]", false), ("[1,2,300]", false)]);
    check::<Pair>(&[("[1]", false), ("[1,2]", true), ("[1,2,3]", false), (r#"{"0":1,"1":2}"#, false)]);
    check::<Holder>(&[
        (r#"{"pair":[1,2]}"#, true), (r#"{"pair":[1]}"#, false), (r#"{"pair":[1,2,3]}"#, false),
    ]);
    check::<Vec<(i32, i32)>>(&[
        ("[]", true), ("[[1,2],[3,4]]", true), ("[[1,2,3]]", false), ("[[1]]", false), ("[[1,2],[3]]", false),
    ]);
    check::<Option<(i32, i32)>>(&[("null", true), ("[1,2]", true), ("[1,2,3]", false), ("[1]", false)]);
}

#[test]
fn pr_8104_structs_from_sequences_and_objects_follow_the_same_contract() {
    check::<Point>(&[
        ("[1,2]", true), ("[1]", false), ("[]", false), ("[1,2,3]", false),
        (r#"{"x":1,"y":2}"#, true), (r#"{"y":2,"x":1}"#, true), (r#"{"x":1}"#, false),
        (r#"{"x":1,"y":2,"z":{"deep":[1,2,3]}}"#, true), // unknown fields are ignored, not left unread
        (r#"{"x":1,"y":"2"}"#, false), ("null", false), ("1", false),
    ]);
}

#[test]
fn pr_8104_tuple_variants_reject_short_and_long_sequences() {
    check::<Shape>(&[
        (r#"{"Tuple":[1,"x"]}"#, true),
        (r#"{"Tuple":[]}"#, false), (r#"{"Tuple":[1]}"#, false),
        (r#"{"Tuple":[1,"x",2]}"#, false), (r#"{"Tuple":[1,"x",null]}"#, false), (r#"{"Tuple":[1,"x",[]]}"#, false),
        (r#"{"Tuple":["x",1]}"#, false),
        (r#"{"Tuple":null}"#, false), (r#"{"Tuple":1}"#, false), (r#"{"Tuple":true}"#, false),
        (r#"{"Tuple":"ab"}"#, false), (r#"{"Tuple":{"a":1}}"#, false), (r#"{"Tuple":{"0":1,"1":"x"}}"#, false),
        (r#""Tuple""#, false), (r#"{"Tuple":[1,"x"],"Unit":null}"#, false),
        (r#"{"Nested":{"Tuple":[1,"x"]}}"#, true), (r#"{"Nested":{"Tuple":[1,"x",2]}}"#, false),
    ]);
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    enum Arity { Zero(), Three(u8, u8, u8) }
    check::<Arity>(&[
        (r#"{"Zero":[]}"#, true), (r#"{"Zero":[1]}"#, false), (r#"{"Zero":null}"#, false), (r#""Zero""#, false),
        (r#"{"Three":[1,2,3]}"#, true), (r#"{"Three":[1,2]}"#, false), (r#"{"Three":[1,2,3,4]}"#, false),
        (r#"{"Three":[1,2,256]}"#, false),
    ]);
    for case in [Arity::Zero(), Arity::Three(1, 2, 3)] {
        let doc = to_document(&case).unwrap();
        assert_eq!(doc, parse(&serde_json::to_string(&case).unwrap()));
        assert_eq!(from_document::<Arity>(doc).unwrap(), case);
    }
}

#[test]
fn pr_8104_struct_variants_accept_objects_and_field_arrays_like_serde_json() {
    check::<Shape>(&[
        (r#"{"Struct":{"id":2,"tag":null}}"#, true), (r#"{"Struct":{"tag":"t","id":2}}"#, true),
        (r#"{"Struct":[2,null]}"#, true), (r#"{"Struct":[2,"t"]}"#, true),
        (r#"{"Struct":[2]}"#, false), (r#"{"Struct":[]}"#, false), (r#"{"Struct":[2,null,3]}"#, false),
        (r#"{"Struct":{"id":2}}"#, true), (r#"{"Struct":{"tag":null}}"#, false),
        (r#"{"Struct":{"id":2,"tag":null,"extra":[1,2,3]}}"#, true),
        (r#"{"Struct":null}"#, false), (r#"{"Struct":1}"#, false), (r#"{"Struct":"x"}"#, false),
        (r#"{"Struct":{"id":300,"tag":null}}"#, false), (r#""Struct""#, false),
    ]);
}

/// Reads at most one element/entry and leaves the rest of the container unread.
#[derive(Debug, PartialEq)]
struct First;
struct FirstVisitor;
impl<'de> Visitor<'de> for FirstVisitor {
    type Value = First;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("a sequence or map") }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<First, A::Error> { seq.next_element::<i32>()?; Ok(First) }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<First, A::Error> { map.next_entry::<String, i32>()?; Ok(First) }
}
impl<'de> Deserialize<'de> for First {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> { d.deserialize_any(FirstVisitor) }
}
/// Reads a map key and never its value.
#[derive(Debug, PartialEq)]
struct KeyOnly;
struct KeyOnlyVisitor;
impl<'de> Visitor<'de> for KeyOnlyVisitor {
    type Value = KeyOnly;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("a map") }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<KeyOnly, A::Error> { map.next_key::<String>()?; Ok(KeyOnly) }
}
impl<'de> Deserialize<'de> for KeyOnly {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> { d.deserialize_map(KeyOnlyVisitor) }
}

#[test]
fn pr_8104_visitors_that_leave_input_unread_are_rejected_and_complete_ones_are_not() {
    // Visitors that stop early fail on serde_json (`end_seq`/`end_map`) and here.
    check::<First>(&[
        ("[]", true), ("[1]", true), ("[1,2]", false), ("[1,2,3]", false),
        ("{}", true), (r#"{"a":1}"#, true), (r#"{"a":1,"b":2}"#, false),
    ]);
    // A key whose value was never consumed is also unread input.
    check::<KeyOnly>(&[("{}", true), (r#"{"a":1}"#, false), (r#"{"a":1,"b":2}"#, false)]);
    // Legitimate visitors that read everything are untouched, however deep.
    check::<Vec<i32>>(&[("[]", true), ("[1,2,3]", true), ("[1,2.5]", false)]);
    check::<BTreeMap<String, Vec<i32>>>(&[("{}", true), (r#"{"a":[1,2],"b":[]}"#, true), (r#"{"a":[1],"b":{}}"#, false)]);
    for text in ["null", "1", r#""s""#, "[]", "[1,[2,{\"a\":[3,{}]}],{}]", r#"{"a":{"b":[1,2,{"c":null}]},"d":[]}"#] {
        assert!(from_document::<IgnoredAny>(parse(text)).is_ok(), "{text}");
        assert!(serde_json::from_str::<IgnoredAny>(text).is_ok(), "{text}");
    }
}
