// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! JavaScript's pretty JSON encoding for lossless sidecar documents.
use crate::sidecar_value::DocumentValue;

pub(crate) fn serialize(value: &DocumentValue) -> String {
    let mut out = String::new();
    write(value, 0, &mut out);
    out.push('\n');
    out
}
fn indent(depth: usize, out: &mut String) { for _ in 0..depth { out.push_str("  "); } }
fn write(value: &DocumentValue, depth: usize, out: &mut String) {
    match value {
        DocumentValue::Null => out.push_str("null"),
        DocumentValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        DocumentValue::Number(n) => out.push_str(&crate::js_json::stringify(&crate::js_json::JsonValue::Number(*n))),
        DocumentValue::String(s) => s.write_json(out),
        DocumentValue::Array(items) => {
            out.push('[');
            if !items.is_empty() {
                out.push('\n');
                for (i, item) in items.iter().enumerate() {
                    indent(depth + 1, out);
                    write(item, depth + 1, out);
                    out.push_str(if i + 1 == items.len() { "\n" } else { ",\n" });
                }
                indent(depth, out);
            }
            out.push(']');
        }
        DocumentValue::Object(entries) => {
            out.push('{');
            if !entries.is_empty() {
                out.push('\n');
                for (i, (key, value)) in entries.iter().enumerate() {
                    indent(depth + 1, out);
                    key.write_json(out);
                    out.push_str(": ");
                    write(value, depth + 1, out);
                    out.push_str(if i + 1 == entries.len() { "\n" } else { ",\n" });
                }
                indent(depth, out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_8042_pretty_bytes_match_javascript_sidecar_format() {
        let value = DocumentValue::Object(vec![
            ("format".into(), DocumentValue::String("ifc-lite/lineage".into())),
            ("entries".into(), DocumentValue::Array(vec![])),
            ("numbers".into(), DocumentValue::Array(vec![DocumentValue::Number(1e21),DocumentValue::Number(-0.0),DocumentValue::Number(f64::INFINITY)])),
        ]);
        assert_eq!(serialize(&value), "{\n  \"format\": \"ifc-lite/lineage\",\n  \"entries\": [],\n  \"numbers\": [\n    1e+21,\n    0,\n    null\n  ]\n}\n");
    }
}
