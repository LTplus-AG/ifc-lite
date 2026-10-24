// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Object keys follow serde_json 1.0.154's value/de.rs MapKeyDeserializer,
//! with the document bridge's non-human-readable mode and lossless JsString.
use crate::{
    document_serde::{error, Error, STRING},
    DocumentValue, JsString,
};
use serde::{de::Visitor, Deserializer};

pub(crate) struct KeyDeserializer(pub(crate) JsString);
macro_rules! numeric {
    ($method:ident) => {
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
            let key = self
                .0
                .as_str()
                .ok_or_else(|| error("expected numeric key"))?;
            // MapKeyDeserializer requires an immediate digit/minus and EOF.
            // Public Deserializer::end skips whitespace, so reject that tail
            // explicitly rather than accepting spellings JSON keys reject.
            if !matches!(key.as_bytes().first(), Some(b'0'..=b'9' | b'-'))
                || key.as_bytes().last().is_some_and(u8::is_ascii_whitespace)
            {
                return Err(error("expected numeric key"));
            }
            // Delegate grammar, float_roundtrip and integer bounds to the
            // pinned parser. Never parse through the document's f64 numbers.
            // A reader cannot lend strings from this locally owned key to V.
            let mut deserializer = serde_json::Deserializer::from_reader(key.as_bytes());
            let value = deserializer.$method(visitor)?;
            deserializer.end()?;
            Ok(value)
        }
    };
}
impl<'de> Deserializer<'de> for KeyDeserializer {
    type Error = Error;
    fn is_human_readable(&self) -> bool {
        false
    }
    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        DocumentValue::String(self.0).deserialize_any(visitor)
    }
    numeric!(deserialize_i8);
    numeric!(deserialize_i16);
    numeric!(deserialize_i32);
    numeric!(deserialize_i64);
    numeric!(deserialize_i128);
    numeric!(deserialize_u8);
    numeric!(deserialize_u16);
    numeric!(deserialize_u32);
    numeric!(deserialize_u64);
    numeric!(deserialize_u128);
    numeric!(deserialize_f32);
    numeric!(deserialize_f64);
    fn deserialize_bool<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0.as_str() {
            Some("true") => visitor.visit_bool(true),
            Some("false") => visitor.visit_bool(false),
            _ => Err(error("expected boolean key")),
        }
    }
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        // JSON object keys cannot be null, even though Option keys cannot serialize.
        visitor.visit_some(self)
    }
    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        if name == STRING {
            DocumentValue::String(self.0).deserialize_newtype_struct(name, visitor)
        } else {
            visitor.visit_newtype_struct(self)
        }
    }
    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        DocumentValue::String(self.0).deserialize_enum(name, variants, visitor)
    }
    serde::forward_to_deserialize_any! {
        char str string bytes byte_buf unit unit_struct seq tuple tuple_struct
        map struct identifier ignored_any
    }
}
