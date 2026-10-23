// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Local ordered JSON decoding, without changing serde_json's workspace features.
use std::fmt;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use crate::js_json::JsonValue;

impl<'de> Deserialize<'de> for JsonValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(OrderedVisitor)
    }
}
struct OrderedVisitor;
impl<'de> Visitor<'de> for OrderedVisitor {
    type Value = JsonValue;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("a JSON value") }
    fn visit_unit<E>(self) -> Result<JsonValue, E> { Ok(JsonValue::Null) }
    fn visit_bool<E>(self, value: bool) -> Result<JsonValue, E> { Ok(JsonValue::Bool(value)) }
    fn visit_i64<E>(self, value: i64) -> Result<JsonValue, E> { Ok(JsonValue::Number(value as f64)) }
    fn visit_u64<E>(self, value: u64) -> Result<JsonValue, E> { Ok(JsonValue::Number(value as f64)) }
    fn visit_f64<E>(self, value: f64) -> Result<JsonValue, E> { Ok(JsonValue::Number(value)) }
    fn visit_str<E>(self, value: &str) -> Result<JsonValue, E> { Ok(JsonValue::String(value.into())) }
    fn visit_string<E>(self, value: String) -> Result<JsonValue, E> { Ok(JsonValue::String(value)) }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JsonValue, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? { items.push(item); }
        Ok(JsonValue::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsonValue, A::Error> {
        let mut entries: Vec<(String, JsonValue)> = Vec::new();
        let mut positions = std::collections::HashMap::new();
        while let Some((key, value)) = map.next_entry::<String, JsonValue>()? {
            // JSON.parse keeps the first position and last value of duplicate keys.
            if let Some(&index) = positions.get(&key) {
                let entry: &mut (String, JsonValue) = &mut entries[index];
                entry.1 = value;
            } else {
                positions.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
        }
        // JS enumeration promotes canonical array indices; stable sort preserves
        // insertion order for every other field, including unknown extensions.
        entries.sort_by(|a, b| match (array_index(&a.0), array_index(&b.0)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        });
        Ok(JsonValue::Object(entries))
    }
}
fn array_index(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}
/// Parse wire JSON while retaining JavaScript property enumeration order.
pub fn parse_ordered_json(text: &str) -> Result<JsonValue, serde_json::Error> {
    serde_json::from_str(text)
}
