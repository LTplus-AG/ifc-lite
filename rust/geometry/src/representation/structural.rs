// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shallow structural entries for callers that must not eagerly decode a shape.

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

/// Identity only: no type admission, shape decoding or representation selection.
/// Routing hashes must also retain their existing handling of dangling references.
#[inline]
pub(crate) fn product_shape_id(element: &DecodedEntity) -> Option<u32> {
    element.get_ref(slot::IfcProduct::REPRESENTATION.index())
}

/// Items in list order, skipping non-references and missing/non-list Items.
/// No item is decoded here: RTC must try its speculative fast point read first,
/// skip undecodable items itself, and stop without touching later items on a hit.
#[inline]
pub(crate) fn rep_item_ids(rep: &DecodedEntity) -> impl Iterator<Item = u32> + '_ {
    rep.get_list(slot::IfcRepresentation::ITEMS.index())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_entity_ref())
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
