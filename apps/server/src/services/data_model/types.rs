// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Data model DTO structs shared by the extractor submodules.

use serde::{Deserialize, Serialize};

/// Complete data model extracted from IFC file.
#[derive(Debug, Clone)]
pub struct DataModel {
    /// Entity metadata for all entities.
    pub entities: Vec<EntityMetadata>,
    /// Property sets (pset_id -> PropertySet).
    pub property_sets: Vec<PropertySet>,
    /// Quantity sets (qset_id -> QuantitySet).
    pub quantity_sets: Vec<QuantitySet>,
    /// Relationships (type, relating, related[]).
    pub relationships: Vec<Relationship>,
    /// Classification references associated with elements
    /// (`IfcRelAssociatesClassification`).
    pub classifications: Vec<ClassificationAssociation>,
    /// Materials / material layers associated with elements
    /// (`IfcRelAssociatesMaterial`).
    pub materials: Vec<MaterialAssociation>,
    /// Documents associated with elements (`IfcRelAssociatesDocument`).
    pub documents: Vec<DocumentAssociation>,
    /// Spatial hierarchy data with nodes and lookup maps.
    pub spatial_hierarchy: SpatialHierarchyData,
}

/// Metadata for a single IFC entity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityMetadata {
    /// IFC entity ID.
    pub entity_id: u32,
    /// IFC type name (e.g., "IfcWall").
    pub type_name: String,
    /// GlobalId attribute (if present).
    pub global_id: Option<String>,
    /// Name attribute (if present).
    pub name: Option<String>,
    /// Whether entity has geometry.
    pub has_geometry: bool,
}

/// Property set with its properties.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertySet {
    /// PropertySet entity ID.
    pub pset_id: u32,
    /// PropertySet name.
    pub pset_name: String,
    /// Properties in this set (property_name -> value).
    pub properties: Vec<Property>,
}

/// Single property value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Property {
    /// Property name.
    pub property_name: String,
    /// Resolved property value in its canonical string form (a decoded string,
    /// `"true"`/`"false"`, or a number rendered as text — NOT JSON-quoted). The
    /// client re-materialises the native value using `property_type`.
    pub property_value: String,
    /// Value KIND: `"string"` | `"boolean"` | `"logical"` | `"integer"` |
    /// `"real"` | `"null"`. Mirrors the WASM path's `parsePropertyValue` so the
    /// client can reconstruct the same `PropertyValueType` and JS value.
    pub property_type: String,
    /// Raw IFC measure/value type tag (e.g. `"IFCLENGTHMEASURE"`, `"IFCLABEL"`),
    /// when the STEP value was a typed wrapper. Drives display-unit conversion
    /// (issue #1573) — the client maps it onto the property entry's `dataType`.
    /// `None` for untyped values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>,
}

/// Quantity set (IfcElementQuantity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantitySet {
    /// QuantitySet entity ID.
    pub qset_id: u32,
    /// QuantitySet name.
    pub qset_name: String,
    /// Method of measurement (optional).
    pub method_of_measurement: Option<String>,
    /// Quantities in this set.
    pub quantities: Vec<Quantity>,
}

/// Single quantity value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quantity {
    /// Quantity name.
    pub quantity_name: String,
    /// Quantity numeric value.
    pub quantity_value: f64,
    /// Quantity type (length, area, volume, count, weight, time).
    pub quantity_type: String,
}

/// Relationship between entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relationship {
    /// Relationship type (e.g., "IfcRelDefinesByProperties").
    pub rel_type: String,
    /// Relating entity ID.
    pub relating_id: u32,
    /// Related entity ID (one Relationship per related entity).
    pub related_id: u32,
}

/// A classification reference associated with one element, flattened from
/// `IfcRelAssociatesClassification` → `IfcClassificationReference`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationAssociation {
    /// Element the classification is assigned to.
    pub element_id: u32,
    /// Classification system name (`IfcClassification.Name`), resolved by
    /// walking `ReferencedSource`. `None` when not resolvable.
    pub system_name: Option<String>,
    /// Code / `IfcClassificationReference.Identification`
    /// (`ItemReference` in IFC2x3).
    pub identification: Option<String>,
    /// Human-readable reference name (`IfcClassificationReference.Name`).
    pub name: Option<String>,
    /// Location / URI of the reference.
    pub location: Option<String>,
}

/// A material (or one material layer) associated with an element, flattened
/// from `IfcRelAssociatesMaterial`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialAssociation {
    /// Element the material is assigned to.
    pub element_id: u32,
    /// Layer-set name (`IfcMaterialLayerSet.LayerSetName`); `None` for a single
    /// material, list, or constituent set.
    pub set_name: Option<String>,
    /// 0-based index of this layer within its set (0 for a single material).
    pub layer_index: u32,
    /// Material name (`IfcMaterial.Name`).
    pub material_name: String,
    /// Layer thickness in **metres** (already unit-scaled). `None` for
    /// non-layered materials.
    pub thickness: Option<f64>,
    /// `IfcMaterialLayer.IsVentilated` (`None` when unknown / not a layer).
    pub is_ventilated: Option<bool>,
    /// Material/layer category (`IfcMaterialLayer.Category` / `IfcMaterial.Category`).
    pub category: Option<String>,
}

/// A document associated with an element, flattened from
/// `IfcRelAssociatesDocument` → `IfcDocumentReference` / `IfcDocumentInformation`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentAssociation {
    /// Element the document is assigned to.
    pub element_id: u32,
    /// `Identification` (`ItemReference`/`DocumentId` in older schemas).
    pub identification: Option<String>,
    /// Document name.
    pub name: Option<String>,
    /// Location / URI.
    pub location: Option<String>,
    /// Description.
    pub description: Option<String>,
}

/// Spatial hierarchy node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpatialNode {
    /// Entity ID.
    pub entity_id: u32,
    /// Parent entity ID (0 for root).
    pub parent_id: u32,
    /// Hierarchy depth (0 for root).
    pub level: u16,
    /// Path from root (e.g., "Project/Site/Building").
    pub path: String,
    /// IFC type name (e.g., "IFCPROJECT", "IFCBUILDINGSTOREY").
    pub type_name: String,
    /// Entity name (if present).
    pub name: Option<String>,
    /// Elevation for IFCBUILDINGSTOREY entities.
    pub elevation: Option<f64>,
    /// Direct child spatial nodes (spatial containment).
    pub children_ids: Vec<u32>,
    /// Contained elements (non-spatial entities like walls, doors, etc.).
    pub element_ids: Vec<u32>,
}

/// Spatial hierarchy data with lookup maps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpatialHierarchyData {
    /// All spatial nodes.
    pub nodes: Vec<SpatialNode>,
    /// Project entity ID (root).
    pub project_id: u32,
    /// Element to storey mapping (element_id -> storey_id).
    pub element_to_storey: Vec<(u32, u32)>,
    /// Element to building mapping (element_id -> building_id).
    pub element_to_building: Vec<(u32, u32)>,
    /// Element to site mapping (element_id -> site_id).
    pub element_to_site: Vec<(u32, u32)>,
    /// Element to space mapping (element_id -> space_id).
    pub element_to_space: Vec<(u32, u32)>,
}

/// Job for processing an entity during data extraction.
pub(crate) struct EntityJob {
    pub(crate) id: u32,
    pub(crate) type_name: String,
    pub(crate) start: usize,
    pub(crate) end: usize,
}
