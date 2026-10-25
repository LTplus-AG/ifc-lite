// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Lossless JavaScript strings and ordered JSON values for sidecar documents.
use std::{fmt, ops::Index};

/// JavaScript strings are UTF-16 sequences, including unpaired surrogates.
/// Keep a scalar view only when it exists; equality, hashing and ordering use
/// the original code units, never a replacement-character projection.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsString {
    units: Vec<u16>,
    scalar: Option<String>,
}
impl Default for JsString {
    fn default() -> Self { Self::from("") }
}
impl JsString {
    pub fn from_units(units: Vec<u16>) -> Self {
        let scalar = String::from_utf16(&units).ok();
        Self { units, scalar }
    }
    pub fn units(&self) -> &[u16] { &self.units }
    pub fn surround(prefix: &str, value: &Self, suffix: &str) -> Self {
        Self::from_units(prefix.encode_utf16().chain(value.units.iter().copied()).chain(suffix.encode_utf16()).collect())
    }
    pub fn as_str(&self) -> Option<&str> { self.scalar.as_deref() }
    pub fn is_empty(&self) -> bool { self.units.is_empty() }
    pub fn is_blank(&self) -> bool {
        self.units.iter().all(|&unit| char::from_u32(u32::from(unit))
            .is_some_and(crate::projections::is_ecmascript_whitespace))
    }
    /// Concatenate without projecting unpaired units into a scalar string.
    pub fn concat(parts: &[&Self], separator: &str) -> Self {
        let mut units = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 { units.extend(separator.encode_utf16()); }
            units.extend_from_slice(part.units());
        }
        Self::from_units(units)
    }
    pub fn starts_with(&self, prefix: &str) -> bool {
        self.units.iter().copied().take(prefix.encode_utf16().count()).eq(prefix.encode_utf16())
    }
    /// ECMAScript trim followed by Unicode default uppercase mapping. Surrogate
    /// code units remain unchanged and valid pairs are mapped as one scalar.
    /// Host comparisons may supply scoped mappings for their Unicode version.
    pub fn normalized_class(&self) -> Self {
        if let Some(normalized) = crate::class_normalization::lookup(self) { return normalized; }
        let whitespace = |unit: &u16| char::from_u32(u32::from(*unit))
            .is_some_and(crate::projections::is_ecmascript_whitespace);
        let start = self.units.iter().position(|u| !whitespace(u)).unwrap_or(self.units.len());
        let end = self.units.iter().rposition(|u| !whitespace(u)).map_or(start, |i| i + 1);
        let mut units = Vec::new();
        for ch in char::decode_utf16(self.units[start..end].iter().copied()) {
            match ch {
                Err(error) => units.push(error.unpaired_surrogate()),
                Ok(ch) => for upper in ch.to_uppercase() {
                    units.extend_from_slice(upper.encode_utf16(&mut [0; 2]));
                },
            }
        }
        Self::from_units(units)
    }
    pub fn write_json(&self, out: &mut String) {
        out.push('"');
        for ch in char::decode_utf16(self.units.iter().copied()) {
            match ch {
                Err(error) => out.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
                Ok('"') => out.push_str("\\\""),
                Ok('\\') => out.push_str("\\\\"),
                Ok('\u{08}') => out.push_str("\\b"),
                Ok('\u{09}') => out.push_str("\\t"),
                Ok('\u{0a}') => out.push_str("\\n"),
                Ok('\u{0c}') => out.push_str("\\f"),
                Ok('\u{0d}') => out.push_str("\\r"),
                Ok(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
                Ok(c) => out.push(c),
            }
        }
        out.push('"');
    }
}
impl From<&str> for JsString {
    fn from(value: &str) -> Self { Self { units: value.encode_utf16().collect(), scalar: Some(value.into()) } }
}
impl From<String> for JsString {
    fn from(value: String) -> Self { Self { units: value.encode_utf16().collect(), scalar: Some(value) } }
}
impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for ch in char::decode_utf16(self.units.iter().copied()) {
            match ch {
                Ok(c) => write!(f, "{c}")?,
                // Native error messages are scalar strings; make an invalid
                // code unit explicit rather than silently replacing it.
                Err(error) => write!(f, "\\u{:04x}", error.unpaired_surrogate())?,
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DocumentValue {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<DocumentValue>),
    Object(Vec<(JsString, DocumentValue)>),
}
impl DocumentValue {
    pub fn as_string(&self) -> Option<&JsString> { if let Self::String(s) = self { Some(s) } else { None } }
    pub fn as_str(&self) -> Option<&str> { self.as_string().and_then(JsString::as_str) }
    pub fn is_string(&self) -> bool { matches!(self, Self::String(_)) }
    pub fn is_object(&self) -> bool { matches!(self, Self::Object(_)) }
    pub fn as_f64(&self) -> Option<f64> { if let Self::Number(n) = self { Some(*n) } else { None } }
    pub fn as_array(&self) -> Option<&Vec<Self>> { if let Self::Array(a) = self { Some(a) } else { None } }
    pub fn get(&self, key: &str) -> Option<&Self> {
        if let Self::Object(entries) = self {
            entries.iter().find(|(name, _)| name.as_str() == Some(key)).map(|(_, value)| value)
        } else { None }
    }
}
impl Index<&str> for DocumentValue {
    type Output = Self;
    fn index(&self, key: &str) -> &Self { self.get(key).unwrap_or(&Self::Null) }
}
impl Index<usize> for DocumentValue {
    type Output = Self;
    fn index(&self, key: usize) -> &Self { self.as_array().and_then(|a| a.get(key)).unwrap_or(&Self::Null) }
}
impl From<&serde_json::Value> for DocumentValue {
    fn from(value: &serde_json::Value) -> Self {
        use serde_json::Value;
        match value {
            Value::Null => Self::Null,
            Value::Bool(b) => Self::Bool(*b),
            Value::Number(n) => Self::Number(n.as_f64().unwrap()),
            Value::String(s) => Self::String(s.as_str().into()),
            Value::Array(a) => Self::Array(a.iter().map(Self::from).collect()),
            Value::Object(o) => ordered_object(o.iter().map(|(k, v)| (k.as_str().into(), Self::from(v))).collect()),
        }
    }
}
pub fn ordered_object(mut entries: Vec<(JsString, DocumentValue)>) -> DocumentValue {
    sort_entries(&mut entries);
    DocumentValue::Object(entries)
}
/// Stable JavaScript own-key enumeration order: canonical array indices
/// ascending, then every other key in insertion order. Idempotent, so an
/// already ordered object is left untouched.
fn sort_entries(entries: &mut [(JsString, DocumentValue)]) {
    fn array_index(key: &JsString) -> Option<u32> {
        let text = key.as_str()?;
        let index = text.parse::<u32>().ok()?;
        (index != u32::MAX && index.to_string() == text).then_some(index)
    }
    entries.sort_by(|a, b| match (array_index(&a.0), array_index(&b.0)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
}

impl From<&JsString> for JsString {
    fn from(value: &JsString) -> Self { value.clone() }
}
impl PartialEq<str> for JsString {
    fn eq(&self, value: &str) -> bool { self.units.iter().copied().eq(value.encode_utf16()) }
}
impl PartialEq<&str> for JsString {
    fn eq(&self, value: &&str) -> bool { self == *value }
}

impl std::ops::IndexMut<&str> for DocumentValue {
    fn index_mut(&mut self, key: &str) -> &mut Self {
        let Self::Object(entries) = self else { panic!("expected object") };
        let index = match entries.iter().position(|(name, _)| name == key) {
            Some(index) => index,
            None => {
                // #8104: a new numeric key must land where `ordered_object` puts it.
                entries.push((key.into(), Self::Null));
                sort_entries(entries);
                entries.iter().position(|(name, _)| name == key).expect("key was just inserted")
            },
        };
        &mut entries[index].1
    }
}
impl PartialEq<bool> for DocumentValue {
    fn eq(&self, value: &bool) -> bool { matches!(self, Self::Bool(b) if b == value) }
}
