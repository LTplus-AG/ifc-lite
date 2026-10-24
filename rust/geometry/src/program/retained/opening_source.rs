// SPDX-License-Identifier: MPL-2.0
//! Reject partial reached opening bodies before the canonical child walk.
use super::RetainedSelection;
use crate::{Error, Result};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub(super) fn validate_opening_shape(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    selection: &RetainedSelection) -> Result<()> {
    let id = entity.get_ref(slot::IfcProduct::REPRESENTATION.index())
        .ok_or_else(|| Error::geometry("missing reached opening representation"))?;
    let shape = decoder.decode_by_id(id)?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        return Err(Error::geometry("wrong reached opening shape"));
    }
    let representations = shape.get_list(slot::IfcProductRepresentation::REPRESENTATIONS.index())
        .ok_or_else(|| Error::geometry("missing opening representation list"))?;
    if representations.is_empty() { return Err(Error::geometry("empty opening representation list")); }
    selection.charge_work(representations.len() as u64).map_err(Error::ProgramStopped)?;
    for representation in representations {
        let AttributeValue::EntityRef(id) = representation else { return Err(Error::geometry("non-reference opening representation")); };
        let representation = decoder.decode_by_id(*id)?;
        let items = representation.get_list(slot::IfcRepresentation::ITEMS.index())
            .ok_or_else(|| Error::geometry("missing opening item list"))?;
        selection.charge_work(items.len() as u64).map_err(Error::ProgramStopped)?;
        if items.is_empty() || items.iter().any(|item| !matches!(item, AttributeValue::EntityRef(_))) {
            return Err(Error::geometry("malformed reached opening items"));
        }
    }
    Ok(())
}
