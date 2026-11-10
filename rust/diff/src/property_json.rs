// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Borrowed composite traversal: neither serialization nor intermediate cleanup
//! recurses through user-supplied property nesting (#9331).
use crate::input::PropertyValue;
use crate::js_json::{write_value, JsonValue};
use crate::JsString;

enum Frame<'a> {
    Value(&'a PropertyValue),
    Key(&'a JsString),
    Token(&'static str),
}

/// Sorted-key JSON with the existing scalar writer and no owned composite tree.
pub(crate) fn stringify_property_sorted(value: &PropertyValue) -> String {
    let mut out = String::new();
    let mut pending = vec![Frame::Value(value)];
    while let Some(frame) = pending.pop() {
        match frame {
            Frame::Token(token) => out.push_str(token),
            Frame::Key(key) => key.write_json(&mut out),
            Frame::Value(PropertyValue::Array(items)) => {
                out.push('[');
                pending.push(Frame::Token("]"));
                for (index, item) in items.iter().enumerate().rev() {
                    pending.push(Frame::Value(item));
                    if index > 0 { pending.push(Frame::Token(",")); }
                }
            }
            Frame::Value(PropertyValue::Object(entries)) => {
                out.push('{');
                pending.push(Frame::Token("}"));
                let mut ordered: Vec<_> = entries.iter().collect();
                ordered.sort_by(|a, b| a.0.cmp(&b.0));
                for (index, (key, item)) in ordered.into_iter().enumerate().rev() {
                    pending.push(Frame::Value(item));
                    pending.push(Frame::Token(":"));
                    pending.push(Frame::Key(key));
                    if index > 0 { pending.push(Frame::Token(",")); }
                }
            }
            Frame::Value(value) => {
                // These temporaries contain only a scalar/Arc string. Dropping
                // them cannot recurse, and scalar formatting stays single-home.
                let scalar = match value {
                    PropertyValue::Null => JsonValue::Null,
                    PropertyValue::Bool(flag) => JsonValue::Bool(*flag),
                    PropertyValue::Number(number) => JsonValue::Number(*number),
                    PropertyValue::String(text) => JsonValue::String(text.clone()),
                    _ => unreachable!("composites are traversal frames"),
                };
                write_value(&scalar, true, &mut out);
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "property_json_tests.rs"]
mod tests;
