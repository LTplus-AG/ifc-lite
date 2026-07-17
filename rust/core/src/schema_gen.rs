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
    pub fn from_token(token: &Token) -> Self {
        match token {
            Token::EntityRef(id) => AttributeValue::EntityRef(*id),
            Token::String(s) => {
                // Decode STEP escapes (\X2\, \X4\, \X\, \S\, \P\) so every
                // consumer of a string attribute sees native UTF-8, matching
                // the TS decodeIfcString. No-escape strings stay zero-cost.
                let raw = String::from_utf8_lossy(s);
                AttributeValue::String(crate::step_encoding::decode_ifc_string(&raw).into_owned())
            }
            Token::Integer(i) => AttributeValue::Integer(*i),
            Token::Float(f) => AttributeValue::Float(*f),
            Token::Enum(e) => AttributeValue::Enum(String::from_utf8_lossy(e).into_owned()),
            Token::List(items) => {
                AttributeValue::List(items.iter().map(Self::from_token).collect())
            }
            Token::TypedValue(type_name, args) => {
                // For typed values like IFCPARAMETERVALUE(0.), extract the inner value
                // Store as a list with the type name first, followed by args
                let mut values = vec![AttributeValue::String(
                    String::from_utf8_lossy(type_name).into_owned(),
                )];
                values.extend(args.iter().map(Self::from_token));
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

    /// Batch parse triangle indices from a list of index triples
    /// Converts from 1-based IFC indices to 0-based indices
    /// Returns flattened u32 array: [i0, i1, i2, ...]
    #[inline]
    pub fn parse_index_list(face_list: &[AttributeValue]) -> Vec<u32> {
        let mut result = Vec::with_capacity(face_list.len() * 3);

        // Convert a 1-based i64 IFC index to a 0-based u32. Anything outside the
        // valid u32 vertex range — non-positive, or beyond u32::MAX — maps to
        // u32::MAX, an out-of-range sentinel the downstream bounds check drops,
        // instead of an `(i64 - 1) as u32` truncation/wrap to a valid-looking
        // (wrong) vertex. NOTE: this sentinel is u32::MAX while fast_parse's
        // saturating path yields u32::MAX - 1 — consumers must bounds-check
        // (i >= vertex_count), never compare against a single sentinel value.
        let to_zero_based = |i: i64| -> u32 {
            i.checked_sub(1)
                .and_then(|z| u32::try_from(z).ok())
                .unwrap_or(u32::MAX)
        };

        for face_attr in face_list {
            if let Some(face) = face_attr.as_list() {
                // Use as_int for faster parsing, convert from 1-based to 0-based
                let i0 = to_zero_based(face.first().and_then(|v| v.as_int()).unwrap_or(1));
                let i1 = to_zero_based(face.get(1).and_then(|v| v.as_int()).unwrap_or(1));
                let i2 = to_zero_based(face.get(2).and_then(|v| v.as_int()).unwrap_or(1));

                result.push(i0);
                result.push(i1);
                result.push(i2);
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

    /// Check if type has geometry
    pub fn has_geometry(&self, ifc_type: &IfcType) -> bool {
        // Building elements, furnishing, etc.
        let name = ifc_type.name();
        (matches!(
            ifc_type,
            IfcType::IfcWall
                | IfcType::IfcWallStandardCase
                | IfcType::IfcSlab
                | IfcType::IfcBeam
                | IfcType::IfcColumn
                | IfcType::IfcRoof
                | IfcType::IfcStair
                | IfcType::IfcRamp
                | IfcType::IfcRailing
                | IfcType::IfcPlate
                | IfcType::IfcMember
                | IfcType::IfcFooting
                | IfcType::IfcPile
                | IfcType::IfcCovering
                | IfcType::IfcCurtainWall
                | IfcType::IfcDoor
                | IfcType::IfcWindow
                | IfcType::IfcChimney
                | IfcType::IfcShadingDevice
                | IfcType::IfcBuildingElementProxy
                | IfcType::IfcBuildingElementPart
        ) || name.contains("Reinforc"))
            || matches!(
                ifc_type,
                IfcType::IfcFurnishingElement
                | IfcType::IfcFurniture
                | IfcType::IfcDuctSegment
                | IfcType::IfcPipeSegment
                | IfcType::IfcCableSegment
                | IfcType::IfcProduct // Base type for all products
                | IfcType::IfcDistributionElement
                | IfcType::IfcFlowSegment
                | IfcType::IfcFlowFitting
                | IfcType::IfcFlowTerminal
            )
            // Spatial elements with geometry (for visibility toggling)
            || matches!(
                ifc_type,
                IfcType::IfcSpace
                | IfcType::IfcOpeningElement
                | IfcType::IfcSite
            )
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
