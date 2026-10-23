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
    String(String),
    Array(Vec<PropertyValue>),
    Object(Vec<(String, PropertyValue)>),
}

/// One named property or quantity.
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyEntryInput {
    pub name: String,
    pub value: PropertyValue,
}

/// A named property set with its members.
#[derive(Debug, Clone, PartialEq)]
pub struct PropertySetInput {
    pub name: String,
    pub properties: Vec<PropertyEntryInput>,
}

/// A named quantity set with its members.
#[derive(Debug, Clone, PartialEq)]
pub struct QuantitySetInput {
    pub name: String,
    pub quantities: Vec<PropertyEntryInput>,
}

/// An assigned type, projected to its semantic identity.
///
/// The type's `GlobalId` is deliberately not represented: it is not hashed,
/// and carrying it here would invite a future change to hash it. See the
/// module docs.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TypeAssignmentInput {
    /// Name of the assigned type, e.g. `WT-200`.
    pub name: Option<String>,
    /// IFC class of the assigned type, e.g. `IfcWallType`.
    pub type_name: Option<String>,
}

/// Everything the fingerprint hashes about one entity.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DataFingerprintInput {
    pub ifc_type: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub object_type: Option<String>,
    pub predefined_type: Option<String>,
    /// The entity's `Tag`, **for a type object only**. See the module docs.
    pub tag: Option<String>,
    pub property_sets: Vec<PropertySetInput>,
    pub quantity_sets: Vec<QuantitySetInput>,
    pub type_assignments: Vec<TypeAssignmentInput>,
    /// Resolved material NAMES, every indirection already followed.
    pub materials: Vec<String>,
    /// Resolved classification references, each already one string.
    pub classifications: Vec<String>,
}
