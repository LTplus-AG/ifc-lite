// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Explicit batch input: sparse cardinality and scalar tokens are lossless.
use ifc_lite_diff::{DocumentValue as Value, JsString, document_serde,
    input::{DataFingerprintInput, PropertyEntryInput, PropertySetInput, PropertyValue, QuantitySetInput, TypeAssignmentInput},
    sparse_collection::SparseCollection,
    fingerprint::build_fingerprint_pair_checked};
use wasm_bindgen::prelude::*;

// The wire already owns lossless JsStrings. Move them into the typed DTO rather
// than asking serde to project them to UTF-8 and allocate UTF-16 again (#8042).
struct Fields(Vec<(JsString, Value)>);
impl Fields {
    fn new(value: Value) -> Result<Self, String> {
        match value { Value::Object(fields) => Ok(Self(fields)), _ => Err("expected fingerprint record".into()) }
    }
    fn take(&mut self, key: &str) -> Result<Option<Value>, String> {
        let Some(index) = self.0.iter().position(|(name, _)| name == key) else { return Ok(None) };
        let value = self.0.remove(index).1;
        if self.0.iter().any(|(name, _)| name == key) { return Err(format!("duplicate field `{key}`")); }
        Ok(Some(value))
    }
    fn required(&mut self, key: &str) -> Result<Value, String> {
        self.take(key)?.ok_or_else(|| format!("missing field `{key}`"))
    }
    fn optional_string(&mut self, key: &str) -> Result<Option<JsString>, String> {
        match self.take(key)? { None | Some(Value::Null) => Ok(None), Some(value) => string(value).map(Some) }
    }
}
fn string(value: Value) -> Result<JsString, String> {
    match value { Value::String(text) => Ok(text), _ => Err("expected JavaScript string".into()) }
}
fn array(value: Value) -> Result<Vec<Value>, String> {
    match value { Value::Array(values) => Ok(values), _ => Err("expected fingerprint array".into()) }
}
fn strings(value: Value) -> Result<Vec<JsString>, String> { array(value)?.into_iter().map(string).collect() }
fn slots<T>(value: Value, parse: impl Fn(Value) -> Result<T, String>) -> Result<SparseCollection<T>, String> {
    let mut fields = Fields::new(value)?;
    let present = array(fields.required("present")?)?.into_iter().map(parse).collect::<Result<Vec<_>, _>>()?;
    let holes: usize = document_serde::from_document(fields.required("holes")?).map_err(|error| error.to_string())?;
    let mut result = SparseCollection::from(present);
    result.push_holes(holes);
    Ok(result)
}
fn present_only<T>(value: Value, key: &str, parse: impl Fn(Value) -> Result<T, String>) -> Result<SparseCollection<T>, String> {
    let result = slots(value, parse)?;
    if result.holes() > 0 { return Err(format!("expected present records in `{key}`")); }
    Ok(result)
}
fn property(value: Value) -> PropertyValue {
    // decode() already bounded document depth before reaching this walk.
    match value {
        Value::Null => PropertyValue::Null, Value::Bool(value) => PropertyValue::Bool(value),
        Value::Number(value) => PropertyValue::Number(value), Value::String(value) => PropertyValue::String(value),
        Value::Array(values) => PropertyValue::Array(values.into_iter().map(property).collect()),
        Value::Object(fields) => PropertyValue::Object(fields.into_iter().map(|(key, value)| (key, property(value))).collect()),
    }
}
fn entry(value: Value) -> Result<PropertyEntryInput, String> {
    let mut fields = Fields::new(value)?;
    Ok(PropertyEntryInput { name: string(fields.required("name")?)?,
        value: property(fields.take("value")?.unwrap_or(Value::Null)) })
}
fn set(value: Value) -> Result<(JsString, SparseCollection<PropertyEntryInput>), String> {
    let mut fields = Fields::new(value)?;
    Ok((string(fields.required("name")?)?, slots(fields.required("members")?, entry)?))
}
fn assignment(value: Value) -> Result<TypeAssignmentInput, String> {
    let mut fields = Fields::new(value)?;
    Ok(TypeAssignmentInput { name: fields.optional_string("name")?, type_name: fields.optional_string("type")? })
}
fn input(value: Value) -> Result<DataFingerprintInput, String> {
    let mut fields = Fields::new(value)?;
    Ok(DataFingerprintInput {
        ifc_type: string(fields.required("ifcType")?)?, name: fields.optional_string("name")?,
        description: fields.optional_string("description")?, object_type: fields.optional_string("objectType")?,
        predefined_type: fields.optional_string("predefinedType")?, tag: fields.optional_string("tag")?,
        property_sets: present_only(fields.required("propertySets")?, "propertySets", |value| {
            let (name, properties) = set(value)?; Ok(PropertySetInput { name, properties })
        })?,
        quantity_sets: present_only(fields.required("quantitySets")?, "quantitySets", |value| {
            let (name, quantities) = set(value)?; Ok(QuantitySetInput { name, quantities })
        })?,
        type_assignments: slots(fields.required("typeAssignments")?, assignment)?,
        materials: strings(fields.required("materials")?)?, classifications: strings(fields.required("classifications")?)?,
    })
}
fn decode_inputs(document: Value) -> Result<Vec<DataFingerprintInput>, String> {
    array(document)?.into_iter().map(input).collect()
}
fn fits(length: u64) -> Result<(), JsValue> {
    super::diff_fingerprint_host::string_fits(length as f64)
}
/// One decode per entity, both fingerprints from the same owned native input.
pub(crate) fn build(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let document = crate::diff_binary::decode(bytes).map_err(|e| JsValue::from_str(&e))?;
    let inputs = decode_inputs(document).map_err(|e| JsValue::from_str(&e))?;
    let mut results = Vec::new();
    for input in inputs {
        let (data, components) = build_fingerprint_pair_checked(&input, fits)?;
        results.push(Value::Object(vec![
            ("dataHash".into(), Value::String(data.into())),
            ("components".into(), Value::Object(components.into_iter()
                .map(|(key, value)| (key, Value::String(value.into()))).collect())),
        ]));
    }
    Ok(crate::diff_binary::encode(&Value::Array(results)))
}

#[cfg(test)]
#[path = "diff_fingerprint_binary_tests.rs"]
mod tests;
