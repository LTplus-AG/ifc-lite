// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Data model extraction service - extracts properties, relationships, and spatial hierarchy.

mod classifications;
mod generated;
mod documents;
mod materials;
mod metadata;
mod properties;
mod quantities;
mod relationships;
mod spatial;
mod types;

pub use types::*;

use classifications::extract_classifications;
use documents::extract_documents;
use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, DecodedEntity, EntityDecoder, EntityScanner,
};
use materials::extract_materials;
use metadata::extract_entity_metadata;
use properties::extract_properties;
use quantities::extract_quantities;
use relationships::extract_relationships;
use spatial::build_spatial_hierarchy;
use std::sync::Arc;

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

/// Read an `IfcLogical` / `IfcBoolean` attribute as a tri-state `Option<bool>`
/// (`.U.` / absent → `None`).
pub(super) fn read_logical(entity: &DecodedEntity, index: usize) -> Option<bool> {
    let token = entity.get(index)?.as_enum()?;
    match token {
        "T" | "TRUE" | "true" => Some(true),
        "F" | "FALSE" | "false" => Some(false),
        _ => None,
    }
}

/// Collect the `RelatedObjects` (attribute 4) entity ids of an `IfcRelAssociates*`.
pub(super) fn related_object_ids(rel: &DecodedEntity) -> Vec<u32> {
    rel.get_list(4)
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}


#[cfg(test)]
#[path = "tests.rs"]
mod tests;
