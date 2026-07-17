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

    let mut rels: Vec<Relationship> = rel_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            extract_relationship(&entity, &job.type_name)
        })
        .flatten()
        .collect();

    // Attach each type's own property/quantity sets (issue #1751). Type sets in
    // IFC live on `IfcTypeObject.HasPropertySets` (attr 5), NOT via
    // IfcRelDefinesByProperties, so they carry no relationship the client can
    // follow. Emit a synthetic `TYPEHASPROPERTYSETS` edge (set -> type) per
    // member so the viewer converter can key type-owned sets by the type id and
    // resolve the WASM path's type fallback — mirroring
    // `extractTypeEntityOwnProperties`. A distinct rel_type keeps these out of
    // the DefinesByProperties graph (no phantom edges for inspector/IDS).
    let type_links = extract_type_property_links(&rels, content, entity_index);
    rels.extend(type_links);
    rels
}

/// For every type referenced by an `IfcRelDefinesByType`, read its
/// `HasPropertySets` (attr 5) and emit `{rel_type:"TYPEHASPROPERTYSETS",
/// relating_id: setId, related_id: typeId}` for each member. Types are
/// discovered from the DefinesByType `relating_id`s (never by name suffix,
/// which would catch IfcSurfaceStyle / the rel itself).
fn extract_type_property_links(
    rels: &[Relationship],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<Relationship> {
    use std::collections::BTreeSet;

    let type_ids: BTreeSet<u32> = rels
        .iter()
        .filter(|r| r.rel_type.eq_ignore_ascii_case("IFCRELDEFINESBYTYPE"))
        .map(|r| r.relating_id)
        .collect();

    if type_ids.is_empty() {
        return Vec::new();
    }

    type_ids
        .par_iter()
        .flat_map_iter(|&type_id| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let mut out = Vec::new();
            if let Ok(entity) = decoder.decode_by_id(type_id) {
                // IfcTypeObject.HasPropertySets is at index 5 across IFC2X3/4/4X3.
                if let Some(set_list) = entity.get_list(5) {
                    for set_ref in set_list.iter() {
                        if let Some(set_id) = set_ref.as_entity_ref() {
                            out.push(Relationship {
                                rel_type: "TYPEHASPROPERTYSETS".to_string(),
                                relating_id: set_id,
                                related_id: type_id,
                            });
                        }
                    }
                }
            }
            out
        })
        .collect()
}

/// Extract relationship from entity (may return multiple if related[] has multiple items).
fn extract_relationship(entity: &DecodedEntity, type_name: &str) -> Option<Vec<Relationship>> {
    let type_upper = type_name.to_uppercase();

    // IfcRelVoidsElement / IfcRelFillsElement carry a SINGLE related ref, not a
    // list, so the list-based path below would call `get_list(5)` on a single
    // entity ref, get None, and silently drop the relationship. Read both refs
    // directly. Attribute layout (IFC2X3/4/4X3, both extend IfcRelConnects):
    //   IfcRelVoidsElement(RelatingBuildingElement=4, RelatedOpeningElement=5)
    //   IfcRelFillsElement(RelatingOpeningElement=4, RelatedBuildingElement=5)
    if type_upper == "IFCRELVOIDSELEMENT" || type_upper == "IFCRELFILLSELEMENT" {
        let relating_id = entity.get_ref(4)?;
        let related_id = entity.get_ref(5)?;
        return Some(vec![Relationship {
            rel_type: type_name.to_string(),
            relating_id,
            related_id,
        }]);
    }

    let (relating_idx, related_idx) = match type_upper.as_str() {
        "IFCRELDEFINESBYPROPERTIES" => (5, 4), // RelatingPropertyDefinition at 5, RelatedObjects at 4
        // RelatingType (single ref) at 5, RelatedObjects (list) at 4 — same
        // layout as DefinesByProperties. Without this arm it hit the `_`
        // default `(4,5)`, and `get_ref(4)` on the RelatedObjects LIST returned
        // None, silently dropping every type relationship (issue #1751).
        "IFCRELDEFINESBYTYPE" => (5, 4),
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
