// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plan symbols held only on a type's `RepresentationMaps` (#8233).
//!
//! A product with no symbolic representation of its own inherits the
//! Plan / Annotation / FootPrint / Axis maps of the `IfcTypeProduct` that
//! `IfcRelDefinesByType` assigns it. The occurrence's `ObjectPlacement`
//! composed with the map's `MappingOrigin` places the symbol, in the frame of
//! the representation's context, the same as an `IfcMappedItem` with an
//! identity `MappingTarget` inside an occurrence representation.

use super::items::resolve_mapping_origin;
use super::output_cap::SymbolicAccumulator;
use super::rebase::RenderFrameRebase;
use super::transform::{compose_transforms, resolve_context_transform, resolve_object_placement};
use super::representation_walk::{emit_shape_representation, is_symbolic_identifier};
use ifc_lite_core::{keyword_eq, slot, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

/// Occurrence express id -> `IfcRelDefinesByType.RelatingType` id.
pub(super) fn build_type_of(content: &[u8], decoder: &mut EntityDecoder) -> FxHashMap<u32, u32> {
    let mut type_of = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !keyword_eq(type_name, "IFCRELDEFINESBYTYPE") {
            continue;
        }
        let Ok(rel) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let (Some(type_id), Some(occurrences)) = (
            rel.ref_at(slot::IfcRelDefinesByType::RELATING_TYPE),
            rel.ref_list_at(slot::IfcRelDefinesByType::RELATED_OBJECTS),
        ) else {
            continue;
        };
        for occurrence in occurrences {
            type_of.entry(occurrence).or_insert(type_id);
        }
    }
    type_of
}

/// Draw the symbolic maps of `type_id` for the occurrence `entity`.
#[allow(clippy::too_many_arguments)]
pub(super) fn walk_type_representation_maps(
    entity: &DecodedEntity,
    id: u32,
    type_id: u32,
    ifc_type_name: &str,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
    rebase: RenderFrameRebase,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicAccumulator,
) {
    let Ok(type_entity) = decoder.decode_by_id(type_id) else {
        return;
    };
    let Some(maps_attr) = type_entity.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS) else {
        return;
    };
    let Ok(maps) = decoder.resolve_ref_list(maps_attr) else {
        return;
    };
    let placement = resolve_object_placement(entity, decoder, unit_scale);
    for rep_map in maps {
        if out.is_exhausted() {
            break;
        }
        if rep_map.ifc_type != IfcType::IfcRepresentationMap {
            continue;
        }
        let Some(rep_id) = rep_map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION) else { continue };
        let Ok(shape_rep) = decoder.decode_by_id(rep_id) else { continue };
        if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
            continue;
        }
        let rep_identifier = shape_rep
            .string_at(slot::IfcShapeRepresentation::REPRESENTATION_IDENTIFIER)
            .unwrap_or("");
        if !is_symbolic_identifier(rep_identifier) {
            continue;
        }
        // As if wrapped in an occurrence representation of the same context
        // holding an `IfcMappedItem` with an identity target: the context's
        // WorldCoordinateSystem, then the placement, then the MappingOrigin
        // (the own-representation walk composes context and placement the
        // same way, #7779). Skipping the context would draw type symbols in a
        // different frame from every other symbol of a rotated or offset model.
        let context = resolve_context_transform(&shape_rep, decoder, unit_scale);
        let origin = resolve_mapping_origin(&rep_map, decoder, unit_scale);
        let base = compose_transforms(&compose_transforms(&context, &placement), &origin);
        emit_shape_representation(
            &shape_rep,
            rep_identifier,
            &base,
            // Fill provenance binds a direct fill to a sole representation.
            true,
            id,
            ifc_type_name,
            decoder,
            unit_scale,
            rebase,
            styled_items,
            out,
        );
    }
}
