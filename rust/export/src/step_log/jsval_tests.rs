// SPDX-License-Identifier: MPL-2.0
use super::*;

#[test]
fn number_to_string_follows_ecmascript_layout() {
    // Each right-hand side is what `String(x)` prints in V8.
    let cases: &[(f64, &str)] = &[
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (-1.5, "-1.5"),
        (0.1, "0.1"),
        (0.1 + 0.2, "0.30000000000000004"),
        (123456789.0, "123456789"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (1.5e-7, "1.5e-7"),
        (5e-8, "5e-8"),
        (0.000001, "0.000001"),
        (1e-7, "1e-7"),
        (2.5e25, "2.5e+25"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
    ];
    for (v, want) in cases {
        assert_eq!(js_number_to_string(*v), *want, "String({v:e})");
    }
}

#[test]
fn step_real_rewrites_mantissa_and_exponent() {
    assert_eq!(format_step_real(5.0), "5.");
    assert_eq!(format_step_real(0.25), "0.25");
    assert_eq!(format_step_real(5e-8), "5.E-8");
    assert_eq!(format_step_real(1.5e-7), "1.5E-7");
    assert_eq!(format_step_real(1e21), "1.E+21");
    assert_eq!(to_step_real(f64::NAN), "0.");
}

#[test]
fn extractor_shapes_match_entity_extractor() {
    let (id, ty, attrs) =
        super::super::extract::extract_entity("#25=IfcPropertySingleValue('Fire''s',$,IFCLABEL('2HR'),#7,.T.,(1.,2),1.E-05);")
            .expect("parses");
    assert_eq!((id, ty.as_str()), (25, "IFCPROPERTYSINGLEVALUE"));
    assert_eq!(attrs[0], JsVal::Str("Fire's".into()));
    assert_eq!(attrs[1], JsVal::Null);
    assert_eq!(attrs[2], JsVal::Arr(vec![JsVal::Str("IFCLABEL".into()), JsVal::Str("2HR".into())]));
    assert_eq!(attrs[3], JsVal::Num(7.0), "a reference is a bare number, as in JS");
    assert_eq!(attrs[4], JsVal::Str(".T.".into()));
    assert_eq!(attrs[5], JsVal::Arr(vec![JsVal::Num(1.0), JsVal::Num(2.0)]));
    assert_eq!(attrs[6], JsVal::Num(0.00001));
}

#[test]
fn js_number_coercion_matches_number() {
    use serde_json::json;
    assert_eq!(js_to_number(&json!("4.2")), 4.2);
    assert_eq!(js_to_number(&json!("")), 0.0);
    assert!(js_to_number(&json!("abc")).is_nan());
    assert_eq!(js_to_number(&json!(true)), 1.0);
    assert_eq!(js_to_number(&json!(null)), 0.0);
    assert!(js_to_number(&json!({"__nonFiniteNumber": "NaN"})).is_nan());
}
