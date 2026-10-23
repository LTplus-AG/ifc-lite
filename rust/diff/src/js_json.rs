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

use crate::utf16::cmp_code_units;

/// A JSON value in the shape the fingerprint projections build.
///
/// `Object` is an ordered association list rather than a map: [`stringify`]
/// must preserve insertion order, which a `HashMap` cannot and a `BTreeMap`
/// would silently sort.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
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
                let mut order: Vec<&(String, JsonValue)> = entries.iter().collect();
                order.sort_by(|a, b| cmp_code_units(&a.0, &b.0));
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
    I: Iterator<Item = &'a (String, JsonValue)>,
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

/// Render a number the way `String(n)` does, for the non-finite tokens.
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

/// Escape and quote a string exactly as V8's `JSON.stringify` does.
///
/// Iterating `char`s rather than UTF-16 code units is safe *and* required
/// here. Safe, because every code unit an escape rule matches is below
/// `0x80`, so no escape can ever straddle a surrogate pair and a per-character
/// walk sees exactly the same triggers as a per-unit one. Required, because a
/// per-unit walk has to reassemble pairs to emit them, and getting that wrong
/// drops astral characters silently.
///
/// A Rust `&str` cannot hold a lone surrogate, so the well-formed-stringify
/// path (ES2019) that escapes one is unreachable here, and is deliberately
/// absent rather than written and untestable.
fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            // Every other C0 control. V8 spells these lowercase.
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            // Everything else passes through raw, `/`, `0x7f`, `U+2028` and
            // `U+2029` included. Several JSON writers escape those; V8 does
            // not, and this has to match V8.
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
#[path = "js_json_tests.rs"]
mod tests;
