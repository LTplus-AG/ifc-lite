// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Private lossless document wire: little-endian tokens plus UTF-16 dictionary.
use ifc_lite_diff::{DocumentValue as Value, JsString};
use std::collections::{HashMap, hash_map::Entry};

pub(crate) fn encode(value: &Value) -> Vec<u8> {
    let mut writer = Writer { body: Vec::new(), strings: Vec::new(), ids: HashMap::new() };
    writer.value(value);
    finish(writer)
}

fn finish(writer: Writer<'_>) -> Vec<u8> {
    let capacity = writer.strings.iter().fold(4usize.saturating_add(writer.body.len()),
        |size, text| size.saturating_add(4).saturating_add(text.units().len().saturating_mul(2)));
    let mut result = Vec::with_capacity(capacity);
    result.extend_from_slice(&(writer.strings.len() as u32).to_le_bytes());
    for string in writer.strings {
        result.extend_from_slice(&(string.units().len() as u32).to_le_bytes());
        for unit in string.units() { result.extend_from_slice(&unit.to_le_bytes()); }
    }
    result.extend(writer.body);
    result
}
/// Stream the high-cardinality entry records without intermediate documents.
/// Tag 7 is private to the packed facade; the raw host DTO remains unchanged.
pub(crate) fn encode_result(diff: &ifc_lite_diff::engine::ModelDiff<'_, usize>) -> Vec<u8> {
    let metadata = ifc_lite_diff::transport_result::result_metadata(diff);
    let Value::Object(fields) = &metadata else { unreachable!("result envelope") };
    let mut writer = Writer { body: Vec::with_capacity(diff.core.entries.len() * 24), strings: Vec::new(), ids: HashMap::new() };
    writer.body.push(6);
    writer.word(fields.len() as u32);
    for (key, value) in fields {
        writer.string(key);
        if key == &JsString::from("entries") {
            writer.body.push(5);
            writer.word(diff.core.entries.len() as u32);
            for entry in &diff.core.entries { writer.entry(entry); }
        } else { writer.value(value); }
    }
    finish(writer)
}

struct Writer<'a> { body: Vec<u8>, strings: Vec<&'a JsString>, ids: HashMap<&'a JsString, u32> }
impl<'a> Writer<'a> {
    fn word(&mut self, value: u32) { self.body.extend_from_slice(&value.to_le_bytes()); }
    fn string(&mut self, value: &'a JsString) {
        let id = match self.ids.entry(value) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => {
                let id = self.strings.len() as u32;
                self.strings.push(value); entry.insert(id); id
            },
        };
        self.word(id);
    }
    fn entry(&mut self, entry: &'a ifc_lite_diff::model::DiffEntry<'_, usize>) {
        use ifc_lite_diff::model::{DiffState, DiffChangeKind};
        // The key pass keeps the base key for aliases and the head key only
        // for additions. Qualify this invariant in debug/test builds (#8042).
        debug_assert_eq!(entry.key, entry.base.or(entry.head).expect("entry row").key);
        self.body.push(7);
        self.body.push(match entry.state { DiffState::Added => 0, DiffState::Modified => 1,
            DiffState::Deleted => 2, DiffState::Unchanged => 3 });
        // Preserve the core's change-kind order rather than relying on a mask.
        self.body.push(entry.change_kinds.len() as u8);
        for kind in &entry.change_kinds { self.body.push(match kind {
            DiffChangeKind::Data => 0, DiffChangeKind::Geometry => 1, DiffChangeKind::Container => 2,
        }); }
        self.word(entry.base.map_or(u32::MAX, |e| e.reference as u32));
        self.word(entry.head.map_or(u32::MAX, |e| e.reference as u32));
        self.word(entry.changed_components.as_ref().map_or(u32::MAX, |keys| keys.len() as u32));
        if let Some(keys) = &entry.changed_components { for key in keys { self.string(key); } }
    }
    fn value(&mut self, value: &'a Value) {
        match value {
            Value::Null => self.body.push(0),
            Value::Bool(b) => self.body.push(if *b { 2 } else { 1 }),
            Value::Number(n) => { self.body.push(3); self.body.extend_from_slice(&n.to_le_bytes()); },
            Value::String(s) => { self.body.push(4); self.string(s); },
            Value::Array(a) => {
                self.body.push(5); self.word(a.len() as u32);
                for value in a { self.value(value); }
            },
            Value::Object(o) => {
                self.body.push(6); self.word(o.len() as u32);
                for (key, value) in o { self.string(key); self.value(value); }
            },
        }
    }
}
pub(crate) fn decode(bytes: &[u8]) -> Result<Value, String> {
    let mut reader = Reader { bytes, position: 0, strings: Vec::new() };
    let count = reader.word()?;
    for _ in 0..count {
        let length = reader.word()? as usize;
        let units = reader.take(length.checked_mul(2).ok_or("string length overflow")?)?
            .chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        reader.strings.push(JsString::from_units(units));
    }
    let value = reader.value(0)?;
    if reader.position != bytes.len() { return Err("trailing binary data".into()); }
    Ok(value)
}
/// Decode a typed string-array input without a Value tree or serde traversal.
pub(crate) fn decode_strings(bytes: &[u8]) -> Result<Vec<JsString>, String> {
    let mut reader = Reader { bytes, position: 0, strings: Vec::new() };
    let dictionary_count = reader.word()?;
    for _ in 0..dictionary_count {
        let length = reader.word()? as usize;
        let units = reader.take(length.checked_mul(2).ok_or("string length overflow")?)?
            .chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        reader.strings.push(JsString::from_units(units));
    }
    if reader.take(1)? != [5] { return Err("expected string array".into()); }
    let count = reader.word()? as usize;
    if count > (bytes.len() - reader.position) / 5 { return Err("truncated string array".into()); }
    let mut strings = Vec::with_capacity(count);
    for _ in 0..count {
        if reader.take(1)? != [4] { return Err("expected string token".into()); }
        strings.push(reader.string()?);
    }
    if reader.position != bytes.len() { return Err("trailing binary data".into()); }
    Ok(strings)
}

struct Reader<'a> { bytes: &'a [u8], position: usize, strings: Vec<JsString> }
impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self.position.checked_add(count).ok_or("binary length overflow")?;
        let value = self.bytes.get(self.position..end).ok_or("truncated binary data")?;
        self.position = end; Ok(value)
    }
    fn word(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("four bytes")))
    }
    fn string(&mut self) -> Result<JsString, String> {
        let id = self.word()? as usize;
        self.strings.get(id).cloned().ok_or_else(|| "invalid string index".into())
    }
    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth >= 128 { return Err("binary nesting limit exceeded".into()); }
        Ok(match self.take(1)?[0] {
            0 => Value::Null, 1 => Value::Bool(false), 2 => Value::Bool(true),
            3 => Value::Number(f64::from_le_bytes(self.take(8)?.try_into().expect("eight bytes"))),
            4 => Value::String(self.string()?),
            5 => {
                let count = self.word()?;
                // Reserve small known containers once, without trusting an
                // unvalidated wire count to request an unbounded allocation.
                let mut values = Vec::with_capacity((count as usize).min(4096).min(self.bytes.len() - self.position));
                for _ in 0..count { values.push(self.value(depth + 1)?); }
                Value::Array(values)
            },
            6 => {
                let count = self.word()?;
                let mut values = Vec::with_capacity((count as usize).min(4096).min((self.bytes.len() - self.position) / 5));
                for _ in 0..count { values.push((self.string()?, self.value(depth + 1)?)); }
                Value::Object(values)
            },
            _ => return Err("invalid binary tag".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue8042_typed_dictionary_refuses_malformed_input() {
        let value = Value::Array(vec![Value::String(JsString::from_units(vec![0xd800])),
            Value::String("same".into()), Value::String("same".into())]);
        let bytes = encode(&value);
        let decoded = decode_strings(&bytes).unwrap();
        assert_eq!(Value::Array(decoded.into_iter().map(Value::String).collect()), value);
        for end in 0..bytes.len() { assert!(decode_strings(&bytes[..end]).is_err()); }
        assert!(decode_strings(&encode(&Value::Array(vec![Value::Null]))).is_err());
        assert!(decode_strings(&encode(&Value::Null)).is_err());
        let mut trailing = bytes; trailing.push(0);
        assert!(decode_strings(&trailing).is_err());
    }
    #[test]
    fn issue8042_lossless_binary_transport() {
        let value = Value::Object(vec![
            (JsString::from_units(vec![0xd800]), Value::String(JsString::from_units(vec![0xdc00]))),
            ("empty".into(), Value::Array(vec![])),
            ("infinity".into(), Value::Number(f64::INFINITY)),
            ("negativeZero".into(), Value::Number(-0.0)),
        ]);
        let bytes = encode(&value);
        assert_eq!(encode(&decode(&bytes).unwrap()), bytes);
        for end in 0..bytes.len() { assert!(decode(&bytes[..end]).is_err()); }
        assert!(decode(&[0, 0, 0, 0, 255]).is_err());
    }
}
