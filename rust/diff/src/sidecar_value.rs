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
impl JsString {
    pub(crate) fn from_units(units: Vec<u16>) -> Self {
        let scalar = String::from_utf16(&units).ok();
        Self { units, scalar }
    }
    pub(crate) fn units(&self) -> &[u16] { &self.units }
    pub(crate) fn surround(prefix: &str, value: &Self, suffix: &str) -> Self {
        Self::from_units(prefix.encode_utf16().chain(value.units.iter().copied()).chain(suffix.encode_utf16()).collect())
    }
    pub(crate) fn as_str(&self) -> Option<&str> { self.scalar.as_deref() }
    pub(crate) fn is_empty(&self) -> bool { self.units.is_empty() }
    pub(crate) fn is_blank(&self) -> bool {
        self.units.iter().all(|&unit| char::from_u32(u32::from(unit))
            .is_some_and(crate::projections::is_ecmascript_whitespace))
    }
    pub(crate) fn write_json(&self, out: &mut String) {
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
    pub(crate) fn as_string(&self) -> Option<&JsString> { if let Self::String(s) = self { Some(s) } else { None } }
    pub(crate) fn as_str(&self) -> Option<&str> { self.as_string().and_then(JsString::as_str) }
    pub(crate) fn is_string(&self) -> bool { matches!(self, Self::String(_)) }
    pub(crate) fn is_object(&self) -> bool { matches!(self, Self::Object(_)) }
    pub(crate) fn as_f64(&self) -> Option<f64> { if let Self::Number(n) = self { Some(*n) } else { None } }
    pub(crate) fn as_array(&self) -> Option<&Vec<Self>> { if let Self::Array(a) = self { Some(a) } else { None } }
    pub(crate) fn get(&self, key: &str) -> Option<&Self> {
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
pub(crate) fn ordered_object(mut entries: Vec<(JsString, DocumentValue)>) -> DocumentValue {
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
    DocumentValue::Object(entries)
}
