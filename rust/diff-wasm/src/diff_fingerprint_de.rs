// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Private serde adapter for fingerprint input. Mirrors serde-wasm-bindgen
//! 0.6.5's observations, but every fallible host import returns through Result.
use super::{diff_fingerprint_host as host, diff_sidecar_host as shared};
use super::diff_fingerprint_input::raise;
use serde::de::{self, DeserializeOwned, DeserializeSeed, Error as _, Visitor};
use serde_wasm_bindgen::Error;
use wasm_bindgen::prelude::*;

type Result<T> = std::result::Result<T, Error>;
pub(super) struct Deserializer(pub JsValue);
pub(super) fn from_value<T: DeserializeOwned>(value: JsValue) -> Result<T> {
    T::deserialize(Deserializer(value))
}
fn caught<T>(value: std::result::Result<T, JsValue>) -> Result<T> {
    value.map_err(raise::<Error>)
}
fn get(value: &JsValue, key: &str) -> Result<JsValue> { caught(shared::get(value, key)) }
fn index(value: &JsValue, key: u32) -> Result<JsValue> {
    caught(shared::get_key(value, &JsValue::from_f64(f64::from(key))))
}
fn bytes(value: &JsValue) -> Result<Option<Vec<u8>>> {
    let copy = caught(host::bytes(value))?;
    Ok((!copy.is_undefined()).then(|| copy.unchecked_into::<js_sys::Uint8Array>().to_vec()))
}
fn invalid<T>(value: &JsValue, expected: &dyn de::Expected) -> Result<T> {
    let unexpected = if value.is_null_or_undefined() {
        de::Unexpected::Unit
    } else if let Some(b) = value.as_bool() {
        de::Unexpected::Bool(b)
    } else if let Some(n) = value.as_f64() {
        de::Unexpected::Float(n)
    } else if let Some(s) = value.as_string() {
        return Err(Error::invalid_type(de::Unexpected::Str(&s), expected));
    } else if let Some(b) = bytes(value)? {
        return Err(Error::invalid_type(de::Unexpected::Bytes(&b), expected));
    } else {
        let text = caught(host::debug(value))?;
        return Err(Error::invalid_type(de::Unexpected::Other(&text), expected));
    };
    Err(Error::invalid_type(unexpected, expected))
}

// A typed projection reads each declared field once in declaration order,
// checks `in` only after undefined, and never enumerates ignored fields.
struct Fields {
    object: JsValue,
    fields: std::slice::Iter<'static, &'static str>,
    pending: Option<JsValue>,
}
impl<'de> de::MapAccess<'de> for Fields {
    type Error = Error;
    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>> {
        for field in &mut self.fields {
            let value = get(&self.object, field)?;
            if value.is_undefined() && !caught(js_sys::Reflect::has(&self.object, &(*field).into()))? {
                continue;
            }
            self.pending = Some(value);
            return seed.deserialize(de::value::StrDeserializer::<Error>::new(field)).map(Some);
        }
        Ok(None)
    }
    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value> {
        seed.deserialize(Deserializer(self.pending.take().expect("field key precedes value")))
    }
}

enum Sequence {
    Array { value: JsValue, index: u32, length: u32 },
    Iterator(JsValue),
}
impl Sequence {
    fn array(value: JsValue) -> Result<Self> {
        let length = caught(host::array_length(&value))?;
        Ok(Self::Array { value, index: 0, length })
    }
    fn next(&mut self) -> Result<Option<JsValue>> {
        match self {
            Self::Array { value, index: cursor, length } => {
                if *cursor == *length { return Ok(None); }
                let value = index(value, *cursor)?;
                *cursor += 1;
                Ok(Some(value))
            }
            Self::Iterator(iterator) => {
                let step = caught(host::next(iterator))?;
                if caught(host::done(&step))? != 0 { Ok(None) } else { get(&step, "value").map(Some) }
            }
        }
    }
}
impl<'de> de::SeqAccess<'de> for Sequence {
    type Error = Error;
    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>> {
        self.next()?.map(|value| seed.deserialize(Deserializer(value))).transpose()
    }
}
struct Entries { sequence: Sequence, pending: Option<JsValue> }
impl<'de> de::MapAccess<'de> for Entries {
    type Error = Error;
    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>> {
        let Some(pair) = self.sequence.next()? else { return Ok(None); };
        // serde reads both pair members before deserializing the key.
        let key = index(&pair, 0)?;
        self.pending = Some(index(&pair, 1)?);
        seed.deserialize(Deserializer(key)).map(Some)
    }
    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value> {
        seed.deserialize(Deserializer(self.pending.take().expect("entry key precedes value")))
    }
}

impl<'de> de::Deserializer<'de> for Deserializer {
    type Error = Error;
    fn deserialize_struct<V: Visitor<'de>>(self, _name: &'static str,
        fields: &'static [&'static str], visitor: V) -> Result<V::Value> {
        if !self.0.is_object() { return invalid(&self.0, &visitor); }
        visitor.visit_map(Fields { object: self.0, fields: fields.iter(), pending: None })
    }
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
        if self.0.is_null_or_undefined() { visitor.visit_none() } else { visitor.visit_some(self) }
    }
    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
        if caught(shared::array(&self.0))? {
            return visitor.visit_seq(Sequence::array(self.0)?);
        }
        let iterator = caught(host::iterator(&self.0))?;
        if iterator.is_undefined() { return invalid(&self.0, &visitor); }
        visitor.visit_seq(Sequence::Iterator(iterator))
    }
    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
        let iterator = caught(host::iterator(&self.0))?;
        let sequence = if !iterator.is_undefined() {
            Sequence::Iterator(iterator)
        } else if self.0.is_object() {
            // Object.entries eagerly observes the current object's members,
            // as in 0.6.5; recursive values are decoded only afterwards.
            Sequence::array(caught(host::entries(&self.0))?)?
        } else { return invalid(&self.0, &visitor); };
        visitor.visit_map(Entries { sequence, pending: None })
    }
    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
        if self.0.is_null_or_undefined() { return visitor.visit_unit(); }
        if let Some(b) = self.0.as_bool() { return visitor.visit_bool(b); }
        if self.0.is_bigint() || self.0.as_f64().is_some() || self.0.is_string() {
            // Primitive-only serde paths cannot run a file-supplied getter.
            return de::Deserializer::deserialize_any(serde_wasm_bindgen::Deserializer::from(self.0), visitor);
        }
        if caught(shared::array(&self.0))? { return de::Deserializer::deserialize_seq(self, visitor); }
        if let Some(b) = bytes(&self.0)? { return visitor.visit_byte_buf(b); }
        if self.0.is_object() && (!caught(host::iterable(&self.0))? || caught(host::map(&self.0))?) {
            return de::Deserializer::deserialize_map(self, visitor);
        }
        invalid(&self.0, &visitor)
    }
    fn deserialize_tuple_struct<V: Visitor<'de>>(self, name: &'static str, len: usize,
        visitor: V) -> Result<V::Value> {
        // Only serde-wasm-bindgen::preserve calls this in the fingerprint
        // shapes. Its magic handle transfer performs no host observations.
        de::Deserializer::deserialize_tuple_struct(serde_wasm_bindgen::Deserializer::from(self.0), name, len, visitor)
    }
    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 char str string bytes byte_buf
        unit unit_struct newtype_struct tuple enum identifier ignored_any
    }
}
