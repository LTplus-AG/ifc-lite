// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Typed DTO transport over lossless documents. No string escape conventions.
use crate::{DocumentValue, JsString};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::{self, Visitor, IntoDeserializer}};
use std::fmt;
pub use crate::document_ser::to_document;
pub(crate) const STRING: &str = "ifc-lite::JsString";
pub type Error = serde_json::Error;
pub(crate) fn error(message: impl fmt::Display) -> Error { de::Error::custom(message) }

impl Serialize for JsString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(scalar) = self.as_str() { serializer.serialize_str(scalar) }
        else if serializer.is_human_readable() {
            Err(serde::ser::Error::custom("non-scalar JavaScript string requires document_serde::to_document"))
        } else { serializer.serialize_newtype_struct(STRING, self.units()) }
    }
}
struct StringVisitor;
impl<'de> Visitor<'de> for StringVisitor {
    type Value = JsString;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("a JavaScript string") }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<JsString, E> { Ok(value.into()) }
    fn visit_string<E: de::Error>(self, value: String) -> Result<JsString, E> { Ok(value.into()) }
    fn visit_newtype_struct<D: Deserializer<'de>>(self, d: D) -> Result<JsString, D::Error> {
        d.deserialize_any(self)
    }
    fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<JsString, A::Error> {
        let mut units = Vec::new();
        while let Some(unit) = seq.next_element()? { units.push(unit); }
        Ok(JsString::from_units(units))
    }
}
impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_newtype_struct(STRING, StringVisitor)
    }
}
pub fn from_document<T: de::DeserializeOwned>(value: DocumentValue) -> Result<T, Error> { T::deserialize(value) }

struct Sequence(std::vec::IntoIter<DocumentValue>);
impl<'de> de::SeqAccess<'de> for Sequence {
    type Error = Error;
    fn next_element_seed<T: de::DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Error> {
        self.0.next().map(|value| seed.deserialize(value)).transpose()
    }
}
impl Sequence {
    /// serde_json's `end_seq`: a visitor that returns `Ok` without reading every
    /// element (a tuple, tuple variant or struct given too many) is an error.
    fn end(self) -> Result<(), Error> {
        match self.0.len() { 0 => Ok(()), n => Err(error(format!("{n} unread trailing element(s) in sequence"))) }
    }
}
struct Object { entries: std::vec::IntoIter<(JsString, DocumentValue)>, next: Option<DocumentValue> }
impl<'de> de::MapAccess<'de> for Object {
    type Error = Error;
    fn next_key_seed<K: de::DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, Error> {
        let Some((key, value)) = self.entries.next() else { return Ok(None) };
        self.next = Some(value);
        seed.deserialize(crate::document_key_de::KeyDeserializer(key)).map(Some)
    }
    fn next_value_seed<V: de::DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        seed.deserialize(self.next.take().ok_or_else(|| error("value without key"))?)
    }
}
impl Object {
    /// serde_json's `end_map`: entries (or a key whose value was never read)
    /// left behind by a visitor that returned `Ok` are an error.
    fn end(self) -> Result<(), Error> {
        match self.entries.len() + usize::from(self.next.is_some()) {
            0 => Ok(()),
            n => Err(error(format!("{n} unread trailing object entries"))),
        }
    }
}
macro_rules! integer {
    // `$bits` is the magnitude width, so the exclusive upper bound 2^bits is exact
    // in f64. `<$ty>::MAX as f64` rounds up to 2^63 / 2^64 and must not be used.
    ($method:ident, $visit:ident, $ty:ty, $bits:expr) => {
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
            match self {
                Self::Number(n) if n.is_finite() && n.fract() == 0.0
                    && n >= <$ty>::MIN as f64 && n < (1u128 << $bits) as f64 => visitor.$visit(n as $ty),
                _ => Err(error("expected an integer")),
            }
        }
    };
}
impl<'de> Deserializer<'de> for DocumentValue {
    type Error = Error;
    // Match DocumentSerializer, including inside sequences, maps and newtypes.
    fn is_human_readable(&self) -> bool { false }
    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Self::Null => visitor.visit_unit(), Self::Bool(b) => visitor.visit_bool(b),
            Self::Number(n) => visitor.visit_f64(n),
            Self::String(s) => match s.as_str() {
                Some(scalar) => visitor.visit_str(scalar),
                None => visitor.visit_newtype_struct(serde::de::value::SeqDeserializer::<_, Error>::new(
                    s.units().iter().copied().map(IntoDeserializer::into_deserializer))),
            },
            Self::Array(a) => {
                let mut seq = Sequence(a.into_iter());
                let value = visitor.visit_seq(&mut seq)?;
                seq.end()?;
                Ok(value)
            },
            Self::Object(o) => {
                let mut map = Object { entries: o.into_iter(), next: None };
                let value = visitor.visit_map(&mut map)?;
                map.end()?;
                Ok(value)
            },
        }
    }
    fn deserialize_newtype_struct<V: Visitor<'de>>(self, name: &'static str, visitor: V) -> Result<V::Value, Error> {
        if name == STRING {
            match self {
                Self::String(s) => match s.as_str() {
                    Some(scalar) => visitor.visit_newtype_struct(serde::de::value::StrDeserializer::<Error>::new(scalar)),
                    None => visitor.visit_newtype_struct(serde::de::value::SeqDeserializer::<_, Error>::new(
                        s.units().iter().copied().map(IntoDeserializer::into_deserializer))),
                },
                _ => Err(error("expected JavaScript string")),
            }
        } else { visitor.visit_newtype_struct(self) }
    }
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if matches!(self, Self::Null) { visitor.visit_none() } else { visitor.visit_some(self) }
    }
    fn deserialize_enum<V: Visitor<'de>>(self, _: &'static str, _: &'static [&'static str], visitor: V) -> Result<V::Value, Error> {
        crate::document_enum::Enum::from_document(self).and_then(|access| visitor.visit_enum(access))
    }
    integer!(deserialize_i8, visit_i8, i8, 7);
    integer!(deserialize_i16, visit_i16, i16, 15);
    integer!(deserialize_i32, visit_i32, i32, 31);
    integer!(deserialize_i64, visit_i64, i64, 63);
    integer!(deserialize_u8, visit_u8, u8, 8);
    integer!(deserialize_u16, visit_u16, u16, 16);
    integer!(deserialize_u32, visit_u32, u32, 32);
    integer!(deserialize_u64, visit_u64, u64, 64);
    serde::forward_to_deserialize_any! { bool f32 f64 char str string bytes byte_buf unit unit_struct seq tuple tuple_struct map struct identifier ignored_any }
}
impl Serialize for DocumentValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(), Self::Bool(b) => serializer.serialize_bool(*b),
            Self::Number(n) => serializer.serialize_f64(*n), Self::String(s) => s.serialize(serializer),
            Self::Array(a) => a.serialize(serializer),
            Self::Object(o) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(o.len()))?;
                for (key, value) in o { map.serialize_entry(key, value)?; }
                map.end()
            },
        }
    }
}
