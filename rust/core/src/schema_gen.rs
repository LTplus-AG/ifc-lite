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
            Token::String(s) => AttributeValue::String(s.to_string()),
            Token::Integer(i) => AttributeValue::Integer(*i),
            Token::Float(f) => AttributeValue::Float(*f),
            Token::Enum(e) => AttributeValue::Enum(e.to_string()),
            Token::List(items) => {
                AttributeValue::List(items.iter().map(Self::from_token).collect())
            }
            Token::TypedValue(type_name, args) => {
                // For typed values like IFCPARAMETERVALUE(0.), extract the inner value
                // Store as a list with the type name first, followed by args
                let mut values = vec![AttributeValue::String(type_name.to_string())];
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

        for face_attr in face_list {
            if let Some(face) = face_attr.as_list() {
                // Use as_int for faster parsing, convert from 1-based to 0-based
                let i0 = (face.first().and_then(|v| v.as_int()).unwrap_or(1) - 1) as u32;
                let i1 = (face.get(1).and_then(|v| v.as_int()).unwrap_or(1) - 1) as u32;
                let i2 = (face.get(2).and_then(|v| v.as_int()).unwrap_or(1) - 1) as u32;

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

/// Decoded IFC entity with attributes
#[derive(Debug, Clone)]
pub struct DecodedEntity {
    pub id: u32,
    pub ifc_type: IfcType,
    pub attributes: Vec<AttributeValue>,
}

impl DecodedEntity {
    /// Create new decoded entity
    pub fn new(id: u32, ifc_type: IfcType, attributes: Vec<AttributeValue>) -> Self {
        Self {
            id,
            ifc_type,
            attributes,
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
mod tests {
    use super::*;

    #[test]
    fn test_schema_geometry_categories() {
        let schema = IfcSchema::new();

        assert_eq!(
            schema.geometry_category(&IfcType::IfcExtrudedAreaSolid),
            Some(GeometryCategory::SweptSolid)
        );

        assert_eq!(
            schema.geometry_category(&IfcType::IfcBooleanResult),
            Some(GeometryCategory::Boolean)
        );

        assert_eq!(
            schema.geometry_category(&IfcType::IfcTriangulatedFaceSet),
            Some(GeometryCategory::ExplicitMesh)
        );
    }

    #[test]
    fn test_attribute_value_conversion() {
        let token = Token::EntityRef(123);
        let attr = AttributeValue::from_token(&token);
        assert_eq!(attr.as_entity_ref(), Some(123));

        let token = Token::String("test");
        let attr = AttributeValue::from_token(&token);
        assert_eq!(attr.as_string(), Some("test"));
    }

    #[test]
    fn test_decoded_entity() {
        let entity = DecodedEntity::new(
            1,
            IfcType::IfcWall,
            vec![
                AttributeValue::EntityRef(2),
                AttributeValue::String("Wall-001".to_string()),
                AttributeValue::Float(3.5),
            ],
        );

        assert_eq!(entity.get_ref(0), Some(2));
        assert_eq!(entity.get_string(1), Some("Wall-001"));
        assert_eq!(entity.get_float(2), Some(3.5));
    }

    #[test]
    fn test_as_float_with_typed_value() {
        // Test plain float
        let plain_float = AttributeValue::Float(0.5);
        assert_eq!(plain_float.as_float(), Some(0.5));

        // Test integer to float conversion
        let integer = AttributeValue::Integer(42);
        assert_eq!(integer.as_float(), Some(42.0));

        // Test TypedValue wrapper like IFCNORMALISEDRATIOMEASURE(0.5)
        // This is stored as List([String("IFCNORMALISEDRATIOMEASURE"), Float(0.5)])
        let typed_value = AttributeValue::List(vec![
            AttributeValue::String("IFCNORMALISEDRATIOMEASURE".to_string()),
            AttributeValue::Float(0.5),
        ]);
        assert_eq!(typed_value.as_float(), Some(0.5));

        // Test TypedValue with integer
        let typed_int = AttributeValue::List(vec![
            AttributeValue::String("IFCINTEGER".to_string()),
            AttributeValue::Integer(100),
        ]);
        assert_eq!(typed_int.as_float(), Some(100.0));

        // Test that non-typed lists return None
        let regular_list =
            AttributeValue::List(vec![AttributeValue::Float(1.0), AttributeValue::Float(2.0)]);
        assert_eq!(regular_list.as_float(), None);

        // Test that empty list returns None
        let empty_list = AttributeValue::List(vec![]);
        assert_eq!(empty_list.as_float(), None);
    }
}
