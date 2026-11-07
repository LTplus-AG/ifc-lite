// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shallow structural entries for callers that must not eagerly decode a shape.

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

/// Identity only: no type admission, shape decoding or representation selection.
/// Routing hashes must also retain their existing handling of dangling references.
#[inline]
pub fn product_shape_id(element: &DecodedEntity) -> Option<u32> {
    element.get_ref(slot::IfcProduct::REPRESENTATION.index())
}

/// Items in list order, skipping non-references and missing/non-list Items.
/// No item is decoded here: RTC must try its speculative fast point read first,
/// skip undecodable items itself, and stop without touching later items on a hit.
#[inline]
pub fn rep_item_ids(rep: &DecodedEntity) -> impl Iterator<Item = u32> + '_ {
    rep.get_list(slot::IfcRepresentation::ITEMS.index())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_entity_ref())
}

/// Representation IDs in document order, without type admission or decoding.
/// Like `get_refs`, accepts bare references and typed reference sets, skipping
/// non-reference members. Missing or invalid values produce no IDs.
#[inline]
pub fn pds_representation_ids(pds: &DecodedEntity) -> impl Iterator<Item = u32> {
    pds.get_refs(slot::IfcProductDefinitionShape::REPRESENTATIONS.index())
        .unwrap_or_default()
        .into_iter()
}

/// Read MappingSource -> MappedRepresentation, decoding only the source.
/// Callers admit mapped items themselves. No source-type admission is applied:
/// legacy colour/layer probes accept even a wrongly typed source with slot 1.
/// Missing/non-reference slots and undecodable sources return None; the target
/// ID is returned even when dangling, so callers can probe their indexes first.
#[inline]
pub fn mapped_item_representation_id(item: &DecodedEntity, decoder: &mut EntityDecoder<'_>) -> Option<u32> {
    let source_id = item.get_ref(slot::IfcMappedItem::MAPPING_SOURCE.index())?;
    let source = decoder.decode_by_id(source_id).ok()?;
    source.get_ref(slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())
}

/// Prove an opening is Reference-only (BoundingBox is allowed alongside it).
/// Unknown/malformed input is inconclusive, including an empty or over-budget
/// list. Check the 64-entry bound BEFORE decoding any representation, and never
/// inspect Items: this policy does no geometry work (#4440, #7781 C2-2).
pub(crate) fn reference_only_opening(id: u32, decoder: &mut EntityDecoder<'_>) -> Option<bool> {
    let opening = decoder.decode_by_id(id).ok()?;
    if !opening.ifc_type.is_subtype_of(IfcType::IfcOpeningElement) {
        return None;
    }
    let pds = decoder.decode_by_id(product_shape_id(&opening)?).ok()?;
    if pds.ifc_type != IfcType::IfcProductDefinitionShape {
        return None;
    }
    let representations = pds.get_list(slot::IfcProductDefinitionShape::REPRESENTATIONS.index())?;
    if representations.is_empty() || representations.len() > 64 {
        return None;
    }
    let mut reference = false;
    for value in representations {
        let representation = decoder.decode_by_id(value.as_entity_ref()?).ok()?;
        if representation.ifc_type != IfcType::IfcShapeRepresentation {
            return None;
        }
        match super::effective_element_rep_type(&opening, &representation) {
            Some("Reference") => reference = true,
            Some("BoundingBox") => {}
            _ => return None,
        }
    }
    Some(reference)
}

#[cfg(test)]
#[path = "structural_tests.rs"]
mod tests;
