// SPDX-License-Identifier: MPL-2.0
//! The JavaScript values the TypeScript exporter computes with, and the two
//! conversions whose exact bytes reach the file.
//!
//! The parity target is the TypeScript `StepExporter`, which reads a record
//! through `EntityExtractor.extractEntity` and prints numbers with
//! `Number.prototype.toString`. Both have edges a Rust-native reading would
//! not share: the extractor returns an entity reference as a bare NUMBER
//! (indistinguishable from `5`), an enumeration token and a decoded string
//! literal as the same kind of STRING, and a typed value as a two-element
//! array. [`JsVal`] keeps exactly those distinctions and no others, so a port
//! that branches on them branches the same way.

use serde_json::Value;

/// A value as `EntityExtractor` produces it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum JsVal {
    Null,
    Num(f64),
    Str(String),
    Arr(Vec<JsVal>),
}

impl JsVal {
    pub(crate) fn as_num(&self) -> Option<f64> {
        match self {
            JsVal::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            JsVal::Str(s) => Some(s),
            _ => None,
        }
    }

    pub(crate) fn as_arr(&self) -> Option<&[JsVal]> {
        match self {
            JsVal::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// `String(v)` for the values the ports stringify.
    pub(crate) fn js_string(&self) -> String {
        match self {
            JsVal::Null => "null".to_string(),
            JsVal::Num(n) => js_number_to_string(*n),
            JsVal::Str(s) => s.clone(),
            JsVal::Arr(items) => items
                .iter()
                .map(|v| match v {
                    JsVal::Null => String::new(),
                    other => other.js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}

/// `Number.prototype.toString()` (ECMA-262 Number::toString, radix 10).
///
/// Rust's `{:e}` yields the same shortest round-trip digit string ECMAScript
/// specifies; only the layout rules differ, and those are applied here.
pub(crate) fn js_number_to_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if v < 0.0 {
        return format!("-{}", js_number_to_string(-v));
    }
    let sci = format!("{v:e}");
    let (mantissa, exp) = sci.split_once('e').expect("{:e} always writes an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().expect("{:e} exponent is an integer");
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        let mut s = digits;
        s.extend(std::iter::repeat_n('0', (n - k) as usize));
        s
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let e = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign}{e}")
        } else {
            format!("{}.{}e{sign}{e}", &digits[..1], &digits[1..])
        }
    }
}

/// `formatStepReal` (`@ifc-lite/data`): `toString`, then the mantissa gets a
/// decimal point and the exponent an uppercase `E`.
pub(crate) fn format_step_real(v: f64) -> String {
    let s = js_number_to_string(v);
    if let Some((mantissa, exp)) = s.split_once('e') {
        let mut mantissa = mantissa.to_string();
        if !mantissa.contains('.') {
            mantissa.push('.');
        }
        return format!("{mantissa}E{exp}");
    }
    if s.contains('.') {
        s
    } else {
        format!("{s}.")
    }
}

/// `toStepReal`: non-finite becomes `0.`.
pub(crate) fn to_step_real(v: f64) -> String {
    if v.is_finite() {
        format_step_real(v)
    } else {
        "0.".to_string()
    }
}

/// A JSON number, or the `{ "__nonFiniteNumber": … }` marker
/// `encodeNonFiniteNumbers` writes for NaN and the infinities.
pub(crate) fn json_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Object(map) => match map.get("__nonFiniteNumber").and_then(Value::as_str) {
            Some("NaN") => Some(f64::NAN),
            Some("Infinity") => Some(f64::INFINITY),
            Some("-Infinity") => Some(f64::NEG_INFINITY),
            _ => None,
        },
        _ => None,
    }
}

/// JavaScript `Number(v)` for the JSON shapes a mutation can carry.
pub(crate) fn js_to_number(v: &Value) -> f64 {
    if let Some(n) = json_number(v) {
        return n;
    }
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::String(s) => string_to_number(s),
        Value::Array(items) => match items.as_slice() {
            [] => 0.0,
            [one] => js_to_number(&Value::String(json_to_js_string(one))),
            _ => f64::NAN,
        },
        _ => f64::NAN,
    }
}

/// `Number(string)`: whitespace-trimmed decimal, `Infinity`, or hex/octal/
/// binary prefixes; anything else is NaN. The empty string is 0.
fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !valid {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(v)` over a JSON value.
pub(crate) fn json_to_js_string(v: &Value) -> String {
    if let Some(n) = json_number(v) {
        return js_number_to_string(n);
    }
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|i| if i.is_null() { String::new() } else { json_to_js_string(i) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
        Value::Number(_) => unreachable!("json_number handles numbers"),
    }
}

#[cfg(test)]
#[path = "jsval_tests.rs"]
mod tests;
