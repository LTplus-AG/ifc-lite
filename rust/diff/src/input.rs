// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The input shapes an adapter fills in before hashing.
//!
//! Split out of `fingerprint.rs` so neither module carries both the data
//! definitions and the canonical encoding. These are the Rust spelling of
//! `DataFingerprintInput` and friends in `packages/diff/src/fingerprint.ts`;
//! the reasoning for what each field may and may not carry lives with the
//! hashing code that enforces it.

use crate::JsString;

/// A property or quantity value as supplied by an adapter.
///
/// Mirrors the `unknown` the TypeScript engine accepts, narrowed to the shapes
/// an IFC property value can actually take.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum PropertyValue {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<PropertyValue>),
    Object(Vec<(JsString, PropertyValue)>),
}

/// One named property or quantity.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct PropertyEntryInput {
    pub name: JsString,
    #[serde(default)]
    pub value: PropertyValue,
}

/// A named property set with its members.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct PropertySetInput {
    pub name: JsString,
    pub properties: Vec<PropertyEntryInput>,
}

/// A named quantity set with its members.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct QuantitySetInput {
    pub name: JsString,
    pub quantities: Vec<PropertyEntryInput>,
}

/// An assigned type, projected to its semantic identity.
///
/// The type's `GlobalId` is deliberately not represented: it is not hashed,
/// and carrying it here would invite a future change to hash it. See the
/// module docs.
#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize)]
#[serde(default)]
pub struct TypeAssignmentInput {
    /// Name of the assigned type, e.g. `WT-200`.
    pub name: Option<JsString>,
    /// IFC class of the assigned type, e.g. `IfcWallType`.
    #[serde(rename = "type")]
    pub type_name: Option<JsString>,
}

/// Everything the fingerprint hashes about one entity.
#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DataFingerprintInput {
    pub ifc_type: JsString,
    pub name: Option<JsString>,
    pub description: Option<JsString>,
    pub object_type: Option<JsString>,
    pub predefined_type: Option<JsString>,
    /// The entity's `Tag`, **for a type object only**. See the module docs.
    pub tag: Option<JsString>,
    #[serde(deserialize_with = "crate::input_decode::optional_values")]
    pub property_sets: Vec<PropertySetInput>,
    #[serde(deserialize_with = "crate::input_decode::optional_values")]
    pub quantity_sets: Vec<QuantitySetInput>,
    #[serde(deserialize_with = "crate::input_decode::optional_values")]
    pub type_assignments: Vec<TypeAssignmentInput>,
    /// Resolved material NAMES, every indirection already followed.
    #[serde(deserialize_with = "crate::input_decode::optional_values")]
    pub materials: Vec<JsString>,
    /// Resolved classification references, each already one string.
    #[serde(deserialize_with = "crate::input_decode::optional_values")]
    pub classifications: Vec<JsString>,
}
