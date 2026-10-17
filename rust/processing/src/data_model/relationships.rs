// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Relationship extraction.

use super::slots::RelSlots;
use super::jobs::SplitDecoder;
use super::types::{EntityJob, Relationship};
use ifc_lite_core::DecodedEntity;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Extract all relationships.
pub(super) fn extract_relationships(
    jobs: &[EntityJob],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<Relationship> {
    // The schema-derived gate (issue #4205): a type is a relationship job iff
    // core's registry resolves a slot plan for it (`RelSlots::for_type`, which
    // is its own gate: a concrete `IfcRelationship` subtype in some bundled
    // schema). This replaces a hand-written 13-entry array that silently
    // dropped every `IfcRelationship` subtype outside it; the slot lookup
    // itself is the gate, so there is one source to keep in sync with the
    // schema, not two. Resolved once per distinct type, not per job.
    let mut resolved: FxHashMap<&str, Option<RelSlots>> = FxHashMap::default();
    let rel_jobs: Vec<(&EntityJob, RelSlots)> = jobs
        .iter()
        .filter_map(|job| {
            let slots = *resolved
                .entry(job.type_name)
                .or_insert_with(|| RelSlots::for_type(job.type_name));
            Some((job, slots?))
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting relationships");

    let mut rels: Vec<Relationship> = rel_jobs
        .par_iter()
        .map_init(
            || SplitDecoder::new(content, entity_index),
            |split, (job, slots)| {
                    let entity = split.next_job().decode_at(job.start, job.end).ok()?;
                    extract_relationship(&entity, job.type_name, job.id, *slots)
            },
        )
        .flatten()
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
    content: &[u8],
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
        .map_init(
            || SplitDecoder::new(content, entity_index),
            |split, &type_id| {
                let decoder = split.next_job();
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
            },
        )
        .flatten()
        .collect()
}

/// Extract relationship from entity (may return multiple if related[] has multiple items).
///
/// `slots` is the schema-derived plan (issue #4205): ABSOLUTE attribute
/// positions and whether each side is a LIST/SET or a single reference, from
/// the same plan the TS/WASM columnar parser uses
/// (`relationship-schema-slots.ts`), so this stays correct for every concrete
/// `IfcRelationship` subtype without a per-type match here.
fn extract_relationship(
    entity: &DecodedEntity,
    type_name: &str,
    rel_id: u32,
    slots: RelSlots,
) -> Option<Vec<Relationship>> {
    // `relating` is schema-legally a grouped aggregate for exactly one
    // concrete subtype (`IFCRELDEFINESBYPROPERTIES.RelatingPropertyDefinition`
    // — see `RelSlots::relating_is_list`).
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
        entity.get_refs(slots.relating)?
    } else {
        vec![entity.get_ref(slots.relating)?]
    };

    let related_ids: Vec<u32> = if slots.related_is_list {
        let related_list = entity.get_list(slots.related)?;
        related_list
            .iter()
            .filter_map(|v| v.as_entity_ref())
            .collect()
    } else {
        vec![entity.get_ref(slots.related)?]
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
