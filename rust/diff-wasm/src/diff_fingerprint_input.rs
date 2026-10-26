// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Lossless fingerprint input (#8042/#8081): preserve original UTF-16 code
//! units while observing only the typed projection, never ignored record fields.
use ifc_lite_diff::input::{DataFingerprintInput, PropertyEntryInput, PropertySetInput,
    QuantitySetInput, TypeAssignmentInput, PropertyValue};
use ifc_lite_diff::fingerprint::{check_property_sets, check_quantity_sets, check_type_assignments};
use ifc_lite_diff::JsString as NativeJsString;
use ifc_lite_diff::sparse_collection::SparseCollection;
use serde::{Deserialize, Deserializer, de::{DeserializeOwned, Error as _, Visitor, SeqAccess, MapAccess}};
use wasm_bindgen::prelude::*;
use std::{cell::RefCell, fmt};

#[derive(Default)]
struct DecodeState { components: bool, raised: Option<JsValue> }
thread_local! {
    static DECODE_STATE: RefCell<DecodeState> = RefCell::new(DecodeState::default());
}
// No state borrow crosses a host call. Reentrant calls save/restore their
// caller's mode and exception instead of clearing or overwriting them (#8114).
struct DecodeScope(DecodeState);
impl DecodeScope {
    fn enter(components: bool) -> Self {
        Self(DECODE_STATE.with(|state| state.replace(DecodeState { components, raised: None })))
    }
}
impl Drop for DecodeScope {
    fn drop(&mut self) {
        DECODE_STATE.with(|state| state.replace(std::mem::take(&mut self.0)));
    }
}
pub(super) fn raise<E: serde::de::Error>(error: JsValue) -> E {
    DECODE_STATE.with(|state| { state.borrow_mut().raised.get_or_insert(error); });
    E::custom("fingerprint decode failed")
}
fn null_record<E: serde::de::Error>(null: bool) -> E {
    raise(js_sys::TypeError::new(&format!("Cannot read properties of {} (reading 'name')",
        if null { "null" } else { "undefined" })).into())
}
// Keep the first serde diagnostic too: wrapping it with `custom` at every
// nested collection otherwise adds an `Error:` prefix per level (#8114).
fn nested_error<E: serde::de::Error>(error: serde_wasm_bindgen::Error) -> E {
    raise(JsValue::from_str(&error.to_string()))
}

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

/// An absent index (hole) is skipped and kept as a hole, but a PRESENT `null` or
/// `undefined` element throws when the record's `name` is read. serde cannot
/// tell a hole from `undefined`, so read one `length` with Array.map's ToLength
/// and RangeError bound, then HasProperty/Get per index in order (#8042, #8114).
/// This is not full Array.map observation parity: the raw decoder does not read
/// the live `map` or `constructor` (the oracle reads it before its RangeError).
struct Sparse<T>(SparseCollection<T>);
impl<'de, T: DeserializeOwned> Deserialize<'de> for Sparse<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let original: JsValue = serde_wasm_bindgen::preserve::deserialize(deserializer)?;
        if !crate::diff_sidecar_host::array(&original).map_err(raise::<D::Error>)? {
            // Other iterables never had holes; their elements are all present.
            return Vec::<T>::deserialize(super::diff_fingerprint_de::Deserializer(original))
                .map(|values| Self(values.into())).map_err(nested_error::<D::Error>);
        }
        let length = super::diff_fingerprint_host::sparse_array_length(&original).map_err(raise::<D::Error>)?;
        // Never reserve a file-supplied length, and COUNT holes: a valid
        // 2^32 - 1 slot array costs O(present) memory. CPU stays one host
        // HasProperty per index, as in the oracle's own map walk.
        let mut slots = SparseCollection::default();
        for index in 0..length {
            let key = JsValue::from_f64(f64::from(index));
            if !js_sys::Reflect::has(&original, &key).map_err(raise::<D::Error>)? { slots.push_holes(1); continue; }
            let element = js_sys::Reflect::get(&original, &key).map_err(raise::<D::Error>)?;
            if element.is_null() || element.is_undefined() {
                return Err(null_record(element.is_null()));
            }
            slots.push(super::diff_fingerprint_de::from_value(element).map_err(nested_error::<D::Error>)?);
        }
        Ok(Self(slots))
    }
}
fn optional_sparse<'de, D, T>(deserializer: D) -> Result<SparseCollection<T>, D::Error>
where D: Deserializer<'de>, T: DeserializeOwned {
    Option::<Sparse<T>>::deserialize(deserializer).map(|slots| slots.map_or_else(Default::default, |slots| slots.0))
}
fn components() -> bool { DECODE_STATE.with(|state| state.borrow().components) }
/// Ask the host engine whether it can build a string this long (#8114).
fn fits<E: serde::de::Error>(length: u64) -> Result<(), E> {
    super::diff_fingerprint_host::string_fits(length as f64).map_err(raise::<E>)
}
// The oracle maps the WHOLE current collection, sorts it (stableSerialize
// tiebreaks) and, for components, hashes every set's members and then iterates
// its holes, all before observing the next collection. A present null in this
// array wins over its string lengths; a length over the engine maximum wins
// over its holes; both win over errors in a later array (#8114).
fn outer_holes<E: serde::de::Error>(components: bool, holes: usize) -> Result<(), E> {
    if components && holes > 0 { Err(null_record(false)) } else { Ok(()) }
}
fn property_sets<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SparseCollection<PropertySetInput>, D::Error> {
    let sets = optional_sparse::<D, PropertySet>(deserializer)?
        .map(|set| PropertySetInput { name: set.name.0, properties: set.properties.0.map(entry) });
    check_property_sets(&sets, components(), &mut fits::<D::Error>)?;
    outer_holes(components(), sets.holes()).map(|()| sets)
}
fn quantity_sets<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SparseCollection<QuantitySetInput>, D::Error> {
    let sets = optional_sparse::<D, QuantitySet>(deserializer)?
        .map(|set| QuantitySetInput { name: set.name.0, quantities: set.quantities.0.map(entry) });
    check_quantity_sets(&sets, components(), &mut fits::<D::Error>)?;
    outer_holes(components(), sets.holes()).map(|()| sets)
}
fn type_assignments<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SparseCollection<TypeAssignmentInput>, D::Error> {
    let types = optional_sparse::<D, TypeAssignment>(deserializer)?.map(|value| TypeAssignmentInput {
        name: value.name.map(|value| value.0), type_name: value.type_name.map(|value| value.0),
    });
    check_type_assignments(&types, components(), &mut fits::<D::Error>).map(|()| types)
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
    #[serde(deserialize_with = "property_sets")]
    property_sets: SparseCollection<PropertySetInput>,
    #[serde(deserialize_with = "quantity_sets")]
    quantity_sets: SparseCollection<QuantitySetInput>,
    #[serde(deserialize_with = "type_assignments")]
    type_assignments: SparseCollection<TypeAssignmentInput>,
    #[serde(deserialize_with = "optional_values")]
    materials: Vec<LosslessString>,
    #[serde(deserialize_with = "optional_values")]
    classifications: Vec<LosslessString>,
}
#[derive(Deserialize)]
struct PropertySet { name: LosslessString, properties: Sparse<Entry> }
#[derive(Deserialize)]
struct QuantitySet { name: LosslessString, quantities: Sparse<Entry> }
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
            return super::diff_fingerprint_de::from_value::<LosslessString>(original)
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
        serde::Deserializer::deserialize_any(super::diff_fingerprint_de::Deserializer(original), PropertyVisitor)
            .map_err(D::Error::custom)
    }
}

fn entry(value: Entry) -> PropertyEntryInput {
    PropertyEntryInput { name: value.name.0, value: value.value.0 }
}
pub(super) fn decode(value: JsValue, components: bool) -> Result<DataFingerprintInput, JsValue> {
    let _scope = DecodeScope::enter(components);
    // Each host observation returns a Result before crossing an owning Rust
    // frame. An outer JS catch cannot run the destructors of abandoned frames.
    let input = super::diff_fingerprint_de::from_value::<Input>(value)
        .map_err(|error| DECODE_STATE.with(|state| state.borrow_mut().raised.take())
            .unwrap_or_else(|| JsValue::from_str(&error.to_string())))?;
    Ok(DataFingerprintInput {
        ifc_type: input.ifc_type.0,
        name: input.name.map(|value| value.0),
        description: input.description.map(|value| value.0),
        object_type: input.object_type.map(|value| value.0),
        predefined_type: input.predefined_type.map(|value| value.0),
        tag: input.tag.map(|value| value.0),
        property_sets: input.property_sets,
        quantity_sets: input.quantity_sets,
        type_assignments: input.type_assignments,
        materials: input.materials.into_iter().map(|value| value.0).collect(),
        classifications: input.classifications.into_iter().map(|value| value.0).collect(),
    })
}
