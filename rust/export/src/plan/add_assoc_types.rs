// SPDX-License-Identifier: MPL-2.0
//! Public vocabulary for what a [`super::NewObject`] is associated with: its
//! material, its classification references, its property and quantity
//! values, and the unit each value is measured in.
//!
//! A material, classification or unit names a record already in the source
//! ([`ObjectRef::Id`]: these records carry no GlobalId) or describes a new
//! one. Naming the source's record is how a copy keeps exactly its source's
//! material, classification and units: nothing is duplicated, and the copy
//! joins the relationship that already associates that record when there is
//! one. A new record described the same way by several Adds of one plan is
//! written once and shared.

use super::types::{ObjectRef, PsetKind};

/// The material a new object is associated with through
/// `IfcRelAssociatesMaterial`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum MaterialLink {
    /// A record the schema accepts as `RelatingMaterial`: an `IfcMaterial`,
    /// a layer set or its usage, a material list, and in IFC4 and later a
    /// constituent or profile set or usage.
    Existing(ObjectRef),
    New(NewMaterial),
    NewLayerSet(NewLayerSet),
}

/// A new `IfcMaterial`. `category` is IFC4 and later only; an IFC2X3 file
/// refuses it rather than dropping it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct NewMaterial {
    pub name: String,
    pub category: Option<String>,
}

/// A material for one layer of a new layer set.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum LayerMaterial {
    /// An `IfcMaterial` already in the source.
    Existing(ObjectRef),
    New(NewMaterial),
}

/// One layer of a new `IfcMaterialLayerSet`. `thickness` is in the file's
/// length unit.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct NewMaterialLayer {
    pub material: Option<LayerMaterial>,
    pub thickness: f64,
}

/// A new `IfcMaterialLayerSet`, layers in the order given.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct NewLayerSet {
    pub name: Option<String>,
    pub layers: Vec<NewMaterialLayer>,
}

/// One classification a new object is associated with through
/// `IfcRelAssociatesClassification`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum ClassificationLink {
    /// An `IfcClassificationReference` already in the source (in IFC4 and
    /// later an `IfcClassification` too).
    Existing(ObjectRef),
    New(NewClassificationReference),
}

/// A new `IfcClassificationReference` into `system`. `identification` is
/// written as IFC2X3's `ItemReference`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct NewClassificationReference {
    pub system: ClassificationSystem,
    pub identification: Option<String>,
    pub name: Option<String>,
    pub location: Option<String>,
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum ClassificationSystem {
    /// An `IfcClassification` already in the source.
    Existing(ObjectRef),
    New(NewClassification),
}

/// A new `IfcClassification`. IFC2X3 requires `source` and `edition`, and
/// refuses a classification without them.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct NewClassification {
    pub name: String,
    pub source: Option<String>,
    pub edition: Option<String>,
}

/// The unit a property or quantity value is measured in, when it is not the
/// project's unit for that measure.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ValueUnit {
    /// A unit record already in the source: an `IfcNamedUnit` (SI, conversion
    /// based or context dependent), or for a property an `IfcDerivedUnit` or
    /// `IfcMonetaryUnit`.
    Existing(ObjectRef),
    /// A new `IfcSIUnit`, by its `IfcSIUnitName` (`"PASCAL"`) and optional
    /// `IfcSIPrefix` (`"KILO"`). Its `UnitType` follows from the name. It is
    /// not added to the project's unit assignment: it is this value's unit,
    /// not the project's.
    #[non_exhaustive]
    Si { prefix: Option<String>, name: String },
}

/// A property value, typed the way IFC types it.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum PropertyValue {
    Label(String),
    Text(String),
    Identifier(String),
    Boolean(bool),
    Integer(i64),
    Real(f64),
    /// A numeric measure by its IFC defined-type name, e.g. `IfcLengthMeasure`.
    /// Values are in the file's project units.
    #[non_exhaustive]
    Measure { measure_type: String, value: f64 },
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct NewProperty {
    pub name: String,
    pub value: PropertyValue,
    /// The unit a [`PropertyValue::Measure`] is in, when it is not the
    /// project's unit for that measure. The value is then in this unit.
    pub unit: Option<ValueUnit>,
}

/// A property set (`kind: Property`) or quantity set (`kind: Quantity`,
/// every value a [`PropertyValue::Measure`] with a quantity entity) to
/// attach. Properties are written in the order given.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct NewPropertySet {
    pub name: String,
    pub kind: PsetKind,
    pub properties: Vec<NewProperty>,
}
