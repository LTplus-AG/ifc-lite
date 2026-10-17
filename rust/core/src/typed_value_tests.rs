// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::parser::Token;

fn decode(token: &Token) -> AttributeValue {
    AttributeValue::from_token(token)
}

fn s(text: &str) -> AttributeValue {
    AttributeValue::String(text.to_owned())
}

#[test]
fn typed_value_is_not_a_two_item_string_list_7776() {
    // CORE-4: `IFCLABEL('Marie')` and the list `('IFCLABEL','Marie')` used
    // to decode to the same `List([String, String])`.
    let typed = decode(&Token::TypedValue(b"ifclabel", vec![Token::String(b"Marie")]));
    let list = decode(&Token::List(vec![Token::String(b"IFCLABEL"), Token::String(b"Marie")]));
    assert_eq!(typed.as_typed().map(|(n, v)| (n, v.as_string())), Some(("IFCLABEL", Some("Marie"))));
    assert!(list.as_typed().is_none());
    assert!(typed.as_list().is_none(), "a typed value is not a list");
    assert_eq!(list.as_list().map(<[_]>::len), Some(2));
    // MiddleNames ('Anne','Marie') is a list of two strings, not a typed 'Anne'.
    let names = AttributeValue::List(vec![s("Anne"), s("Marie")]);
    assert!(names.as_typed().is_none());
    assert_eq!(names.as_string(), None);
    assert_eq!(AttributeValue::List(vec![s("x"), AttributeValue::Float(1.5)]).as_float(), None);
}

#[test]
fn accessors_see_through_a_typed_wrapper_and_only_that_7776() {
    let int = decode(&Token::TypedValue(b"IFCINTEGER", vec![Token::Integer(5)]));
    assert_eq!(int.as_int(), Some(5));
    assert_eq!(int.as_float(), Some(5.0));
    let label = decode(&Token::TypedValue(b"IFCLABEL", vec![Token::String(b"x")]));
    assert_eq!(label.as_string(), Some("x"));
    let flag = decode(&Token::TypedValue(b"IFCBOOLEAN", vec![Token::Enum(b"T")]));
    assert_eq!(flag.as_enum(), Some("T"));
    assert_eq!(flag.unwrap_typed().as_enum(), Some("T"));
    assert_eq!(s("plain").unwrap_typed().as_string(), Some("plain"));
    let param = decode(&Token::TypedValue(b"ifcparametervalue", vec![Token::Float(0.5)]));
    assert_eq!(param.typed_value("IfcParameterValue").and_then(AttributeValue::as_float), Some(0.5));
    assert!(param.typed_value("IFCLABEL").is_none());
    assert!(AttributeValue::Float(0.5).typed_value("IFCPARAMETERVALUE").is_none());
}

#[test]
fn typed_value_argument_count_is_total_7776() {
    let none = decode(&Token::TypedValue(b"IFCLABEL", vec![]));
    assert!(matches!(none.as_typed(), Some(("IFCLABEL", AttributeValue::Null))));
    let many = decode(&Token::TypedValue(b"IFCX", vec![Token::Integer(1), Token::Integer(2)]));
    assert_eq!(many.as_typed().and_then(|(_, v)| v.as_list()).map(<[_]>::len), Some(2));
}

#[test]
fn as_int_refuses_what_it_used_to_truncate_7776() {
    assert_eq!(AttributeValue::Float(3.0).as_int(), Some(3));
    assert_eq!(AttributeValue::Float(-0.0).as_int(), Some(0));
    for bad in [3.7, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1e300, 9.3e18, -9.3e18] {
        assert_eq!(AttributeValue::Float(bad).as_int(), None, "{bad}");
    }
    assert_eq!(AttributeValue::Float(-9.223372036854775808e18).as_int(), Some(i64::MIN));
}

#[test]
fn logical_reads_unknown_for_u_and_x_7776() {
    let e = |t: &str| AttributeValue::Enum(t.to_owned());
    for (text, want) in [
        ("T", Some(Logical::True)),
        ("TRUE", Some(Logical::True)),
        ("F", Some(Logical::False)),
        ("FALSE", Some(Logical::False)),
        ("U", Some(Logical::Unknown)),
        ("X", Some(Logical::Unknown)),
        ("CARTESIAN", None),
        ("", None),
    ] {
        assert_eq!(e(text).as_logical(), want, "{text}");
    }
    assert_eq!(e("U").as_bool(), None);
    assert_eq!(e("T").as_bool(), Some(true));
    // Through a wrapper, and never from text or absence.
    let typed = decode(&Token::TypedValue(b"IFCLOGICAL", vec![Token::Enum(b"X")]));
    assert_eq!(typed.as_logical(), Some(Logical::Unknown));
    for other in [AttributeValue::Null, AttributeValue::Derived, s("T"), AttributeValue::Integer(1)] {
        assert_eq!(other.as_logical(), None);
    }
}

#[test]
fn entity_flag_readers_state_the_default_at_the_call_7776() {
    let entity = DecodedEntity::new(
        1,
        crate::generated::IfcType::IfcPolyline,
        vec![
            AttributeValue::Enum("T".into()),
            AttributeValue::Enum("F".into()),
            AttributeValue::Enum("U".into()),
            AttributeValue::Null,
        ],
    );
    assert_eq!(entity.get_bool(0), Some(true));
    assert_eq!(entity.get_bool(1), Some(false));
    assert_eq!(entity.get_bool(2), None);
    assert_eq!(entity.get_logical(2), Some(Logical::Unknown));
    assert!(entity.get_bool(3).unwrap_or(true));
    assert!(!entity.get_bool(9).unwrap_or(false));
}

#[test]
fn overflowing_real_stays_infinite_inside_a_typed_value_d19() {
    let token = Token::TypedValue(b"IFCREAL", vec![Token::UnrepresentableReal(b"-1.E400")]);
    assert_eq!(decode(&token).as_float(), Some(f64::NEG_INFINITY));
    let mut noted = false;
    let _ = AttributeValue::from_token_noting(&token, &mut noted);
    assert!(noted, "the decoder still learns of the overflow through a typed value");
}
