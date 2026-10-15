// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Relationship extraction.

use super::generated::{relationship_slots, RelationshipSlots};
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
    // The schema-derived gate (issue #4205): a type is a relationship job iff
    // the generated table (apps/server/.../generated/relationship_slots.rs,
    // derived from @ifc-lite/parser's relationship-schema-slots.ts) has a
    // slot plan for it. This replaces a hand-written 13-entry array that
    // silently dropped every `IfcRelationship` subtype outside it — using the
    // slot lookup itself as the gate means there is exactly one table to keep
    // in sync with the schema, not two that can drift apart.
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            let type_upper = job.type_name.to_uppercase();
            relationship_slots(&type_upper).is_some()
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting relationships");

    let mut rels: Vec<Relationship> = rel_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            extract_relationship(&entity, &job.type_name, job.id)
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
                                // Synthetic: read off IfcTypeObject.HasPropertySets,
                                // so there is no IfcRel entity to name here.
                                rel_id: 0,
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
fn extract_relationship(
    entity: &DecodedEntity,
    type_name: &str,
    rel_id: u32,
) -> Option<Vec<Relationship>> {
    let type_upper = type_name.to_uppercase();

    // Schema-derived slot plan (issue #4205): the generated table already
    // encodes ABSOLUTE attribute positions and whether `related` is a
    // LIST/SET or a single reference — derived from the same
    // relationship-schema-slots.ts the TS/WASM columnar parser uses, so this
    // stays correct for every concrete `IfcRelationship` subtype without a
    // per-type match here. `extract_relationships` already filtered `jobs`
    // down to types this resolves, but re-check defensively (`?` below) in
    // case of a future caller.
    let slots: RelationshipSlots = relationship_slots(&type_upper)?;

    // `relating` is schema-legally a grouped aggregate for exactly one
    // concrete subtype (`IFCRELDEFINESBYPROPERTIES.RelatingPropertyDefinition`
    // — see `relating_is_list`'s doc comment in the generated table).
    // `get_ref` returns `None` for a list-valued attribute (it delegates to
    // `AttributeValue::as_entity_ref`, which only recognises a bare
    // reference), so calling it unconditionally silently dropped the WHOLE
    // relationship for a grouped `IfcPropertySetDefinitionSet` — every
    // related object lost all properties/quantities from that pset group.
    // `get_refs` accepts a bare ref, a list and (#7681) the typed
    // `IFCPROPERTYSETDEFINITIONSET((…))` spelling. For the first two it
    // mirrors the TS/WASM path's `readRefList`
    // (`columnar-parser-relationships.ts`; it does not read the typed
    // spelling), which reads
    // `RelatingPropertyDefinition` as a ref list unconditionally and applies
    // EVERY entry in the group to EVERY related object — reproduced below as
    // the same cross product, not just the first entry.
    let relating_ids: Vec<u32> = if slots.relating_is_list {
        entity.get_refs(slots.relating_idx as usize)?
    } else {
        vec![entity.get_ref(slots.relating_idx as usize)?]
    };

    let related_ids: Vec<u32> = if slots.related_is_list {
        let related_list = entity.get_list(slots.related_idx as usize)?;
        related_list
            .iter()
            .filter_map(|v| v.as_entity_ref())
            .collect()
    } else {
        vec![entity.get_ref(slots.related_idx as usize)?]
    };

    if relating_ids.is_empty() || related_ids.is_empty() {
        return None;
    }

    Some(
        relating_ids
            .into_iter()
            .flat_map(|relating_id| {
                related_ids.iter().map(move |&related_id| Relationship {
                    rel_type: type_name.to_string(),
                    rel_id,
                    relating_id,
                    related_id,
                })
            })
            .collect(),
    )
}
