// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Externally tagged enums, matching `document_ser`: a unit variant is its name
//! as a string, every other variant is a one-entry object `{ name: content }`.
use crate::{DocumentValue as Value, JsString, document_serde::{Error, error}};
use serde::de::{self, DeserializeSeed, Visitor};

pub(crate) struct Enum { variant: JsString, content: Option<Value> }
impl Enum {
    pub(crate) fn from_document(value: Value) -> Result<Self, Error> {
        match value {
            Value::String(variant) => Ok(Self { variant, content: None }),
            Value::Object(mut entries) if entries.len() == 1 => {
                let (variant, content) = entries.remove(0);
                Ok(Self { variant, content: Some(content) })
            },
            Value::Object(_) => Err(error("expected an enum object with exactly one variant")),
            _ => Err(error("expected enum string or object")),
        }
    }
}
impl<'de> de::EnumAccess<'de> for Enum {
    type Error = Error;
    type Variant = Variant;
    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Variant), Error> {
        // A variant name is an identifier; a non-scalar one never matches.
        if self.variant.as_str().is_none() { return Err(error("non-scalar enum variant")); }
        let value = seed.deserialize(Value::String(self.variant))?;
        Ok((value, Variant(self.content)))
    }
}
pub(crate) struct Variant(Option<Value>);
impl Variant {
    fn content(self, expected: &str) -> Result<Value, Error> {
        self.0.ok_or_else(|| error(format!("expected {expected} variant content")))
    }
}
impl<'de> de::VariantAccess<'de> for Variant {
    type Error = Error;
    fn unit_variant(self) -> Result<(), Error> {
        match self.0 { None | Some(Value::Null) => Ok(()), Some(_) => Err(error("unexpected content for unit variant")) }
    }
    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, Error> {
        seed.deserialize(self.content("newtype")?)
    }
    fn tuple_variant<V: Visitor<'de>>(self, _: usize, visitor: V) -> Result<V::Value, Error> {
        match self.content("tuple")? {
            array @ Value::Array(_) => de::Deserializer::deserialize_seq(array, visitor),
            _ => Err(error("expected an array for tuple variant")),
        }
    }
    fn struct_variant<V: Visitor<'de>>(self, _: &'static [&'static str], visitor: V) -> Result<V::Value, Error> {
        match self.content("struct")? {
            object @ Value::Object(_) => de::Deserializer::deserialize_map(object, visitor),
            _ => Err(error("expected an object for struct variant")),
        }
    }
}
