// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Relationship extraction.

use super::types::{EntityJob, Relationship};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::sync::Arc;

/// Extract all relationships.
pub(super) fn extract_relationships(
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
