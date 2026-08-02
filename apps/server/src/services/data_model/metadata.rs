// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Entity metadata extraction.

use super::generated::{root_attr_indices, RootAttrIndices};
use super::types::{EntityJob, EntityMetadata};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::sync::Arc;

/// Unknown-type fallback, mirroring the WASM path's
/// `extractRootAttributesFromEntity`: Description 3, ObjectType 4, Tag 7 (the
/// IfcElement layout), and NO PredefinedType. Applied only when the type is
/// absent from the schema registry — a KNOWN type without an attribute keeps
/// its -1 and stays empty on both parse paths.
const UNKNOWN_TYPE_FALLBACK: RootAttrIndices = RootAttrIndices {
    description: 3,
    object_type: 4,
    tag: 7,
    predefined_type: -1,
};

/// Non-empty string attribute at a registry index (-1 = not declared).
fn string_at(entity: &DecodedEntity, idx: i8) -> Option<String> {
    if idx < 0 {
        return None;
    }
    entity
        .get_string(idx as usize)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// PredefinedType enum token at a registry index. STEP enums decode to
/// `AttributeValue::Enum` with the dots already stripped (`.SOLIDWALL.` →
/// `SOLIDWALL`), matching the WASM `extractAllEntityAttributes` display value —
/// read via `as_enum()`, never `get_string()`.
fn enum_at(entity: &DecodedEntity, idx: i8) -> Option<String> {
    if idx < 0 {
        return None;
    }
    entity
        .get(idx as usize)
        .and_then(|v| v.as_enum())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Extract entity metadata for all entities.
pub(super) fn extract_entity_metadata(
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

            // Root attributes at the SAME schema-registry positions the WASM
            // path resolves them (issue #1765) — see generated/attr_indices.rs.
            let upper = job.type_name.to_uppercase();
            let idx = root_attr_indices(&upper).unwrap_or(UNKNOWN_TYPE_FALLBACK);
            let description = string_at(&entity, idx.description);
            let object_type = string_at(&entity, idx.object_type);
            let tag = string_at(&entity, idx.tag);
            let predefined_type = enum_at(&entity, idx.predefined_type);

            Some(EntityMetadata {
                entity_id: job.id,
                type_name: job.type_name.clone(),
                global_id,
                name,
                description,
                object_type,
                tag,
                predefined_type,
                has_geometry,
            })
        })
        .collect()
}
