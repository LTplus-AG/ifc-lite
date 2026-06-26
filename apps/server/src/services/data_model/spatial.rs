// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Spatial hierarchy extraction.

use super::types::{EntityMetadata, Relationship, SpatialHierarchyData, SpatialNode};
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Build spatial hierarchy from relationships.
pub(super) fn build_spatial_hierarchy(
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
        if let std::collections::hash_map::Entry::Vacant(e) = nodes_map.entry(entity_id) {
            if let Some(entity) = entity_map.get(&entity_id) {
                let name = entity
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}#{}", entity.type_name, entity_id));

                e.insert(SpatialNode {
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
                    });
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
// Threads the full recursion context (maps, caches, accumulators); grouping the
// args into a struct would not change behavior and is out of scope here.
#[allow(clippy::too_many_arguments)]
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
