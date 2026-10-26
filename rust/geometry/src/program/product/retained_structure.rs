// SPDX-License-Identifier: MPL-2.0
//! Retained completeness must be checked before lenient decoding or selection.
use crate::representation::{ProductShape, ShapeError};
use crate::{Error, Result};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub(super) fn validated_product_shape(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<ProductShape>> {
    let attr = element
        .get(slot::IfcProduct::REPRESENTATION.index())
        .ok_or(ShapeError::NoRepresentationAttribute {
            element: element.id,
        })?;
    // Only an authored absent Representation is an empty product. In
    // particular, `*` is not a derived attribute at this IfcProduct slot.
    if matches!(attr, AttributeValue::Null) {
        return Ok(None);
    }
    let id = attr
        .as_entity_ref()
        .ok_or_else(|| Error::geometry("retained Representation must be a reference or $"))?;
    let shape = decoder.decode_by_id(id)?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        return Err(ShapeError::NotAProductDefinitionShape(shape.ifc_type).into());
    }
    reference_members(
        &shape,
        slot::IfcProductDefinitionShape::REPRESENTATIONS.index(),
        "Representations",
    )?;
    // This wrapper is not recursive: the distinct shared reader below walks
    // only the authored, finite Representations list, never child references.
    // The shared reader preserves decoding errors and authored order. Its
    // lossy list conversion is safe only after validating the raw members.
    let shape = crate::representation::product_shape(element, decoder)?;
    if let Some(shape) = &shape {
        for rep in shape.representations() {
            crate::resource::check_current()?;
            if !matches!(
                rep.ifc_type,
                IfcType::IfcShapeRepresentation | IfcType::IfcTopologyRepresentation
            ) {
                return Err(Error::geometry(format!(
                    "retained Representations contains non-shape representation #{} ({})",
                    rep.id, rep.ifc_type
                )));
            }
            // Resolve and classify even the Items the meshed selector will skip.
            // This is shallow: no mapping targets or geometry children are read.
            let members = reference_members(rep, slot::IfcRepresentation::ITEMS.index(), "Items")?;
            item_targets(members, decoder)?;
        }
    }
    Ok(shape)
}

fn reference_members<'a>(
    entity: &'a DecodedEntity,
    index: usize,
    name: &str,
) -> Result<&'a [AttributeValue]> {
    let members = entity
        .get(index)
        .and_then(AttributeValue::as_list)
        .filter(|members| !members.is_empty())
        .ok_or_else(|| {
            Error::geometry(format!("retained {name} must be a nonempty reference list"))
        })?;
    for member in members {
        crate::resource::check_current()?;
        if member.as_entity_ref().is_none() {
            return Err(Error::geometry(format!(
                "retained {name} on #{} contains a non-reference member",
                entity.id
            )));
        }
    }
    Ok(members)
}

fn item_targets(members: &[AttributeValue], decoder: &mut EntityDecoder) -> Result<()> {
    // reference_members has checked every token before this conversion, so
    // none can disappear here. Keep the exact reader's leniency out of S1.
    for id in members.iter().filter_map(AttributeValue::as_entity_ref) {
        crate::resource::check_current()?;
        let item = decoder.decode_by_id(id)?;
        // The generated supported-schema hierarchy includes geometric,
        // topological, styled and mapped items, including legacy subclasses.
        // Category membership does not admit a new retained constructor.
        if !item.ifc_type.is_subtype_of(IfcType::IfcRepresentationItem) {
            return Err(Error::geometry(format!(
                "retained Items contains non-IfcRepresentationItem #{} ({})",
                item.id, item.ifc_type
            )));
        }
    }
    Ok(())
}
