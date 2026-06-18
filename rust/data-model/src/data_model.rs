// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Data model extraction service - extracts properties, relationships, and spatial hierarchy.

use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, DecodedEntity, EntityDecoder, EntityScanner,
};
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
    /// Property value (JSON-encoded).
    pub property_value: String,
    /// Property value type.
    pub property_type: String,
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
struct EntityJob {
    id: u32,
    type_name: String,
    start: usize,
    end: usize,
}

/// Extract complete data model from IFC content.
pub fn extract_data_model<T>(content: &T) -> DataModel
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    let extract_start = std::time::Instant::now();
    tracing::info!(
        content_size = content.len(),
        "Starting data model extraction"
    );

    // Build entity index (shared across all extractors)
    let entity_index = Arc::new(build_entity_index(content));

    // Scan all entities once
    let mut scanner = EntityScanner::new(content);
    let mut all_entities: Vec<EntityJob> = Vec::new();
    let mut total_entities = 0usize;

    let mut last_id = 0u32;
    let mut last_type = String::new();
    let mut max_id = 0u32;
    let mut last_end = 0usize;
    let content_len = content.len();

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        total_entities += 1;
        last_id = id;
        last_type = type_name.to_string();
        last_end = end;
        if id > max_id {
            max_id = id;
        }
        all_entities.push(EntityJob {
            id,
            type_name: type_name.to_string(),
            start,
            end,
        });
    }

    let remaining_bytes = content_len.saturating_sub(last_end);
    tracing::debug!(
        total_entities = total_entities,
        last_id = last_id,
        max_id = max_id,
        last_type = %last_type,
        last_end = last_end,
        content_len = content_len,
        remaining_bytes = remaining_bytes,
        "Scanned all entities"
    );

    // Debug: log sample entity types to diagnose issues
    if tracing::enabled!(tracing::Level::DEBUG) {
        let sample_types: Vec<&str> = all_entities
            .iter()
            .take(20)
            .map(|j| j.type_name.as_str())
            .collect();
        tracing::debug!(?sample_types, "Sample entity types from scan");

        // Check if any type contains "PROPERTY" or "REL" (case-insensitive)
        let has_property_like = all_entities
            .iter()
            .any(|j| j.type_name.to_uppercase().contains("PROPERTY"));
        let has_rel_like = all_entities
            .iter()
            .any(|j| j.type_name.to_uppercase().starts_with("IFCREL"));
        tracing::debug!(
            has_property_like = has_property_like,
            has_rel_like = has_rel_like,
            "Entity type pattern check"
        );

        // Debug: count property sets and relationships in scanned entities
        let pset_count = all_entities
            .iter()
            .filter(|j| j.type_name.to_uppercase() == "IFCPROPERTYSET")
            .count();
        let rel_count = all_entities
            .iter()
            .filter(|j| {
                let t = j.type_name.to_uppercase();
                t == "IFCRELDEFINESBYPROPERTIES"
                    || t == "IFCRELAGGREGATES"
                    || t == "IFCRELCONTAINEDINSPATIALSTRUCTURE"
            })
            .count();
        tracing::debug!(
            pset_count = pset_count,
            rel_count = rel_count,
            "Entity type counts before extraction"
        );
    }

    // Parallel extraction using rayon::join
    let content_arc = Arc::new(content.to_vec());
    let (entities, ((property_sets, quantity_sets), relationships)) = rayon::join(
        || extract_entity_metadata(&all_entities, &content_arc, &entity_index),
        || {
            rayon::join(
                || {
                    rayon::join(
                        || extract_properties(&all_entities, &content_arc, &entity_index),
                        || extract_quantities(&all_entities, &content_arc, &entity_index),
                    )
                },
                || extract_relationships(&all_entities, &content_arc, &entity_index),
            )
        },
    );

    // Extract length unit scale (e.g., 0.001 for millimeters)
    let mut unit_decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let project_id_for_units = entities
        .iter()
        .find(|e| e.type_name.to_uppercase() == "IFCPROJECT")
        .map(|e| e.entity_id)
        .unwrap_or(0);
    let length_unit_scale = if project_id_for_units > 0 {
        extract_length_unit_scale(&mut unit_decoder, project_id_for_units).unwrap_or(1.0)
    } else {
        1.0
    };
    tracing::debug!(
        length_unit_scale = length_unit_scale,
        "Extracted length unit scale"
    );

    // Extract classifications, materials, and documents in parallel. These
    // follow the same `IfcRelAssociates*` pattern as the relationship pass but
    // resolve the referenced object (classification reference, material layer
    // set, document) into a flat, element-keyed shape (issue #900 parity).
    // Materials need the length-unit scale to report layer thickness in metres.
    let ((classifications, materials), documents) = rayon::join(
        || {
            rayon::join(
                || extract_classifications(&all_entities, &content_arc, &entity_index),
                || {
                    extract_materials(
                        &all_entities,
                        &content_arc,
                        &entity_index,
                        length_unit_scale,
                    )
                },
            )
        },
        || extract_documents(&all_entities, &content_arc, &entity_index),
    );

    // Build spatial hierarchy (depends on relationships and entities)
    let spatial_hierarchy = build_spatial_hierarchy(
        &relationships,
        &entities,
        content,
        &entity_index,
        length_unit_scale,
    );

    let extract_time = extract_start.elapsed();
    tracing::info!(
        entities = entities.len(),
        property_sets = property_sets.len(),
        quantity_sets = quantity_sets.len(),
        relationships = relationships.len(),
        classifications = classifications.len(),
        materials = materials.len(),
        documents = documents.len(),
        spatial_nodes = spatial_hierarchy.nodes.len(),
        extract_time_ms = extract_time.as_millis(),
        "Data model extraction complete"
    );

    DataModel {
        entities,
        property_sets,
        quantity_sets,
        relationships,
        classifications,
        materials,
        documents,
        spatial_hierarchy,
    }
}

/// Extract entity metadata for all entities.
fn extract_entity_metadata(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<EntityMetadata> {
    jobs.par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            let global_id = entity.get_string(0).map(|s| s.to_string());
            let name = entity.get_string(2).map(|s| s.to_string());
            let has_geometry = ifc_lite_core::has_geometry_by_name(&job.type_name);

            Some(EntityMetadata {
                entity_id: job.id,
                type_name: job.type_name.clone(),
                global_id,
                name,
                has_geometry,
            })
        })
        .collect()
}

/// Extract all property sets and their properties.
fn extract_properties(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<PropertySet> {
    // First, collect all PropertySet entities
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let pset_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.type_name.eq_ignore_ascii_case("IFCPROPERTYSET"))
        .collect();

    tracing::debug!(count = pset_jobs.len(), "Extracting property sets");

    pset_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            // IfcPropertySet: [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=HasProperties
            let pset_name = entity.get_string(2)?.to_string();
            let has_properties = entity.get_list(4)?;

            let mut properties = Vec::new();

            // Extract properties from HasProperties list
            for prop_ref in has_properties.iter() {
                if let Some(prop_id) = prop_ref.as_entity_ref() {
                    if let Ok(prop_entity) = local_decoder.decode_by_id(prop_id) {
                        if let Some(prop) = extract_property(&prop_entity, &mut local_decoder) {
                            properties.push(prop);
                        }
                    }
                }
            }

            if properties.is_empty() {
                return None;
            }

            Some(PropertySet {
                pset_id: job.id,
                pset_name,
                properties,
            })
        })
        .collect()
}

/// Extract a single property from IfcProperty entity.
fn extract_property(entity: &DecodedEntity, _decoder: &mut EntityDecoder) -> Option<Property> {
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let ifc_type = entity.ifc_type.as_str();

    // IfcPropertySingleValue: [0]=Name, [1]=Description, [2]=NominalValue, [3]=Unit
    if ifc_type.eq_ignore_ascii_case("IFCPROPERTYSINGLEVALUE") {
        let property_name = entity.get_string(0)?.to_string();
        let nominal_value = entity.get(2)?;

        // Extract value based on type
        let (property_value, property_type) = if let Some(s) = nominal_value.as_string() {
            (format!("\"{}\"", s), "string".to_string())
        } else if let Some(f) = nominal_value.as_float() {
            (f.to_string(), "number".to_string())
        } else if let Some(i) = nominal_value.as_int() {
            (i.to_string(), "integer".to_string())
        } else {
            // Fallback: serialize as string representation
            (format!("{:?}", nominal_value), "unknown".to_string())
        };

        Some(Property {
            property_name,
            property_value,
            property_type,
        })
    } else {
        None
    }
}

/// Extract all quantity sets (IfcElementQuantity) and their quantities.
fn extract_quantities(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<QuantitySet> {
    // First, collect all IfcElementQuantity entities
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let qset_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.type_name.eq_ignore_ascii_case("IFCELEMENTQUANTITY"))
        .collect();

    tracing::debug!(count = qset_jobs.len(), "Extracting quantity sets");

    qset_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            // IfcElementQuantity: [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=MethodOfMeasurement, [5]=Quantities
            let qset_name = entity.get_string(2)?.to_string();
            let method_of_measurement = entity.get_string(4).map(|s| s.to_string());
            let has_quantities = entity.get_list(5)?;

            let mut quantities = Vec::new();

            // Extract quantities from Quantities list
            for quant_ref in has_quantities.iter() {
                if let Some(quant_id) = quant_ref.as_entity_ref() {
                    if let Ok(quant_entity) = local_decoder.decode_by_id(quant_id) {
                        if let Some(quant) = extract_quantity_value(&quant_entity) {
                            quantities.push(quant);
                        }
                    }
                }
            }

            if quantities.is_empty() {
                return None;
            }

            Some(QuantitySet {
                qset_id: job.id,
                qset_name,
                method_of_measurement,
                quantities,
            })
        })
        .collect()
}

/// Extract a single quantity value from IfcPhysicalQuantity entity.
/// Supports: IfcQuantityLength, IfcQuantityArea, IfcQuantityVolume,
///           IfcQuantityCount, IfcQuantityWeight, IfcQuantityTime
fn extract_quantity_value(entity: &DecodedEntity) -> Option<Quantity> {
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let ifc_type = entity.ifc_type.as_str();

    // Map IFC type to quantity type string
    let quantity_type = if ifc_type.eq_ignore_ascii_case("IFCQUANTITYLENGTH") {
        "length"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYAREA") {
        "area"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYVOLUME") {
        "volume"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYCOUNT") {
        "count"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYWEIGHT") {
        "weight"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYTIME") {
        "time"
    } else {
        return None; // Not a recognized quantity type
    };

    // All IFC quantity types have:
    // [0]=Name, [1]=Description, [2]=Unit, [3]=*Value, [4]=Formula (optional, IFC4)
    let quantity_name = entity.get_string(0)?.to_string();

    // Value is at index 3 for all quantity types
    let quantity_value = entity.get_float(3)?;

    Some(Quantity {
        quantity_name,
        quantity_value,
        quantity_type: quantity_type.to_string(),
    })
}

/// Extract all relationships.
fn extract_relationships(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<Relationship> {
    // Filter for relationship entities
    let rel_types = [
        "IFCRELCONTAINEDINSPATIALSTRUCTURE",
        "IFCRELAGGREGATES",
        "IFCRELDEFINESBYPROPERTIES",
        "IFCRELDEFINESBYTYPE",
        "IFCRELASSOCIATESMATERIAL",
        "IFCRELASSOCIATESCLASSIFICATION",
        "IFCRELASSOCIATESDOCUMENT",
        "IFCRELVOIDSELEMENT",
        "IFCRELFILLSELEMENT",
    ];

    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            let type_upper = job.type_name.to_uppercase();
            rel_types.iter().any(|&rt| type_upper == rt)
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting relationships");

    rel_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            extract_relationship(&entity, &job.type_name)
        })
        .flatten()
        .collect()
}

/// Extract relationship from entity (may return multiple if related[] has multiple items).
fn extract_relationship(entity: &DecodedEntity, type_name: &str) -> Option<Vec<Relationship>> {
    let type_upper = type_name.to_uppercase();

    let (relating_idx, related_idx) = match type_upper.as_str() {
        "IFCRELDEFINESBYPROPERTIES" => (5, 4), // RelatingPropertyDefinition at 5, RelatedObjects at 4
        "IFCRELCONTAINEDINSPATIALSTRUCTURE" => (5, 4), // RelatingStructure at 5, RelatedElements at 4
        // IfcRelAssociates* family: RelatingX (Material/Classification/Document)
        // is the single ref at attribute 5; RelatedObjects is the list at 4.
        "IFCRELASSOCIATESMATERIAL"
        | "IFCRELASSOCIATESCLASSIFICATION"
        | "IFCRELASSOCIATESDOCUMENT" => (5, 4),
        _ => (4, 5), // Standard: RelatingObject at 4, RelatedObjects at 5
    };

    let relating_id = entity.get_ref(relating_idx)?;
    let related_list = entity.get_list(related_idx)?;

    let related_ids: Vec<u32> = related_list
        .iter()
        .filter_map(|v| v.as_entity_ref())
        .collect();

    if related_ids.is_empty() {
        return None;
    }

    Some(
        related_ids
            .into_iter()
            .map(|related_id| Relationship {
                rel_type: type_name.to_string(),
                relating_id,
                related_id,
            })
            .collect(),
    )
}

/// Read an `IfcLogical` / `IfcBoolean` attribute as a tri-state `Option<bool>`
/// (`.U.` / absent → `None`).
fn read_logical(entity: &DecodedEntity, index: usize) -> Option<bool> {
    let token = entity.get(index)?.as_enum()?;
    match token {
        "T" | "TRUE" | "true" => Some(true),
        "F" | "FALSE" | "false" => Some(false),
        _ => None,
    }
}

/// Collect the `RelatedObjects` (attribute 4) entity ids of an `IfcRelAssociates*`.
fn related_object_ids(rel: &DecodedEntity) -> Vec<u32> {
    rel.get_list(4)
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}

/// Resolve an `IfcClassificationReference` / `IfcClassification` into
/// `(identification, name, location, system_name)`. Walks `ReferencedSource`
/// up to the owning `IfcClassification` (bounded to avoid cycles).
fn resolve_classification(
    decoder: &mut EntityDecoder,
    id: u32,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return (None, None, None, None);
    };

    if entity
        .ifc_type
        .as_str()
        .eq_ignore_ascii_case("IFCCLASSIFICATION")
    {
        // Directly an IfcClassification: Name is attribute 3.
        return (
            None,
            None,
            None,
            entity.get_string(3).map(|s| s.to_string()),
        );
    }

    // IfcClassificationReference: Location(0), Identification(1), Name(2),
    // ReferencedSource(3).
    let location = entity.get_string(0).map(|s| s.to_string());
    let identification = entity.get_string(1).map(|s| s.to_string());
    let name = entity.get_string(2).map(|s| s.to_string());

    // Walk ReferencedSource up to the IfcClassification for the system name.
    let mut system_name = None;
    let mut source = entity.get_ref(3);
    let mut depth = 0;
    while let Some(src_id) = source {
        if depth >= 8 {
            break;
        }
        depth += 1;
        let Ok(src) = decoder.decode_by_id(src_id) else {
            break;
        };
        if src
            .ifc_type
            .as_str()
            .eq_ignore_ascii_case("IFCCLASSIFICATION")
        {
            system_name = src.get_string(3).map(|s| s.to_string());
            break;
        }
        // Another IfcClassificationReference — keep walking its ReferencedSource.
        source = src.get_ref(3);
    }

    (identification, name, location, system_name)
}

/// Extract classification associations (`IfcRelAssociatesClassification`).
fn extract_classifications(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<ClassificationAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESCLASSIFICATION")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting classifications");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = related_object_ids(&rel);
            // RelatingClassification is attribute 5.
            let Some(class_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let (identification, name, location, system_name) =
                resolve_classification(&mut decoder, class_id);

            related
                .into_iter()
                .map(|element_id| ClassificationAssociation {
                    element_id,
                    system_name: system_name.clone(),
                    identification: identification.clone(),
                    name: name.clone(),
                    location: location.clone(),
                })
                .collect()
        })
        .collect()
}

/// One resolved material layer (intermediate, before element fan-out).
struct ResolvedLayer {
    set_name: Option<String>,
    layer_index: u32,
    material_name: String,
    thickness: Option<f64>,
    is_ventilated: Option<bool>,
    category: Option<String>,
}

/// Resolve an `IfcMaterialLayer`'s referenced `IfcMaterial` name.
fn material_name_of(decoder: &mut EntityDecoder, material_id: u32) -> Option<String> {
    let mat = decoder.decode_by_id(material_id).ok()?;
    // IfcMaterial.Name is attribute 0.
    mat.get_string(0).map(|s| s.to_string())
}

/// Resolve a `RelatingMaterial` into a flat list of layers. Handles
/// `IfcMaterial`, `IfcMaterialLayerSet`, `IfcMaterialLayerSetUsage` (→ set),
/// `IfcMaterialList`, and `IfcMaterialConstituentSet`. `unit_scale` converts
/// layer thickness to metres.
fn resolve_material(decoder: &mut EntityDecoder, id: u32, unit_scale: f64) -> Vec<ResolvedLayer> {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return Vec::new();
    };
    let ty = entity.ifc_type.as_str().to_ascii_uppercase();

    match ty.as_str() {
        "IFCMATERIAL" => entity
            .get_string(0)
            .map(|name| {
                vec![ResolvedLayer {
                    set_name: None,
                    layer_index: 0,
                    material_name: name.to_string(),
                    thickness: None,
                    is_ventilated: None,
                    category: entity.get_string(2).map(|s| s.to_string()),
                }]
            })
            .unwrap_or_default(),
        "IFCMATERIALLAYERSETUSAGE" => {
            // ForLayerSet is attribute 0.
            match entity.get_ref(0) {
                Some(set_id) => resolve_material(decoder, set_id, unit_scale),
                None => Vec::new(),
            }
        }
        "IFCMATERIALLAYERSET" => {
            let set_name = entity.get_string(1).map(|s| s.to_string());
            let layer_ids: Vec<u32> = entity
                .get_list(0)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            layer_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, layer_id)| {
                    let layer = decoder.decode_by_id(layer_id).ok()?;
                    // IfcMaterialLayer: Material(0), LayerThickness(1),
                    // IsVentilated(2), Name(3), Description(4), Category(5).
                    let material_name = layer
                        .get_ref(0)
                        .and_then(|mid| material_name_of(decoder, mid))
                        .unwrap_or_else(|| "Unnamed".to_string());
                    let thickness = layer.get_float(1).map(|t| t * unit_scale);
                    let is_ventilated = read_logical(&layer, 2);
                    let category = layer.get_string(5).map(|s| s.to_string());
                    Some(ResolvedLayer {
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        thickness,
                        is_ventilated,
                        category,
                    })
                })
                .collect()
        }
        "IFCMATERIALLIST" => {
            let mat_ids: Vec<u32> = entity
                .get_list(0)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            mat_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, mid)| {
                    let material_name = material_name_of(decoder, mid)?;
                    Some(ResolvedLayer {
                        set_name: None,
                        layer_index: i as u32,
                        material_name,
                        thickness: None,
                        is_ventilated: None,
                        category: None,
                    })
                })
                .collect()
        }
        "IFCMATERIALCONSTITUENTSET" => {
            // IfcMaterialConstituentSet: Name(0), Description(1),
            // MaterialConstituents(2). Each IfcMaterialConstituent has
            // Name(0), Description(1), Material(2), Fraction(3), Category(4).
            let set_name = entity.get_string(0).map(|s| s.to_string());
            let constituent_ids: Vec<u32> = entity
                .get_list(2)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            constituent_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, cid)| {
                    let constituent = decoder.decode_by_id(cid).ok()?;
                    let material_name = constituent
                        .get_ref(2)
                        .and_then(|mid| material_name_of(decoder, mid))
                        .or_else(|| constituent.get_string(0).map(|s| s.to_string()))?;
                    Some(ResolvedLayer {
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        thickness: None,
                        is_ventilated: None,
                        category: constituent.get_string(4).map(|s| s.to_string()),
                    })
                })
                .collect()
        }
        "IFCMATERIALPROFILESETUSAGE" => {
            // ForProfileSet is attribute 0.
            match entity.get_ref(0) {
                Some(set_id) => resolve_material(decoder, set_id, unit_scale),
                None => Vec::new(),
            }
        }
        "IFCMATERIALPROFILESET" => {
            // IfcMaterialProfileSet: Name(0), Description(1), MaterialProfiles(2).
            // Each IfcMaterialProfile: Name(0), Description(1), Material(2),
            // Profile(3), Priority(4), Category(5). Profiles carry no layer
            // thickness, so thickness stays `None`.
            let set_name = entity.get_string(0).map(|s| s.to_string());
            let profile_ids: Vec<u32> = entity
                .get_list(2)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            profile_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, pid)| {
                    let profile = decoder.decode_by_id(pid).ok()?;
                    let material_name = profile
                        .get_ref(2)
                        .and_then(|mid| material_name_of(decoder, mid))
                        .or_else(|| profile.get_string(0).map(|s| s.to_string()))?;
                    Some(ResolvedLayer {
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        thickness: None,
                        is_ventilated: None,
                        category: profile.get_string(5).map(|s| s.to_string()),
                    })
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Extract material associations (`IfcRelAssociatesMaterial`).
fn extract_materials(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
    unit_scale: f64,
) -> Vec<MaterialAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESMATERIAL")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting materials");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = related_object_ids(&rel);
            // RelatingMaterial is attribute 5.
            let Some(material_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let layers = resolve_material(&mut decoder, material_id, unit_scale);
            if layers.is_empty() {
                return Vec::new();
            }

            related
                .into_iter()
                .flat_map(|element_id| {
                    layers.iter().map(move |layer| MaterialAssociation {
                        element_id,
                        set_name: layer.set_name.clone(),
                        layer_index: layer.layer_index,
                        material_name: layer.material_name.clone(),
                        thickness: layer.thickness,
                        is_ventilated: layer.is_ventilated,
                        category: layer.category.clone(),
                    })
                })
                .collect()
        })
        .collect()
}

/// Resolve an `IfcDocumentReference` / `IfcDocumentInformation` into
/// `(identification, name, location, description)`.
fn resolve_document(
    decoder: &mut EntityDecoder,
    id: u32,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return (None, None, None, None);
    };
    let ty = entity.ifc_type.as_str().to_ascii_uppercase();

    if ty == "IFCDOCUMENTINFORMATION" {
        // Identification(0), Name(1), Description(2), Location(3).
        return (
            entity.get_string(0).map(|s| s.to_string()),
            entity.get_string(1).map(|s| s.to_string()),
            entity.get_string(3).map(|s| s.to_string()),
            entity.get_string(2).map(|s| s.to_string()),
        );
    }

    // IfcDocumentReference: Location(0), Identification(1), Name(2),
    // Description(3), ReferencedDocument(4).
    let mut location = entity.get_string(0).map(|s| s.to_string());
    let mut identification = entity.get_string(1).map(|s| s.to_string());
    let mut name = entity.get_string(2).map(|s| s.to_string());
    let mut description = entity.get_string(3).map(|s| s.to_string());

    // Backfill missing fields from the referenced IfcDocumentInformation.
    if let Some(info_id) = entity.get_ref(4) {
        if let Ok(info) = decoder.decode_by_id(info_id) {
            if info
                .ifc_type
                .as_str()
                .eq_ignore_ascii_case("IFCDOCUMENTINFORMATION")
            {
                identification =
                    identification.or_else(|| info.get_string(0).map(|s| s.to_string()));
                name = name.or_else(|| info.get_string(1).map(|s| s.to_string()));
                description = description.or_else(|| info.get_string(2).map(|s| s.to_string()));
                location = location.or_else(|| info.get_string(3).map(|s| s.to_string()));
            }
        }
    }

    (identification, name, location, description)
}

/// Extract document associations (`IfcRelAssociatesDocument`).
fn extract_documents(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<DocumentAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESDOCUMENT")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting documents");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = related_object_ids(&rel);
            // RelatingDocument is attribute 5.
            let Some(doc_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let (identification, name, location, description) =
                resolve_document(&mut decoder, doc_id);

            related
                .into_iter()
                .map(|element_id| DocumentAssociation {
                    element_id,
                    identification: identification.clone(),
                    name: name.clone(),
                    location: location.clone(),
                    description: description.clone(),
                })
                .collect()
        })
        .collect()
}

/// Build spatial hierarchy from relationships.
fn build_spatial_hierarchy(
    relationships: &[Relationship],
    entities: &[EntityMetadata],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
    length_unit_scale: f64,
) -> SpatialHierarchyData {
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());

    // Build entity map for quick lookup
    let entity_map: FxHashMap<u32, &EntityMetadata> =
        entities.iter().map(|e| (e.entity_id, e)).collect();

    // Separate spatial relationships from element containment
    // IFCRELAGGREGATES: spatial parent -> spatial child (Project -> Site -> Building -> Storey)
    // IFCRELCONTAINEDINSPATIALSTRUCTURE: spatial container -> element (Storey -> Wall, Door, etc.)
    let mut spatial_children_map: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut element_containment_map: FxHashMap<u32, Vec<u32>> = FxHashMap::default();

    for rel in relationships {
        let rel_type_upper = rel.rel_type.to_uppercase();
        if rel_type_upper == "IFCRELAGGREGATES" {
            // Spatial hierarchy: parent -> child spatial nodes
            spatial_children_map
                .entry(rel.relating_id)
                .or_default()
                .push(rel.related_id);
        } else if rel_type_upper == "IFCRELCONTAINEDINSPATIALSTRUCTURE" {
            // Element containment: spatial container -> elements
            element_containment_map
                .entry(rel.relating_id)
                .or_default()
                .push(rel.related_id);
        }
    }

    // Find project (root)
    let project_id = entities
        .iter()
        .find(|e| e.type_name.to_uppercase() == "IFCPROJECT")
        .map(|e| e.entity_id)
        .unwrap_or(0);

    // Build all spatial nodes with full information
    let mut nodes_map: FxHashMap<u32, SpatialNode> = FxHashMap::default();

    let is_spatial_type = |type_name: &str| {
        matches!(
            type_name.to_uppercase().as_str(),
            "IFCPROJECT"
                | "IFCSITE"
                | "IFCBUILDING"
                | "IFCBUILDINGSTOREY"
                | "IFCSPACE"
                | "IFCFACILITY"
                | "IFCFACILITYPART"
                | "IFCBRIDGE"
                | "IFCBRIDGEPART"
                | "IFCROAD"
                | "IFCROADPART"
                | "IFCRAILWAY"
                | "IFCRAILWAYPART"
                | "IFCMARINEFACILITY"
        )
    };
    let is_building_like_spatial_type = |type_name: &str| {
        matches!(
            type_name.to_uppercase().as_str(),
            "IFCBUILDING"
                | "IFCFACILITY"
                | "IFCBRIDGE"
                | "IFCROAD"
                | "IFCRAILWAY"
                | "IFCMARINEFACILITY"
        )
    };

    // Collect all supported spatial entity IDs, including IFC4.3 facility hierarchies.
    let spatial_entity_ids: Vec<u32> = entities
        .iter()
        .filter(|e| is_spatial_type(&e.type_name))
        .map(|e| e.entity_id)
        .collect();

    // Build nodes recursively starting from project
    if project_id != 0 {
        build_spatial_nodes_recursive(
            project_id,
            0,
            0,
            "",
            &spatial_children_map,
            &element_containment_map,
            &entity_map,
            &mut decoder,
            &mut nodes_map,
            length_unit_scale,
        );
    }

    // Also process any spatial nodes not reachable from project (shouldn't happen, but be safe)
    for &entity_id in &spatial_entity_ids {
        if !nodes_map.contains_key(&entity_id) {
            if let Some(entity) = entity_map.get(&entity_id) {
                let name = entity
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}#{}", entity.type_name, entity_id));

                nodes_map.insert(
                    entity_id,
                    SpatialNode {
                        entity_id,
                        parent_id: 0,
                        level: 0,
                        path: name.clone(),
                        type_name: entity.type_name.clone(),
                        name: entity.name.clone(),
                        elevation: extract_elevation_if_storey(
                            &entity.type_name,
                            entity_id,
                            &mut decoder,
                            length_unit_scale,
                        ),
                        children_ids: spatial_children_map
                            .get(&entity_id)
                            .cloned()
                            .unwrap_or_default(),
                        element_ids: element_containment_map
                            .get(&entity_id)
                            .cloned()
                            .unwrap_or_default(),
                    },
                );
            }
        }
    }

    // Build lookup maps for element containment
    let mut element_to_storey = Vec::new();
    let mut element_to_building = Vec::new();
    let mut element_to_site = Vec::new();
    let mut element_to_space = Vec::new();

    for rel in relationships {
        if rel.rel_type.to_uppercase() == "IFCRELCONTAINEDINSPATIALSTRUCTURE" {
            let spatial_id = rel.relating_id;
            let element_id = rel.related_id;

            if let Some(spatial_node) = nodes_map.get(&spatial_id) {
                let type_upper = spatial_node.type_name.to_uppercase();
                if type_upper == "IFCBUILDINGSTOREY" {
                    element_to_storey.push((element_id, spatial_id));
                } else if is_building_like_spatial_type(&type_upper) {
                    element_to_building.push((element_id, spatial_id));
                } else if type_upper == "IFCSITE" {
                    element_to_site.push((element_id, spatial_id));
                } else if type_upper == "IFCSPACE" {
                    element_to_space.push((element_id, spatial_id));
                }
            }
        }
    }

    SpatialHierarchyData {
        nodes: nodes_map.into_values().collect(),
        project_id,
        element_to_storey,
        element_to_building,
        element_to_site,
        element_to_space,
    }
}

/// Recursively build spatial nodes with full information.
fn build_spatial_nodes_recursive(
    entity_id: u32,
    parent_id: u32,
    level: u16,
    parent_path: &str,
    spatial_children_map: &FxHashMap<u32, Vec<u32>>,
    element_containment_map: &FxHashMap<u32, Vec<u32>>,
    entity_map: &FxHashMap<u32, &EntityMetadata>,
    decoder: &mut EntityDecoder,
    nodes_map: &mut FxHashMap<u32, SpatialNode>,
    length_unit_scale: f64,
) {
    let entity = match entity_map.get(&entity_id) {
        Some(e) => e,
        None => return,
    };

    let entity_name = entity
        .name
        .as_ref()
        .cloned()
        .unwrap_or_else(|| format!("{}#{}", entity.type_name, entity_id));

    let path = if parent_path.is_empty() {
        entity_name.clone()
    } else {
        format!("{}/{}", parent_path, entity_name)
    };

    // Extract elevation for storeys (with unit scale applied)
    let elevation =
        extract_elevation_if_storey(&entity.type_name, entity_id, decoder, length_unit_scale);

    // Get children and elements
    let children_ids = spatial_children_map
        .get(&entity_id)
        .cloned()
        .unwrap_or_default();
    let element_ids = element_containment_map
        .get(&entity_id)
        .cloned()
        .unwrap_or_default();

    let node = SpatialNode {
        entity_id,
        parent_id,
        level,
        path: path.clone(),
        type_name: entity.type_name.clone(),
        name: entity.name.clone(),
        elevation,
        children_ids: children_ids.clone(),
        element_ids,
    };

    nodes_map.insert(entity_id, node);

    // Recursively process children
    for &child_id in &children_ids {
        build_spatial_nodes_recursive(
            child_id,
            entity_id,
            level + 1,
            &path,
            spatial_children_map,
            element_containment_map,
            entity_map,
            decoder,
            nodes_map,
            length_unit_scale,
        );
    }
}

/// Extract elevation from IFCBUILDINGSTOREY entity.
/// Applies unit scale to convert to meters.
fn extract_elevation_if_storey(
    type_name: &str,
    entity_id: u32,
    decoder: &mut EntityDecoder,
    length_unit_scale: f64,
) -> Option<f64> {
    if type_name.to_uppercase() != "IFCBUILDINGSTOREY" {
        return None;
    }

    // Try to decode the entity and get elevation (typically at attribute index 8)
    if let Ok(entity) = decoder.decode_by_id(entity_id) {
        // Elevation is typically at index 8 in IfcBuildingStorey
        // [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=ObjectType,
        // [5]=Tag, [6]=LongName, [7]=CompositionType, [8]=Elevation
        if let Some(elevation) = entity.get_float(8) {
            // Apply unit scale to convert to meters
            return Some(elevation * length_unit_scale);
        }
        // Fallback: try index 7
        if let Some(elevation) = entity.get_float(7) {
            // Apply unit scale to convert to meters
            return Some(elevation * length_unit_scale);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IFC4 model (millimetre units) with a wall carrying a two-layer material
    /// set, a Uniclass classification reference, and a document reference — one
    /// of each association type (issue #900).
    const ASSOCIATIONS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-900 associations fixture'),'2;1');
FILE_NAME('assoc.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
/* Material layer set: 200mm Concrete + 50mm ventilated Insulation */
#30=IFCMATERIAL('Concrete',$,$);
#31=IFCMATERIAL('Insulation',$,$);
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,$,$);
#33=IFCMATERIALLAYER(#31,50.,.T.,'Insul',$,$,$);
#34=IFCMATERIALLAYERSET((#32,#33),'WallSet',$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
/* Classification */
#40=IFCCLASSIFICATION('Uniclass 2015','2',$,'Uniclass 2015',$,$,$);
#41=IFCCLASSIFICATIONREFERENCE('https://uniclass.example','EF_25_10_25','Walls',#40,$,$);
#42=IFCRELASSOCIATESCLASSIFICATION('Cls0000000000000000001',$,$,$,(#28),#41);
/* Document */
#50=IFCDOCUMENTREFERENCE('https://docs.example/spec','DOC-001','Wall spec',$,$);
#51=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000001',$,$,$,(#28),#50);
/* Column with a material constituent set */
#60=IFCCOLUMN('Col0000000000000000001',$,'C1',$,$,$,$,$,$);
#61=IFCMATERIAL('Steel',$,$);
#62=IFCMATERIALCONSTITUENT('Core',$,#61,$,'load-bearing');
#63=IFCMATERIALCONSTITUENTSET('ColSet',$,(#62));
#64=IFCRELASSOCIATESMATERIAL('Mat0000000000000000002',$,$,$,(#60),#63);
/* Beam with a material profile set */
#70=IFCBEAM('Bem0000000000000000001',$,'B1',$,$,$,$,$,$);
#71=IFCMATERIAL('Timber',$,$);
#72=IFCMATERIALPROFILE('Flange',$,#71,$,$,$);
#73=IFCMATERIALPROFILESET('BeamSet',$,(#72),$);
#74=IFCRELASSOCIATESMATERIAL('Mat0000000000000000003',$,$,$,(#70),#73);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn extracts_classification_material_and_document_associations() {
        let dm = extract_data_model(ASSOCIATIONS_IFC);

        // Classification: one reference assigned to the wall (#28).
        assert_eq!(dm.classifications.len(), 1, "expected one classification");
        let c = &dm.classifications[0];
        assert_eq!(c.element_id, 28);
        assert_eq!(c.system_name.as_deref(), Some("Uniclass 2015"));
        assert_eq!(c.identification.as_deref(), Some("EF_25_10_25"));
        assert_eq!(c.name.as_deref(), Some("Walls"));

        // Materials: the wall (#28) has two layers, thickness in metres (mm * 0.001).
        let mut layers: Vec<_> = dm
            .materials
            .iter()
            .filter(|m| m.element_id == 28)
            .cloned()
            .collect();
        layers.sort_by_key(|m| m.layer_index);
        assert_eq!(layers.len(), 2, "expected two wall layers");
        assert_eq!(layers[0].element_id, 28);
        assert_eq!(layers[0].set_name.as_deref(), Some("WallSet"));
        assert_eq!(layers[0].material_name, "Concrete");
        assert!(
            (layers[0].thickness.unwrap() - 0.2).abs() < 1e-9,
            "200mm -> 0.2m"
        );
        assert_eq!(layers[0].is_ventilated, Some(false));
        assert_eq!(layers[1].material_name, "Insulation");
        assert!(
            (layers[1].thickness.unwrap() - 0.05).abs() < 1e-9,
            "50mm -> 0.05m"
        );
        assert_eq!(layers[1].is_ventilated, Some(true));

        // Document.
        assert_eq!(dm.documents.len(), 1, "expected one document");
        let d = &dm.documents[0];
        assert_eq!(d.element_id, 28);
        assert_eq!(d.identification.as_deref(), Some("DOC-001"));
        assert_eq!(d.name.as_deref(), Some("Wall spec"));
        assert_eq!(d.location.as_deref(), Some("https://docs.example/spec"));

        // Material constituent set on the column (#60) — constituents read from
        // attribute 2, set name preserved from attribute 0.
        let column_mats: Vec<_> = dm.materials.iter().filter(|m| m.element_id == 60).collect();
        assert_eq!(
            column_mats.len(),
            1,
            "expected one constituent for the column"
        );
        assert_eq!(column_mats[0].material_name, "Steel");
        assert_eq!(column_mats[0].set_name.as_deref(), Some("ColSet"));

        // The IfcRelAssociates* family must also land in the generic relationship
        // graph (relating = the material/classification/document, related = element).
        let has_rel = |ty: &str, relating: u32, related: u32| {
            dm.relationships.iter().any(|r| {
                r.rel_type.eq_ignore_ascii_case(ty)
                    && r.relating_id == relating
                    && r.related_id == related
            })
        };
        assert!(
            has_rel("IFCRELASSOCIATESCLASSIFICATION", 41, 28),
            "classification association missing from relationships"
        );
        assert!(
            has_rel("IFCRELASSOCIATESDOCUMENT", 50, 28),
            "document association missing from relationships"
        );
        assert!(
            has_rel("IFCRELASSOCIATESMATERIAL", 34, 28),
            "material association missing from relationships"
        );

        // Material profile set on the beam (#70).
        let beam_mats: Vec<_> = dm.materials.iter().filter(|m| m.element_id == 70).collect();
        assert_eq!(beam_mats.len(), 1, "expected one profile for the beam");
        assert_eq!(beam_mats[0].material_name, "Timber");
        assert_eq!(beam_mats[0].set_name.as_deref(), Some("BeamSet"));
    }

    #[test]
    fn associations_empty_without_relationships() {
        let plain = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;
        let dm = extract_data_model(plain);
        assert!(dm.classifications.is_empty());
        assert!(dm.materials.is_empty());
        assert!(dm.documents.is_empty());
    }
}
