// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! JSON.stringify(value, null, 2) formatting, with sidecars' trailing newline.
use crate::js_json::{JsonValue, stringify};

pub(crate) fn serialize(value: &JsonValue) -> String {
    let mut out = String::new();
    write(value, 0, &mut out);
    out.push('\n');
    out
}
fn indent(depth: usize, out: &mut String) { for _ in 0..depth { out.push_str("  "); } }
fn write(value: &JsonValue, depth: usize, out: &mut String) {
    match value {
        JsonValue::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                indent(depth + 1, out);
                write(item, depth + 1, out);
                out.push_str(if i + 1 == items.len() { "\n" } else { ",\n" });
            }
            indent(depth, out); out.push(']');
        }
        JsonValue::Object(entries) if !entries.is_empty() => {
            out.push_str("{\n");
            for (i, (key, value)) in entries.iter().enumerate() {
                indent(depth + 1, out);
                out.push_str(&stringify(&JsonValue::String(key.clone())));
                out.push_str(": ");
                write(value, depth + 1, out);
                out.push_str(if i + 1 == entries.len() { "\n" } else { ",\n" });
            }
            indent(depth, out); out.push('}');
        }
        _ => out.push_str(&stringify(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_8042_pretty_bytes_match_javascript_sidecar_format() {
        let value = JsonValue::Object(vec![
            ("format".into(), JsonValue::String("ifc-lite/lineage".into())),
            ("entries".into(), JsonValue::Array(vec![])),
            ("numbers".into(), JsonValue::Array(vec![JsonValue::Number(1e21),JsonValue::Number(-0.0),JsonValue::Number(f64::INFINITY)])),
        ]);
        assert_eq!(serialize(&value), "{\n  \"format\": \"ifc-lite/lineage\",\n  \"entries\": [],\n  \"numbers\": [\n    1e+21,\n    0,\n    null\n  ]\n}\n");
    }
}
