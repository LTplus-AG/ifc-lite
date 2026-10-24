// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Staging #8081: preserve consumed strings before serde's lossy JS decoding.
//! Only the fixed option paths below are visited here; all other values retain
//! the existing serde_json conversion (including its non-finite limitations).
use js_sys::{Array, JsString};
use serde::{Deserialize, Deserializer, de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor}};
use serde_json::Value;
use std::fmt;
use wasm_bindgen::prelude::*;

const NON_SCALAR: &str = "WASM diff comparison inputs require well-formed UTF-16; use the public TypeScript diffModels API for this input (#8042).";

pub(super) struct ScalarString(pub String);
impl<'de> Deserialize<'de> for ScalarString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let original: JsString = serde_wasm_bindgen::preserve::deserialize(deserializer)?;
        char::decode_utf16(original.iter()).collect::<Result<String, _>>()
            .map(Self).map_err(|_| D::Error::custom(NON_SCALAR))
    }
}

// This is a bounded typed projection, not a recursive JS prewalk. Each getter
// is decoded once, and only strings actually read by options_from_json are
// checked. In particular, alias tuple tails and non-array families stay plain.
#[derive(Clone, Copy)]
enum Path { Root, Strings, Aliases, Pair, Families, String, Plain }
impl<'de> DeserializeSeed<'de> for Path {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        let original: JsValue = serde_wasm_bindgen::preserve::deserialize(deserializer)?;
        if matches!(self, Self::String) && original.is_string() {
            return serde_wasm_bindgen::from_value::<ScalarString>(original)
                .map(|value| Value::String(value.0)).map_err(D::Error::custom);
        }
        let array = Array::is_array(&original);
        let projected = match self {
            Self::Root => original.is_object() && !original.is_null() && !array,
            Self::Strings | Self::Aliases | Self::Pair | Self::Families => array,
            Self::String | Self::Plain => false,
        };
        if projected {
            serde::Deserializer::deserialize_any(serde_wasm_bindgen::Deserializer::from(original), Projection(self))
                .map_err(D::Error::custom)
        } else {
            serde_wasm_bindgen::from_value(original).map_err(D::Error::custom)
        }
    }
}
struct Projection(Path);
impl<'de> Visitor<'de> for Projection {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("diff options or an option array")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Value, A::Error> {
        let mut values = serde_json::Map::new();
        while let Some(key) = access.next_key::<String>()? {
            let path = match key.as_str() {
                "excludeTypes" => Path::Strings,
                "keyAliases" => Path::Aliases,
                "classFamilies" => Path::Families,
                _ => Path::Plain,
            };
            values.insert(key, access.next_value_seed(path)?);
        }
        Ok(Value::Object(values))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        loop {
            let path = match self.0 {
                Path::Strings => Path::String,
                Path::Aliases => Path::Pair,
                Path::Pair if values.len() < 2 => Path::String,
                Path::Families => Path::Strings,
                _ => Path::Plain,
            };
            let Some(value) = access.next_element_seed(path)? else { break; };
            values.push(value);
        }
        Ok(Value::Array(values))
    }
}

pub(super) fn options(value: JsValue) -> Result<Value, JsValue> {
    Path::Root.deserialize(serde_wasm_bindgen::Deserializer::from(value))
        .map_err(|error| JsValue::from_str(&error.to_string()))
}
