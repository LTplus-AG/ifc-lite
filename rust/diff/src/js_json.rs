// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `JSON.stringify`, byte-exact, plus the key-sorting variant the diff engine
//! calls `stableSerialize`.
//!
//! The data fingerprint is a hash over serialized JSON, so this module is not
//! "a JSON writer" — it is a reimplementation of one specific one. A general
//! JSON library is the wrong tool: `serde_json` escapes a different set of
//! characters than V8 and formats floats with Rust's rules, and either
//! difference silently moves every fingerprint.
//!
//! Two serializations, deliberately distinct, because the TypeScript module
//! uses both for different purposes and conflating them breaks the hash:
//!
//! - [`stringify`] is `JSON.stringify`: object keys come out in **insertion
//!   order**. `buildDataFingerprint` hashes an object literal whose key order
//!   is part of the format.
//! - [`stringify_sorted`] is `stableSerialize`: object keys are **sorted** by
//!   UTF-16 code unit. Used for object-valued properties inside
//!   `normalizeValue`, and as the content tiebreak when two records share a
//!   name.
//!
//! Escaping was read off V8 rather than from RFC 8259, because the two differ
//! in both directions. V8 emits `\b \t \n \f \r` as short escapes, any other
//! code unit below `0x20` as lowercase `\u00xx`, and **nothing else** — `/`,
//! `0x7f`, `U+2028` and `U+2029` all pass through raw, where several JSON
//! writers escape them.

use crate::JsString;

/// A JSON value in the shape the fingerprint projections build.
///
/// `Object` is an ordered association list rather than a map: [`stringify`]
/// must preserve insertion order, which a `HashMap` cannot and a `BTreeMap`
/// would silently sort.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    /// Sparse array slot: JSON null, but an empty stableSerialize map/join token.
    Hole,
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonValue>),
    Object(Vec<(JsString, JsonValue)>),
}

/// Serialize exactly as `JSON.stringify` does, preserving object key order.
pub fn stringify(value: &JsonValue) -> String {
    let mut out = String::new();
    write_value(value, false, &mut out);
    out
}

/// Serialize with object keys sorted by UTF-16 code unit — the diff engine's
/// `stableSerialize`.
///
/// Two semantically equal values whose keys were inserted in different orders
/// serialize identically here, which is what makes it usable as a content
/// tiebreak. Plain `JSON.stringify` preserves key order and would produce a
/// spurious difference.
pub fn stringify_sorted(value: &JsonValue) -> String {
    let mut out = String::new();
    write_value(value, true, &mut out);
    out
}

fn write_value(value: &JsonValue, sort_keys: bool, out: &mut String) {
    match value {
        JsonValue::Hole => { if !sort_keys { out.push_str("null"); } }
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(true) => out.push_str("true"),
        JsonValue::Bool(false) => out.push_str("false"),
        JsonValue::Number(n) => out.push_str(&number_to_json(*n)),
        JsonValue::String(s) => write_string(s, out),
        JsonValue::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, sort_keys, out);
            }
            out.push(']');
        }
        JsonValue::Object(entries) => {
            out.push('{');
            if sort_keys {
                let mut order: Vec<&(JsString, JsonValue)> = entries.iter().collect();
                order.sort_by(|a, b| a.0.cmp(&b.0));
                write_entries(order.into_iter(), sort_keys, out);
            } else {
                write_entries(entries.iter(), sort_keys, out);
            }
            out.push('}');
        }
    }
}

fn write_entries<'a, I>(entries: I, sort_keys: bool, out: &mut String)
where
    I: Iterator<Item = &'a (JsString, JsonValue)>,
{
    for (index, (key, item)) in entries.enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        write_value(item, sort_keys, out);
    }
}

/// `JSON.stringify` of a number.
///
/// Non-finite values become `null`, which is what `JSON.stringify` does
/// — RFC 8259 has no non-finite literal. That collision (an `Infinity`
/// property hashing like an absent one) is why the fingerprint layer converts
/// a non-finite number to a string token *before* it ever reaches here; see
/// `normalize_value`.
fn number_to_json(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(value).to_owned()
}

/// Render a number the way `JsString(n)` does, for the non-finite tokens.
///
/// ECMAScript `ToString` spells these `NaN`, `Infinity` and `-Infinity`;
/// Rust's `Display` spells them `NaN`, `inf` and `-inf`.
pub fn non_finite_token(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value.is_sign_positive() {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// Well-formed JSON.stringify escapes unpaired surrogate code units.
fn write_string(value: &JsString, out: &mut String) { value.write_json(out); }

#[cfg(test)]
#[path = "js_json_tests.rs"]
mod tests;
