// SPDX-License-Identifier: MPL-2.0
//! Retained completeness must be checked before lenient decoding or selection.
use crate::representation::{ProductShape, ShapeError};
use crate::{Error, Result};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub(super) fn product_shape(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<ProductShape>> {
    let attr = element
        .get(6)
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
    reference_members(&shape, 2, "Representations")?;
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
            // Validate even a representation the meshed selector will skip:
            // selection may exclude valid geometry, never conceal malformed Items.
            reference_members(rep, 3, "Items")?;
        }
    }
    Ok(shape)
}

fn reference_members(entity: &DecodedEntity, index: usize, name: &str) -> Result<()> {
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
    Ok(())
}
