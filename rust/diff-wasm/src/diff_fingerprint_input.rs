// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Lossless fingerprint input (#8042/#8081): preserve original UTF-16 code
//! units while observing only the typed projection, never ignored record fields.
use ifc_lite_diff::input::{DataFingerprintInput, PropertyEntryInput, PropertySetInput,
    QuantitySetInput, TypeAssignmentInput, PropertyValue};
use ifc_lite_diff::JsString as NativeJsString;
use serde::{Deserialize, Deserializer, de::{Error as _, Visitor, SeqAccess, MapAccess}};
use wasm_bindgen::prelude::*;
use std::fmt;

#[derive(Default)]
struct LosslessString(NativeJsString);
impl<'de> Deserialize<'de> for LosslessString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let original: JsValue = serde_wasm_bindgen::preserve::deserialize(deserializer)?;
        crate::diff_transport::string(&original).map(Self)
            .map_err(|_| D::Error::custom("expected a string"))
    }
}
fn optional_values<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where D: Deserializer<'de>, T: Deserialize<'de> {
    Option::<Vec<T>>::deserialize(deserializer).map(Option::unwrap_or_default)
}

// Match input.rs defaults and field names, but deserialize every typed string
// through lossless JS code units. Derived struct decoding observes only known fields;
// e.g. typeAssignments.globalId is deliberately not fingerprint content.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Input {
    ifc_type: LosslessString,
    name: Option<LosslessString>,
    description: Option<LosslessString>,
    object_type: Option<LosslessString>,
    predefined_type: Option<LosslessString>,
    tag: Option<LosslessString>,
    #[serde(deserialize_with = "optional_values")]
    property_sets: Vec<PropertySet>,
    #[serde(deserialize_with = "optional_values")]
    quantity_sets: Vec<QuantitySet>,
    #[serde(deserialize_with = "optional_values")]
    type_assignments: Vec<TypeAssignment>,
    #[serde(deserialize_with = "optional_values")]
    materials: Vec<LosslessString>,
    #[serde(deserialize_with = "optional_values")]
    classifications: Vec<LosslessString>,
}
#[derive(Deserialize)]
struct PropertySet { name: LosslessString, properties: Vec<Entry> }
#[derive(Deserialize)]
struct QuantitySet { name: LosslessString, quantities: Vec<Entry> }
#[derive(Deserialize)]
struct Entry {
    name: LosslessString,
    #[serde(default)]
    value: Value,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct TypeAssignment { name: Option<LosslessString>, #[serde(rename = "type")] type_name: Option<LosslessString> }

#[derive(Default)]
struct Value(PropertyValue);
impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // deserialize_any would already have lost unpaired code units before
        // visit_string. Preserve the JS handle first, at EVERY nested value.
        let original: JsValue = serde_wasm_bindgen::preserve::deserialize(deserializer)?;
        if original.is_string() {
            return serde_wasm_bindgen::from_value::<LosslessString>(original)
                .map(|value| Self(PropertyValue::String(value.0))).map_err(D::Error::custom);
        }
        struct PropertyVisitor;
        impl<'de> Visitor<'de> for PropertyVisitor {
            type Value = Value;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an IFC property scalar, array, or object")
            }
            fn visit_unit<E>(self) -> Result<Value, E> { Ok(Value(PropertyValue::Null)) }
            fn visit_none<E>(self) -> Result<Value, E> { Ok(Value(PropertyValue::Null)) }
            fn visit_bool<E>(self, value: bool) -> Result<Value, E> { Ok(Value(PropertyValue::Bool(value))) }
            fn visit_f64<E>(self, value: f64) -> Result<Value, E> { Ok(Value(PropertyValue::Number(value))) }
            fn visit_i64<E>(self, value: i64) -> Result<Value, E> { Ok(Value(PropertyValue::Number(value as f64))) }
            fn visit_u64<E>(self, value: u64) -> Result<Value, E> { Ok(Value(PropertyValue::Number(value as f64))) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Value, A::Error> {
                let mut values = Vec::new();
                while let Some(Value(value)) = access.next_element()? { values.push(value); }
                Ok(Value(PropertyValue::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Value, A::Error> {
                let mut values = Vec::new();
                while let Some((LosslessString(key), Value(value))) = access.next_entry()? {
                    values.push((key, value));
                }
                Ok(Value(PropertyValue::Object(values)))
            }
        }
        serde::Deserializer::deserialize_any(serde_wasm_bindgen::Deserializer::from(original), PropertyVisitor)
            .map_err(D::Error::custom)
    }
}

fn entry(value: Entry) -> PropertyEntryInput {
    PropertyEntryInput { name: value.name.0, value: value.value.0 }
}
pub(super) fn decode(value: JsValue) -> Result<DataFingerprintInput, JsValue> {
    let input: Input = serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(DataFingerprintInput {
        ifc_type: input.ifc_type.0,
        name: input.name.map(|value| value.0),
        description: input.description.map(|value| value.0),
        object_type: input.object_type.map(|value| value.0),
        predefined_type: input.predefined_type.map(|value| value.0),
        tag: input.tag.map(|value| value.0),
        property_sets: input.property_sets.into_iter().map(|set| PropertySetInput {
            name: set.name.0, properties: set.properties.into_iter().map(entry).collect(),
        }).collect(),
        quantity_sets: input.quantity_sets.into_iter().map(|set| QuantitySetInput {
            name: set.name.0, quantities: set.quantities.into_iter().map(entry).collect(),
        }).collect(),
        type_assignments: input.type_assignments.into_iter().map(|value| TypeAssignmentInput {
            name: value.name.map(|value| value.0), type_name: value.type_name.map(|value| value.0),
        }).collect(),
        materials: input.materials.into_iter().map(|value| value.0).collect(),
        classifications: input.classifications.into_iter().map(|value| value.0).collect(),
    })
}
