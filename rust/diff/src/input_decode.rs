// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Direct deserialization avoids JSON's loss of non-finite adapter numbers.
use crate::input::PropertyValue;
use serde::{Deserialize, Deserializer, de::{Visitor, SeqAccess, MapAccess}};
use std::fmt;

/// Optional JS collections may be present with `undefined`, not only omitted.
pub(crate) fn optional_values<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where D: Deserializer<'de>, T: Deserialize<'de> {
    Option::<Vec<T>>::deserialize(deserializer).map(Option::unwrap_or_default)
}

impl<'de> Deserialize<'de> for PropertyValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PropertyVisitor;
        impl<'de> Visitor<'de> for PropertyVisitor {
            type Value = PropertyValue;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an IFC property scalar, array, or object")
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> { Ok(PropertyValue::Null) }
            fn visit_none<E>(self) -> Result<Self::Value, E> { Ok(PropertyValue::Null) }
            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> { Ok(PropertyValue::Bool(value)) }
            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> { Ok(PropertyValue::Number(value)) }
            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> { Ok(PropertyValue::Number(value as f64)) }
            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> { Ok(PropertyValue::Number(value as f64)) }
            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> { Ok(PropertyValue::String(value.into())) }
            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> { Ok(PropertyValue::String(value)) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = access.next_element()? { values.push(value); }
                Ok(PropertyValue::Array(values))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = access.next_entry()? { values.push(value); }
                Ok(PropertyValue::Object(values))
            }
        }
        deserializer.deserialize_any(PropertyVisitor)
    }
}
