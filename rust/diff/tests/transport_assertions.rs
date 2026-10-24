// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{columns::{decode_columns, FingerprintColumns, ABSENT_STRING},
    engine::diff_models, transport_options::options_from_json, transport_result::result_to_document};
use serde_json::{json, Value};

fn columns(rows: &[Value]) -> FingerprintColumns {
    let mut c = FingerprintColumns { component_offsets: vec![0], ..Default::default() };
    for row in rows {
        for key in ["key", "ifcType", "dataHash", "geometryHash", "container"] {
            c.fields.push(if let Some(s) = row[key].as_str() {
                c.strings.push(s.into()); (c.strings.len()-1) as u32
            } else { ABSENT_STRING });
        }
        c.flags.push(u8::from(row.get("aabb").is_some()) | (u8::from(row.get("volume").is_some()) << 1)
            | (u8::from(row.get("components").is_some()) << 2));
        for side in ["min", "max"] { for axis in 0..3 { c.boxes.push(row["aabb"][side][axis].as_f64().unwrap_or(0.0)); } }
        c.volumes.push(row["volume"].as_f64().unwrap_or(0.0));
        if let Some(components) = row["components"].as_object() {
            for (key, value) in components {
                c.component_pairs.push(c.strings.len() as u32); c.strings.push(key.as_str().into());
                c.component_pairs.push(c.strings.len() as u32); c.strings.push(value.as_str().unwrap().into());
            }
        }
        c.component_offsets.push((c.component_pairs.len()/2) as u32);
    }
    c
}
fn restore(row: &mut Value, key: &str, source: &[Value]) {
    if let Some(index) = row.get(key).and_then(Value::as_u64) { row[key] = source[index as usize].clone(); }
}
fn restore_many(row: &mut Value, key: &str, source: &[Value]) {
    if let Some(indices) = row.get_mut(key).and_then(Value::as_array_mut) {
        for index in indices { *index = source[index.as_u64().unwrap() as usize].clone(); }
    }
}
fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *value = json!(n.as_f64().unwrap()),
        Value::Array(a) => a.iter_mut().for_each(normalize_numbers),
        Value::Object(o) => o.values_mut().for_each(normalize_numbers),
        _ => (),
    }
}
/// #8042: exercise the production column decoder and transport against the
/// independent TS oracle, restoring row indices exactly as a JS facade must.
pub fn assert_transport(vector: &Value) {
    let base = vector["base"].as_array().unwrap();
    let head = vector["head"].as_array().unwrap();
    let b = decode_columns(columns(base)).unwrap();
    let h = decode_columns(columns(head)).unwrap();
    let options = options_from_json(&vector["options"]);
    let document = result_to_document(&diff_models(&b, &h, &options));
    // This committed corpus contains scalar strings; the UTF-16 corpus checks
    // lossless document results without projecting through serde_json::Value.
    let mut actual: Value = serde_json::from_str(&ifc_lite_diff::sidecar_document::serialize_sidecar(&document)).unwrap();
    for row in actual["entries"].as_array_mut().unwrap() {
        restore(row, "base", base); restore(row, "head", head);
    }
    actual["byKey"] = json!(actual["entries"].as_array().unwrap().iter().map(|r|json!([r["key"],r])).collect::<Vec<_>>());
    if let Some(matches) = actual.get_mut("contentMatches").and_then(Value::as_array_mut) {
        for row in matches { restore_many(row, "base", base); restore_many(row, "head", head); }
    }
    if let Some(claims) = actual.get_mut("splitMerges").and_then(Value::as_array_mut) {
        for row in claims {
            let (whole, pieces) = if row["kind"] == "split" { (base, head) } else { (head, base) };
            restore(row, "whole", whole); restore_many(row, "pieces", pieces); restore(row, "excluded", pieces);
        }
    }
    if let Some(claims) = actual.get_mut("successors").and_then(Value::as_array_mut) {
        for row in claims { restore(row, "base", base); restore(row, "head", head); }
    }
    let mut expected = vector["expected"].clone();
    normalize_numbers(&mut actual); normalize_numbers(&mut expected);
    assert_eq!(actual, expected, "columnar transport case {}", vector["name"]);
}
