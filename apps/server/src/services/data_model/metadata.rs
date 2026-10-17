// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Entity metadata extraction.

use super::slots::RootSlots;
use super::types::{EntityJob, EntityMetadata};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Non-empty string attribute at a registry index (`None` = not declared).
fn string_at(entity: &DecodedEntity, idx: Option<usize>) -> Option<String> {
    entity
        .get_string(idx?)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// PredefinedType enum token at a registry index. STEP enums decode to
/// `AttributeValue::Enum` with the dots already stripped (`.SOLIDWALL.` →
/// `SOLIDWALL`), matching the WASM `extractAllEntityAttributes` display value —
/// read via `as_enum()`, never `get_string()`.
fn enum_at(entity: &DecodedEntity, idx: Option<usize>) -> Option<String> {
    entity
        .get(idx?)
        .and_then(|v| v.as_enum())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Extract entity metadata for all entities.
pub(super) fn extract_entity_metadata(
    jobs: &[EntityJob],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<EntityMetadata> {
    // Types are few (hundreds) and rows are many (millions): the registry
    // lookup runs once per type per rayon split.
    jobs.par_iter()
        .map_init(FxHashMap::<&str, RootSlots>::default, |memo, job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content, entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;
            let has_geometry = ifc_lite_core::has_geometry_by_name(job.type_name);

            // Root attributes at the SAME schema-registry positions the WASM
            // path resolves them (issue #1765) — see slots.rs (IFC4 positions
            // for every file, D43).
            // GlobalId/Name are NOT fixed at 0/2 for every entity: that only
            // holds for `IfcRoot` subtypes. `IfcClassification`, for example,
            // has no GlobalId at all and its Name sits at index 3, not 2
            // (issue #3949).
            let idx = *memo.entry(job.type_name).or_insert_with(|| {
                RootSlots::for_type(job.type_name).unwrap_or(RootSlots::UNKNOWN_TYPE_FALLBACK)
            });
            let global_id = string_at(&entity, idx.global_id);
            let name = string_at(&entity, idx.name);
            let description = string_at(&entity, idx.description);
            let object_type = string_at(&entity, idx.object_type);
            let tag = string_at(&entity, idx.tag);
            let predefined_type = enum_at(&entity, idx.predefined_type);

            Some(EntityMetadata {
                entity_id: job.id,
                type_name: job.type_name.to_string(),
                global_id,
                name,
                description,
                object_type,
                tag,
                predefined_type,
                has_geometry,
            })
        })
        .flatten()
        .collect()
}
