// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! PR #8104: differential scalar key coercion against pinned serde_json.
use ifc_lite_diff::{
    document_serde::{from_document, to_document},
    sidecar_document::parse_ordered_json,
    DocumentValue, JsString,
};
use serde::{
    de::{self, DeserializeOwned, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize, Serializer,
};
use std::{collections::BTreeMap, fmt, marker::PhantomData};

// Also exercises keys like floats that cannot be stored in a BTreeMap.
#[derive(Debug, PartialEq)]
struct One<K>(K);
impl<K: Serialize> Serialize for One<K> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map([(&self.0, 1i32)])
    }
}
impl<'de, K: Deserialize<'de>> Deserialize<'de> for One<K> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct KeyVisitor<K>(PhantomData<K>);
        impl<'de, K: Deserialize<'de>> Visitor<'de> for KeyVisitor<K> {
            type Value = One<K>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("one key mapped to 1")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                match map.next_entry::<K, i32>()? {
                    Some((key, 1)) => Ok(One(key)),
                    _ => Err(de::Error::custom("expected one key mapped to 1")),
                }
            }
        }
        d.deserialize_map(KeyVisitor(PhantomData))
    }
}
fn text_round_trip<K: Serialize + DeserializeOwned + PartialEq + fmt::Debug>(value: &One<K>) {
    let json = serde_json::to_string(value).unwrap();
    let doc = to_document(value).unwrap();
    assert_eq!(doc, parse_ordered_json(&json).unwrap(), "{json}");
    assert_eq!(&from_document::<One<K>>(doc).unwrap(), value, "{json}");
    assert_eq!(
        &serde_json::from_str::<One<K>>(&json).unwrap(),
        value,
        "{json}"
    );
}
fn round_trip<K: Serialize + DeserializeOwned + PartialEq + fmt::Debug>(key: K) {
    let value = One(key);
    text_round_trip(&value);
    assert_eq!(
        serde_json::from_value::<One<K>>(serde_json::to_value(&value).unwrap()).unwrap(),
        value
    );
}
fn rejected<K: Serialize>(key: K) {
    let value = One(key);
    let ty = std::any::type_name::<K>();
    let text = serde_json::to_string(&value);
    assert!(text.is_err(), "to_string accepted key type {ty}: {text:?}");
    let json_value = serde_json::to_value(&value);
    assert!(
        json_value.is_err(),
        "to_value accepted key type {ty}: {json_value:?}"
    );
    let doc = to_document(&value);
    assert!(doc.is_err(), "to_document accepted key type {ty}: {doc:?}");
}
fn decode<K: DeserializeOwned + PartialEq + fmt::Debug>(key: &str, accepted: bool) {
    let json = format!("{{{}:1}}", serde_json::to_string(key).unwrap());
    let doc = from_document::<One<K>>(parse_ordered_json(&json).unwrap());
    let text = serde_json::from_str::<One<K>>(&json);
    let value = serde_json::from_value::<One<K>>(serde_json::from_str(&json).unwrap());
    assert_eq!(
        doc.is_ok(),
        accepted,
        "{} <- {json}: {doc:?}",
        std::any::type_name::<K>()
    );
    assert_eq!(text.is_ok(), accepted, "{json}: {text:?}");
    assert_eq!(value.is_ok(), accepted, "{json}: {value:?}");
    if accepted {
        assert_eq!(doc.as_ref().unwrap(), text.as_ref().unwrap(), "{json}");
        assert_eq!(doc.unwrap(), value.unwrap(), "{json}");
    }
}
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Newtype<T>(T);
#[derive(Debug, PartialEq, Serialize, Deserialize)]
enum Key {
    Unit,
    #[serde(rename = "renamed/λ")]
    Renamed,
    Newtype(i32),
    Tuple(i32, i32),
    Struct {
        n: i32,
    },
}
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Unit;
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Tuple(u8, u8);
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Struct {
    n: i32,
}

#[test]
fn pr_8104_primitive_newtype_and_unit_enum_keys_match_json() {
    macro_rules! integers {
        ($($ty:ty),*) => { $(round_trip(<$ty>::MIN); round_trip(<$ty>::MAX); round_trip(0 as $ty);)* };
    }
    integers!(i8, i16, i32, i64, i128, u8, u16, u32, u64, u128);
    round_trip(9007199254740993u64); // keys never round through JS numbers
    round_trip(false);
    round_trip(true);
    round_trip('λ');
    round_trip('𐀀');
    round_trip("a\"\\\nλ".to_owned());
    round_trip(String::new());
    round_trip(Key::Unit);
    round_trip(Key::Renamed);
    round_trip(Newtype(Newtype(-17i32)));
    round_trip(Newtype(Key::Renamed));
    for n in [
        -0.0,
        0.0,
        1.0,
        1.25,
        1e-30,
        1e30,
        f32::MIN,
        f32::MAX,
        f32::MIN_POSITIVE,
        f32::from_bits(1),
    ] {
        round_trip(n);
    }
    for n in [
        -0.0,
        0.0,
        1.0,
        1.25,
        1e-100,
        1e100,
        f64::MIN,
        f64::MAX,
        f64::MIN_POSITIVE,
        f64::from_bits(1),
    ] {
        round_trip(n);
    }
    round_trip(Newtype(-0.0f64));
    let negative_zero: One<f64> = from_document(to_document(One(-0.0f64)).unwrap()).unwrap();
    assert!(negative_zero.0.is_sign_negative());
}

#[test]
fn pr_8104_some_keys_follow_text_json_despite_to_value_rejection() {
    fn check<K: Serialize + DeserializeOwned + PartialEq + fmt::Debug>(key: K) {
        let value = One(key);
        text_round_trip(&value);
        // Pinned serde_json 1.0.154 deliberately has different key serializers:
        // ser.rs unwraps Some, while value/ser.rs rejects every Some key.
        assert!(
            serde_json::to_value(&value).is_err(),
            "to_value unexpectedly accepted {value:?}"
        );
    }
    check(Some(1i32));
    check(Some(u128::MAX));
    check(Some(true));
    check(Some('λ'));
    check(Some(-0.0f64));
    check(Some("text".to_owned()));
    check(Some(Key::Renamed));
    check(Some(Newtype(-17i32)));
    check(Newtype(Some(1i32)));
    check(Some(Some(Newtype(Some(42i32)))));
    check(Some(Newtype(JsString::from("scalar/λ"))));
}

#[test]
fn pr_8104_some_utf16_keys_preserve_the_lossless_marker_through_newtypes() {
    let lone = JsString::from_units(vec![0xd800]);
    let value = One(Some(Newtype(Some(lone.clone()))));
    let doc = to_document(&value).unwrap();
    assert_eq!(
        doc,
        DocumentValue::Object(vec![(lone, DocumentValue::Number(1.0))])
    );
    assert_eq!(
        from_document::<One<Option<Newtype<Option<JsString>>>>>(doc).unwrap(),
        value
    );
}

#[test]
fn pr_8104_collect_str_keys_use_the_same_scalar_text_as_json() {
    struct DisplayKey;
    impl fmt::Display for DisplayKey {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("display/λ")
        }
    }
    impl Serialize for DisplayKey {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            s.collect_str(self)
        }
    }
    let value = One(DisplayKey);
    let json = serde_json::to_string(&value).unwrap();
    let doc = to_document(&value).unwrap();
    assert_eq!(doc, parse_ordered_json(&json).unwrap());
    assert_eq!(
        from_document::<One<String>>(doc).unwrap(),
        One("display/λ".into())
    );
}

#[test]
fn pr_8104_integer_maps_keep_numeric_property_order_and_exact_key_text() {
    let map = BTreeMap::from([(-1i32, 3i32), (10, 1), (2, 2)]);
    let doc = to_document(&map).unwrap();
    assert_eq!(doc, parse_ordered_json(r#"{"2":2,"10":1,"-1":3}"#).unwrap());
    assert_eq!(from_document::<BTreeMap<i32, i32>>(doc).unwrap(), map);
    let map = BTreeMap::from([(i64::MIN, 0i32), (i64::MAX, 1), (9007199254740993, 2)]);
    assert_eq!(
        from_document::<BTreeMap<i64, i32>>(to_document(&map).unwrap()).unwrap(),
        map
    );
}

#[test]
fn pr_8104_compound_none_and_nonfinite_keys_are_rejected_like_json() {
    rejected(());
    rejected(Unit);
    rejected(None::<i32>);
    rejected(Some(None::<i32>));
    rejected(Newtype(None::<i32>));
    rejected(Some(vec![1i32]));
    rejected(Some(Newtype(Some((1i32,)))));
    rejected(Some(Struct { n: 1 }));
    rejected(Some(Key::Newtype(1)));
    rejected(Newtype(vec![1i32]));
    rejected(vec![1i32]);
    rejected([1i32]);
    rejected((1i32,));
    rejected(Tuple(1, 2));
    rejected(BTreeMap::from([("x", 1i32)]));
    rejected(Struct { n: 1 });
    rejected(Key::Newtype(1));
    rejected(Key::Tuple(1, 2));
    rejected(Key::Struct { n: 1 });
    for n in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        rejected(n);
    }
    for n in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        rejected(n);
    }
    struct Bytes;
    impl Serialize for Bytes {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            s.serialize_bytes(b"abc")
        }
    }
    rejected(Bytes);
    rejected(Some(Bytes));
}

#[test]
fn pr_8104_integer_key_grammar_and_bounds_match_json() {
    for key in [
        "", "+1", "01", "-01", "--1", "1.0", "1e0", "NaN", "Infinity", " 1", "1 ", "1\n", "1\t",
        "1\r", "1\u{b}", "1\0", "1x", "１", "-0",
    ] {
        decode::<i32>(key, false);
        decode::<u32>(key, false);
    }
    for key in ["0", "1", "2147483647"] {
        decode::<i32>(key, true);
    }
    for key in ["-1", "-2147483648"] {
        decode::<i32>(key, true);
        decode::<u32>(key, false);
    }
    decode::<i32>("2147483648", false);
    decode::<i32>("-2147483649", false);
    decode::<u32>("4294967295", true);
    decode::<u32>("4294967296", false);
    macro_rules! bounds {
        ($ty:ty, $below:expr, $above:expr) => {
            decode::<$ty>(&<$ty>::MIN.to_string(), true);
            decode::<$ty>(&<$ty>::MAX.to_string(), true);
            decode::<$ty>($below, false);
            decode::<$ty>($above, false);
        };
    }
    bounds!(i8, "-129", "128");
    bounds!(u8, "-1", "256");
    bounds!(i16, "-32769", "32768");
    bounds!(u16, "-1", "65536");
    bounds!(i64, "-9223372036854775809", "9223372036854775808");
    bounds!(u64, "-1", "18446744073709551616");
    bounds!(
        i128,
        "-170141183460469231731687303715884105729",
        "170141183460469231731687303715884105728"
    );
    bounds!(u128, "-1", "340282366920938463463374607431768211456");
    // The pinned i128/u128 parser has its own integer grammar; compare it too.
    for key in ["+1", "01", "1.0", "1e0", " 1", "1 "] {
        decode::<i128>(key, false);
        decode::<u128>(key, false);
    }
    decode::<i128>("-0", true);
    decode::<u128>("-0", false);
    decode::<Newtype<i32>>("12", true);
    decode::<Newtype<i32>>("12.0", false);
}

#[test]
fn pr_8104_other_scalar_key_decoding_and_rejections_match_json() {
    for key in ["true", "false"] {
        decode::<bool>(key, true);
    }
    for key in ["True", "0", "1", "null", " true", "false "] {
        decode::<bool>(key, false);
    }
    decode::<char>("𐀀", true);
    decode::<char>("", false);
    decode::<char>("ab", false);
    for key in ["Unit", "renamed/λ"] {
        decode::<Key>(key, true);
    }
    for key in ["Missing", "Newtype", "Tuple", "Struct"] {
        decode::<Key>(key, false);
    }
    for key in ["-0", "0", "1.25", "1e20", "-2E-3"] {
        decode::<f64>(key, true);
        decode::<f32>(key, true);
    }
    for key in ["+1", "01", "NaN", "inf", "1e999", "1 ", " 1", "1x"] {
        decode::<f64>(key, false);
    }
    // Text JSON accepts Some scalar keys on write and Option keys on read.
    decode::<Option<i32>>("1", true);
    decode::<Option<i32>>("null", false);
    decode::<Option<Newtype<bool>>>("true", true);
    decode::<()>("", false);
    decode::<Unit>("Unit", false);
    decode::<Vec<u8>>("abc", false);
    decode::<(u8,)>("1", false);
    decode::<Tuple>("12", false);
    decode::<Struct>("n", false);
    decode::<BTreeMap<String, i32>>("x", false);
}

#[test]
fn pr_8104_lossless_utf16_keys_remain_distinct_through_newtypes() {
    let keys = [
        JsString::from_units(vec![0xd800]),
        JsString::from_units(vec![0xdc00]),
        "�".into(),
        "\\ud800".into(),
        "𐀀".into(),
        "2".into(),
        "10".into(),
    ];
    let map: BTreeMap<JsString, i32> = keys
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, k)| (k, i as i32))
        .collect();
    let doc = to_document(&map).unwrap();
    let DocumentValue::Object(entries) = &doc else {
        panic!("expected object")
    };
    assert_eq!(entries[0].0, JsString::from("2"));
    assert_eq!(entries[1].0, JsString::from("10"));
    assert_eq!(from_document::<BTreeMap<JsString, i32>>(doc).unwrap(), map);
    for key in keys {
        let value = One(Newtype(Newtype(key)));
        assert_eq!(
            from_document::<One<Newtype<Newtype<JsString>>>>(to_document(&value).unwrap()).unwrap(),
            value
        );
    }
    let lone = JsString::from_units(vec![0xd800]);
    let doc = DocumentValue::Object(vec![(lone, DocumentValue::Number(1.0))]);
    assert!(from_document::<One<i32>>(doc.clone()).is_err());
    assert!(from_document::<One<bool>>(doc.clone()).is_err());
    assert!(from_document::<One<String>>(doc).is_err());
}
