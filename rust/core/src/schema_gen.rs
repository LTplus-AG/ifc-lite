// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC Schema - Dynamic type system
//!
//! Generated from IFC4 EXPRESS schema for maintainability.
//! All types are handled generically through enum dispatch.

use crate::generated::IfcType;
use crate::parser::Token;
use std::collections::HashMap;

/// Geometry representation categories (internal use only)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GeometryCategory {
    SweptSolid,
    Boolean,
    ExplicitMesh,
    MappedItem,
    Surface,
    Curve,
    Other,
}

/// Profile definition categories (internal use only)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProfileCategory {
    Parametric,
    Arbitrary,
    Composite,
}

/// IFC entity attribute value
#[derive(Debug, Clone)]
pub enum AttributeValue {
    /// Entity reference
    EntityRef(u32),
    /// String value
    String(String),
    /// Integer value
    Integer(i64),
    /// Float value
    Float(f64),
    /// STEP binary literal `"0FF"`: the raw content between the quotes
    /// (unused-bits digit, then hex), undecoded. Decode it with
    /// [`crate::step_encoding::decode_step_binary`].
    Binary(String),
    /// Enum value
    Enum(String),
    /// List of values
    List(Vec<AttributeValue>),
    /// Null/undefined
    Null,
    /// Derived value (*)
    Derived,
}

impl AttributeValue {
    /// Convert from Token
    ///
    /// A [`Token::UnrepresentableReal`] converts to the signed infinity it
    /// overflowed to, the value it decoded to before #7678. The decoder uses
    /// [`Self::from_token_noting`] instead, to learn that the record held one.
    pub fn from_token(token: &Token) -> Self {
        Self::from_token_noting(token, &mut false)
    }

    /// [`Self::from_token`] that sets `unrepresentable` when any value in the
    /// token is a [`Token::UnrepresentableReal`], so the decoder can apply the
    /// input-admission rule without a second walk (#7678).
    pub(crate) fn from_token_noting(token: &Token, unrepresentable: &mut bool) -> Self {
        match token {
            Token::EntityRef(id) => AttributeValue::EntityRef(*id),
            // The one literal funnel: un-double `''`, THEN decode the
            // backslash escapes (see `decode_step_literal`). The tokenizer
            // hands over the raw inner bytes, and `quick_metadata.rs`-style
            // raw-byte readers never build a Token, so nothing double-collapses
            // (#2323, CORE-16).
            Token::String(s) => AttributeValue::String(
                crate::step_encoding::decode_step_literal_inner(s).into_owned(),
            ),
            Token::Binary(hex) => {
                AttributeValue::Binary(String::from_utf8_lossy(hex).into_owned())
            }
            Token::Integer(i) => AttributeValue::Integer(*i),
            Token::Float(f) => AttributeValue::Float(*f),
            Token::UnrepresentableReal(raw) => {
                *unrepresentable = true;
                let negative = raw.first() == Some(&b'-');
                AttributeValue::Float(if negative { f64::NEG_INFINITY } else { f64::INFINITY })
            }
            Token::Enum(e) => AttributeValue::Enum(String::from_utf8_lossy(e).into_owned()),
            Token::List(items) => {
                AttributeValue::List(
                    items.iter().map(|t| Self::from_token_noting(t, unrepresentable)).collect(),
                )
            }
            Token::TypedValue(type_name, args) => {
                // For typed values like IFCPARAMETERVALUE(0.), extract the inner value
                // Store as a list with the type name first, followed by args
                //
                // The name is a STEP keyword, so its case is not significant
                // (ISO 10303-21). Fold it to the EXPRESS spelling here, once, so
                // every consumer can match uppercase literals and every exporter
                // emits the canonical name (#4707). Still one allocation: an
                // uppercase name is borrowed until `into_owned`.
                let name = String::from_utf8_lossy(type_name);
                let mut values = vec![AttributeValue::String(
                    crate::schema_helpers::normalise_uppercase(&name).into_owned(),
                )];
                values.extend(args.iter().map(|t| Self::from_token_noting(t, unrepresentable)));
                AttributeValue::List(values)
            }
            Token::Null => AttributeValue::Null,
            Token::Derived => AttributeValue::Derived,
        }
    }

    /// Get as entity reference
    #[inline]
    pub fn as_entity_ref(&self) -> Option<u32> {
        match self {
            AttributeValue::EntityRef(id) => Some(*id),
            _ => None,
        }
    }

    /// Get as string
    #[inline]
    pub fn as_string(&self) -> Option<&str> {
        match self {
            AttributeValue::String(s) => Some(s),
            _ => None,
        }
    }

    /// The raw hex of a binary literal (`"0FF"` gives `0FF`), undecoded.
    /// `None` for every other value, a string included.
    #[inline]
    pub fn as_binary_hex(&self) -> Option<&str> {
        match self {
            AttributeValue::Binary(hex) => Some(hex),
            _ => None,
        }
    }

    /// Get as enum value (strips the dots from .ENUM.)
    #[inline]
    pub fn as_enum(&self) -> Option<&str> {
        match self {
            AttributeValue::Enum(s) => Some(s),
            _ => None,
        }
    }

    /// Get as float
    /// Also handles TypedValue wrappers like IFCNORMALISEDRATIOMEASURE(0.5)
    /// which are stored as List([String("typename"), Float(value)])
    #[inline]
    pub fn as_float(&self) -> Option<f64> {
        match self {
            AttributeValue::Float(f) => Some(*f),
            AttributeValue::Integer(i) => Some(*i as f64),
            // Handle TypedValue wrappers (stored as List with type name + value)
            AttributeValue::List(items) if items.len() >= 2 => {
                // Check if first item is a string (type name) and second is numeric
                if matches!(items.first(), Some(AttributeValue::String(_))) {
                    // Try to get the numeric value from the second element
                    match items.get(1) {
                        Some(AttributeValue::Float(f)) => Some(*f),
                        Some(AttributeValue::Integer(i)) => Some(*i as f64),
                        _ => None,
                    }
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Get as integer (more efficient than as_float for indices)
    #[inline]
    pub fn as_int(&self) -> Option<i64> {
        match self {
            AttributeValue::Integer(i) => Some(*i),
            AttributeValue::Float(f) => Some(*f as i64),
            _ => None,
        }
    }

    /// Get as list
    #[inline]
    pub fn as_list(&self) -> Option<&[AttributeValue]> {
        match self {
            AttributeValue::List(items) => Some(items),
            _ => None,
        }
    }

    /// The members of an attribute that holds entity references: a list's
    /// items, or a bare reference as a one-element slice.
    ///
    /// `IfcPropertySetDefinitionSet` is the one defined type in the bundled
    /// schemas that aggregates entities, and it appears only inside
    /// `IfcPropertySetDefinitionSelect` (`IfcRelDefinesByProperties.
    /// RelatingPropertyDefinition`). ISO 10303-21 writes a defined type inside
    /// a SELECT as a typed parameter, `IFCPROPERTYSETDEFINITIONSET((#1,#2))`,
    /// which decodes to `[String(name), List(set)]`; that yields the set.
    /// Exporters also write the set bare, `(#1,#2)`, which is the list case.
    ///
    /// Callers choose their own policy for non-reference members: `get_refs`
    /// skips them, a strict reader can reject them.
    pub fn as_ref_members(&self) -> Option<&[AttributeValue]> {
        match self {
            AttributeValue::EntityRef(_) => Some(std::slice::from_ref(self)),
            AttributeValue::List(items) => match items.as_slice() {
                [AttributeValue::String(name), AttributeValue::List(set)]
                    if name == "IFCPROPERTYSETDEFINITIONSET" =>
                {
                    Some(set)
                }
                _ => Some(items),
            },
            _ => None,
        }
    }

    /// Check if null/derived
    #[inline]
    pub fn is_null(&self) -> bool {
        matches!(self, AttributeValue::Null | AttributeValue::Derived)
    }

    /// Batch parse 3D coordinates from a list of coordinate triples
    /// Returns flattened f32 array: [x0, y0, z0, x1, y1, z1, ...]
    /// Optimized for large coordinate lists
    #[inline]
    pub fn parse_coordinate_list_3d(coord_list: &[AttributeValue]) -> Vec<f32> {
        let mut result = Vec::with_capacity(coord_list.len() * 3);

        for coord_attr in coord_list {
            if let Some(coord) = coord_attr.as_list() {
                // Fast path: extract x, y, z directly
                let x = coord.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let y = coord.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let z = coord.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;

                result.push(x);
                result.push(y);
                result.push(z);
            }
        }

        result
    }

    /// Batch parse 2D coordinates from a list of coordinate pairs
    /// Returns flattened f32 array: [x0, y0, x1, y1, ...]
    #[inline]
    pub fn parse_coordinate_list_2d(coord_list: &[AttributeValue]) -> Vec<f32> {
        let mut result = Vec::with_capacity(coord_list.len() * 2);

        for coord_attr in coord_list {
            if let Some(coord) = coord_attr.as_list() {
                let x = coord.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let y = coord.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;

                result.push(x);
                result.push(y);
            }
        }

        result
    }

    /// This value as a 0-based index under the one IFC index rule, shared
    /// with [`crate::parse_indices_direct`]: an INTEGER in `1..=u32::MAX`.
    /// `None` for `0`, a negative or oversized INTEGER, and any other value,
    /// a REAL included (`IfcPositiveInteger` is an INTEGER; #7689).
    #[inline]
    pub fn as_ifc_index(&self) -> Option<u32> {
        match self {
            AttributeValue::Integer(i) => crate::fast_parse::ifc_index_to_zero_based(*i),
            _ => None,
        }
    }

    /// Batch parse triangle indices from a `CoordIndex` list of index
    /// triples into flat 0-based corners, three per face (#7689).
    ///
    /// A value that fails [`Self::as_ifc_index`] reads as
    /// [`crate::INVALID_INDEX`], and a face that is not a list of exactly
    /// three values reads as three of them, so every face keeps its slot
    /// and none shifts the faces after it. Consumers drop any triangle with
    /// a corner `>= vertex_count`. `parse_indices_direct` reads raw bytes
    /// under the same rule.
    #[inline]
    pub fn parse_index_list(face_list: &[AttributeValue]) -> Vec<u32> {
        let mut result = Vec::with_capacity(face_list.len() * 3);
        for face_attr in face_list {
            match face_attr.as_list() {
                Some([a, b, c]) => result.extend(
                    [a, b, c].map(|v| v.as_ifc_index().unwrap_or(crate::INVALID_INDEX)),
                ),
                _ => result.extend([crate::INVALID_INDEX; 3]),
            }
        }
        result
    }

    /// Batch parse coordinate list with f64 precision
    /// Returns Vec of (x, y, z) tuples
    #[inline]
    pub fn parse_coordinate_list_3d_f64(coord_list: &[AttributeValue]) -> Vec<(f64, f64, f64)> {
        coord_list
            .iter()
            .filter_map(|coord_attr| {
                let coord = coord_attr.as_list()?;
                let x = coord.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coord.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coord.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some((x, y, z))
            })
            .collect()
    }
}

/// Decoded IFC entity. `attributes` is behind an `Arc` so cloning a
/// `DecodedEntity` (the decoder clones on every cache insert AND every cache
/// hit) is a refcount bump, not a deep clone of the attribute tree. Attributes
/// are never mutated after construction, so sharing is sound and byte-identical.
#[derive(Debug, Clone)]
pub struct DecodedEntity {
    pub id: u32,
    pub ifc_type: IfcType,
    pub attributes: std::sync::Arc<Vec<AttributeValue>>,
}

impl DecodedEntity {
    /// Create new decoded entity
    pub fn new(id: u32, ifc_type: IfcType, attributes: Vec<AttributeValue>) -> Self {
        Self {
            id,
            ifc_type,
            attributes: std::sync::Arc::new(attributes),
        }
    }

    /// Get attribute by index
    pub fn get(&self, index: usize) -> Option<&AttributeValue> {
        self.attributes.get(index)
    }

    /// Get entity reference attribute
    pub fn get_ref(&self, index: usize) -> Option<u32> {
        self.get(index).and_then(|v| v.as_entity_ref())
    }

    /// Get string attribute
    pub fn get_string(&self, index: usize) -> Option<&str> {
        self.get(index).and_then(|v| v.as_string())
    }

    /// Get float attribute
    pub fn get_float(&self, index: usize) -> Option<f64> {
        self.get(index).and_then(|v| v.as_float())
    }

    /// Get list attribute
    pub fn get_list(&self, index: usize) -> Option<&[AttributeValue]> {
        self.get(index).and_then(|v| v.as_list())
    }

    /// Get entity references from a list attribute. A bare reference is a
    /// tolerated one-element list, and an `IfcPropertySetDefinitionSet` typed
    /// parameter is its set (see [`AttributeValue::as_ref_members`]);
    /// non-reference list members are skipped.
    pub fn get_refs(&self, index: usize) -> Option<Vec<u32>> {
        let members = self.get(index)?.as_ref_members()?;
        let refs: Vec<u32> = members.iter().filter_map(AttributeValue::as_entity_ref).collect();
        (!refs.is_empty()).then_some(refs)
    }
}

/// IFC schema metadata for dynamic processing
#[derive(Clone)]
pub struct IfcSchema {
    /// Geometry representation types (for routing)
    pub geometry_types: HashMap<IfcType, GeometryCategory>,
    /// Profile types
    pub profile_types: HashMap<IfcType, ProfileCategory>,
}

impl IfcSchema {
    /// Create schema with geometry type mappings
    pub fn new() -> Self {
        let mut geometry_types = HashMap::new();
        let mut profile_types = HashMap::new();

        // Swept solids (P0)
        geometry_types.insert(IfcType::IfcExtrudedAreaSolid, GeometryCategory::SweptSolid);
        geometry_types.insert(IfcType::IfcRevolvedAreaSolid, GeometryCategory::SweptSolid);

        // Boolean operations (P0)
        geometry_types.insert(IfcType::IfcBooleanResult, GeometryCategory::Boolean);
        geometry_types.insert(IfcType::IfcBooleanClippingResult, GeometryCategory::Boolean);

        // Explicit meshes (P0)
        geometry_types.insert(IfcType::IfcFacetedBrep, GeometryCategory::ExplicitMesh);
        geometry_types.insert(
            IfcType::IfcTriangulatedFaceSet,
            GeometryCategory::ExplicitMesh,
        );
        geometry_types.insert(IfcType::IfcPolygonalFaceSet, GeometryCategory::ExplicitMesh);
        geometry_types.insert(IfcType::IfcFaceBasedSurfaceModel, GeometryCategory::Surface);
        geometry_types.insert(
            IfcType::IfcSurfaceOfLinearExtrusion,
            GeometryCategory::Surface,
        );
        geometry_types.insert(
            IfcType::IfcShellBasedSurfaceModel,
            GeometryCategory::Surface,
        );

        // Instancing (P0)
        geometry_types.insert(IfcType::IfcMappedItem, GeometryCategory::MappedItem);

        // Profile types - Parametric
        profile_types.insert(IfcType::IfcRectangleProfileDef, ProfileCategory::Parametric);
        profile_types.insert(
            IfcType::IfcRoundedRectangleProfileDef,
            ProfileCategory::Parametric,
        );
        profile_types.insert(IfcType::IfcCircleProfileDef, ProfileCategory::Parametric);
        profile_types.insert(
            IfcType::IfcCircleHollowProfileDef,
            ProfileCategory::Parametric,
        );
        profile_types.insert(
            IfcType::IfcRectangleHollowProfileDef,
            ProfileCategory::Parametric,
        );
        profile_types.insert(IfcType::IfcIShapeProfileDef, ProfileCategory::Parametric);
        profile_types.insert(
            IfcType::IfcAsymmetricIShapeProfileDef,
            ProfileCategory::Parametric,
        );
        profile_types.insert(IfcType::IfcLShapeProfileDef, ProfileCategory::Parametric);
        profile_types.insert(IfcType::IfcUShapeProfileDef, ProfileCategory::Parametric);
        profile_types.insert(IfcType::IfcTShapeProfileDef, ProfileCategory::Parametric);
        profile_types.insert(IfcType::IfcCShapeProfileDef, ProfileCategory::Parametric);
        profile_types.insert(IfcType::IfcZShapeProfileDef, ProfileCategory::Parametric);

        // Profile types - Arbitrary
        profile_types.insert(
            IfcType::IfcArbitraryClosedProfileDef,
            ProfileCategory::Arbitrary,
        );
        profile_types.insert(
            IfcType::IfcArbitraryProfileDefWithVoids,
            ProfileCategory::Arbitrary,
        );

        // Profile types - Composite
        profile_types.insert(IfcType::IfcCompositeProfileDef, ProfileCategory::Composite);

        Self {
            geometry_types,
            profile_types,
        }
    }

    /// Get geometry category for a type
    pub fn geometry_category(&self, ifc_type: &IfcType) -> Option<GeometryCategory> {
        self.geometry_types.get(ifc_type).copied()
    }

    /// Get profile category for a type
    pub fn profile_category(&self, ifc_type: &IfcType) -> Option<ProfileCategory> {
        self.profile_types.get(ifc_type).copied()
    }

    /// Check if type is a geometry representation
    pub fn is_geometry_type(&self, ifc_type: &IfcType) -> bool {
        self.geometry_types.contains_key(ifc_type)
    }

    /// Check if type is a profile
    pub fn is_profile_type(&self, ifc_type: &IfcType) -> bool {
        self.profile_types.contains_key(ifc_type)
    }
}

impl Default for IfcSchema {
    fn default() -> Self {
        Self::new()
    }
}

// Note: IFC types are now defined as proper enum variants in schema.rs
// This avoids the issue where from_str() would return Unknown(hash) instead of matching the constant.

#[cfg(test)]
#[path = "schema_gen_tests.rs"]
mod tests;
