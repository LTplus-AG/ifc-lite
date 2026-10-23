// SPDX-License-Identifier: MPL-2.0
//! Conservative Reference-only admission over the shared product shape edge.
use super::{effective_element_rep_type, product_definition_shape};
use ifc_lite_core::{EntityDecoder, IfcType};

/// Prove Reference-only geometry without meshing. Unlike the mesh list reader,
/// this rejects non-reference list entries and bounds the list before decoding
/// any member. Unknown input cannot prove that a cutter may be omitted.
pub(crate) fn reference_only_opening(id: u32, decoder: &mut EntityDecoder<'_>) -> Option<bool> {
    let opening = decoder.decode_by_id(id).ok()?;
    if !opening.ifc_type.is_subtype_of(IfcType::IfcOpeningElement) {
        return None;
    }
    let shape = product_definition_shape(&opening, decoder).ok()??;
    let representations = shape.get_list(2)?;
    if representations.is_empty() || representations.len() > 64 {
        return None;
    }
    let mut reference = false;
    for value in representations {
        let representation = decoder.decode_by_id(value.as_entity_ref()?).ok()?;
        if representation.ifc_type != IfcType::IfcShapeRepresentation {
            return None;
        }
        match effective_element_rep_type(&opening, &representation) {
            Some("Reference") => reference = true,
            Some("BoundingBox") => {},
            _ => return None,
        }
    }
    Some(reference)
}
