// SPDX-License-Identifier: MPL-2.0
//! `parsePropertyValue` (`property-value-parser.ts`): one property record read
//! as the `(PropertyValueType, value, dataType)` the extractor reports. A
//! regenerated set is written from these values, so their lossy edges (an
//! enumerated or list value joined into one string, a bounded value's display
//! text) are ported as they are.

use serde_json::{Number, Value};

use super::base::pvt;
use super::jsval::{js_number_to_string, JsVal};

fn num(v: f64) -> Value {
    Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

/// `String(v)` for a member of an enumerated or list value, `null` and
/// `undefined` dropped.
fn member_strings(items: &[JsVal]) -> Vec<String> {
    items
        .iter()
        .map(|v| match v.as_arr() {
            Some([_, inner]) => inner.js_string(),
            _ => v.js_string(),
        })
        .filter(|s| s != "null" && s != "undefined")
        .collect()
}

/// The shared member type of an enumerated or list value, if every member is
/// a typed value of the same type.
fn shared_member_type(items: &[JsVal]) -> Option<String> {
    let mut shared: Option<String> = None;
    for m in items {
        let [ty, _] = m.as_arr()? else { return None };
        let t = ty.js_string().to_ascii_uppercase();
        if shared.as_ref().is_some_and(|s| *s != t) {
            return None;
        }
        shared = Some(t);
    }
    shared
}

/// `parsePropertyValue`: `(PropertyValueType, value, dataType)`.
pub(crate) fn parse_property_value(ty: &str, attrs: &[JsVal]) -> (u8, Value, Option<String>) {
    let joined = |items: &[JsVal]| {
        let values = member_strings(items);
        let text = values.join(", ");
        if text.is_empty() { Value::Null } else { Value::String(text) }
    };
    match ty {
        "IFCPROPERTYENUMERATEDVALUE" | "IFCPROPERTYLISTVALUE" => match attrs.get(2) {
            Some(JsVal::Arr(items)) => (pvt::STRING, joined(items), shared_member_type(items)),
            _ => (pvt::STRING, Value::Null, None),
        },
        "IFCPROPERTYBOUNDEDVALUE" => {
            let upper = extract_numeric(attrs.get(2));
            let lower = extract_numeric(attrs.get(3));
            let set_point = extract_numeric(attrs.get(5));
            let display_value = set_point.or(upper).or(lower);
            let mut display = display_value.map(js_number_to_string).unwrap_or_default();
            if let (Some(l), Some(u)) = (lower, upper) {
                display.push_str(&format!(
                    " [{} \u{2013} {}]",
                    js_number_to_string(l),
                    js_number_to_string(u)
                ));
            }
            let infer = |a: Option<&JsVal>| match a.and_then(JsVal::as_arr) {
                Some([t, _]) => Some(t.js_string().to_ascii_uppercase()),
                _ => None,
            };
            let data_type = infer(attrs.get(5)).or_else(|| infer(attrs.get(2))).or_else(|| infer(attrs.get(3)));
            let ty = if display_value.is_some() { pvt::REAL } else { pvt::STRING };
            let value = if display.is_empty() { Value::Null } else { Value::String(display) };
            (ty, value, data_type)
        }
        "IFCPROPERTYTABLEVALUE" => {
            let rows = attrs.get(2).and_then(JsVal::as_arr).map_or(0, <[JsVal]>::len);
            let ok = rows > 0 && attrs.get(3).and_then(JsVal::as_arr).is_some();
            if ok {
                (pvt::STRING, Value::String(format!("Table ({rows} rows)")), None)
            } else {
                (pvt::STRING, Value::Null, None)
            }
        }
        "IFCPROPERTYREFERENCEVALUE" => match attrs.get(2) {
            Some(JsVal::Num(n)) => (pvt::STRING, Value::String(format!("#{}", js_number_to_string(*n))), None),
            _ => (pvt::STRING, Value::Null, None),
        },
        _ => single_value(attrs.get(2)),
    }
}

/// The default branch of `parsePropertyValue` (`IfcPropertySingleValue` and
/// anything else carrying a `NominalValue` in slot 2).
fn single_value(nominal: Option<&JsVal>) -> (u8, Value, Option<String>) {
    match nominal {
        Some(JsVal::Arr(pair)) if pair.len() == 2 => {
            let type_name = pair[0].js_string().to_ascii_uppercase();
            let inner = &pair[1];
            let data_type = Some(type_name.clone());
            if type_name.contains("BOOLEAN") {
                return (pvt::BOOLEAN, Value::Bool(inner.as_str() == Some(".T.")), data_type);
            }
            if type_name.contains("LOGICAL") {
                let v = match inner.as_str() {
                    Some(".U.") | Some(".X.") => Value::Null,
                    other => Value::Bool(other == Some(".T.")),
                };
                return (pvt::LOGICAL, v, data_type);
            }
            if let JsVal::Num(n) = inner {
                let ty = if type_name == "IFCINTEGER" || type_name == "IFCCOUNTMEASURE" {
                    pvt::INTEGER
                } else if type_name == "IFCREAL" || type_name.ends_with("MEASURE") || type_name.ends_with("RATIO") {
                    pvt::REAL
                } else if n.fract() == 0.0 {
                    pvt::INTEGER
                } else {
                    pvt::REAL
                };
                return (ty, num(*n), data_type);
            }
            (pvt::STRING, Value::String(inner.js_string()), data_type)
        }
        Some(JsVal::Num(n)) => {
            let ty = if n.fract() == 0.0 { pvt::INTEGER } else { pvt::REAL };
            (ty, num(*n), None)
        }
        Some(JsVal::Str(s)) => match s.as_str() {
            ".T." => (pvt::BOOLEAN, Value::Bool(true), None),
            ".F." => (pvt::BOOLEAN, Value::Bool(false), None),
            ".U." | ".X." => (pvt::LOGICAL, Value::Null, None),
            _ => (pvt::STRING, Value::String(s.clone()), None),
        },
        Some(JsVal::Arr(items)) => (pvt::STRING, Value::Array(items.iter().map(to_json).collect()), None),
        Some(JsVal::Null) | None => (pvt::STRING, Value::Null, None),
    }
}

fn to_json(v: &JsVal) -> Value {
    match v {
        JsVal::Null => Value::Null,
        JsVal::Num(n) => num(*n),
        JsVal::Str(s) => Value::String(s.clone()),
        JsVal::Arr(items) => Value::Array(items.iter().map(to_json).collect()),
    }
}

/// `extractNumericValue`: a number, or the number inside a typed value.
fn extract_numeric(v: Option<&JsVal>) -> Option<f64> {
    match v? {
        JsVal::Num(n) => Some(*n),
        JsVal::Arr(pair) if pair.len() == 2 => pair[1].as_num(),
        _ => None,
    }
}
