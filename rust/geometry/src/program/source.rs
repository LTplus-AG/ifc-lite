// SPDX-License-Identifier: MPL-2.0
//! Reached whole-list admission shared by product, mapped and type consumers.
use crate::{Error, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};

/// The consumers historically disagree about absent Items. Keep that policy at
/// admission rather than turning malformed required lists into empty success.
pub(crate) enum ItemListPolicy { Product, RequiredMap, OptionalMap }

/// Owns the already admitted list, including repeated authored occurrences.
/// Constructed only at the consumer's historical reached admission point.
pub(crate) struct ItemProgram(std::vec::IntoIter<DecodedEntity>);

impl ItemProgram {
    pub(crate) fn empty() -> Self { Self(Vec::new().into_iter()) }

    pub(crate) fn admit(rep: &DecodedEntity, decoder: &mut EntityDecoder<'_>, policy: ItemListPolicy) -> Result<Self> {
        let items = match policy {
            ItemListPolicy::Product => crate::representation::rep_items(rep, decoder)?,
            ItemListPolicy::RequiredMap => {
                let attribute = rep.get(slot::IfcRepresentation::ITEMS.index())
                    .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
                decoder.resolve_ref_list(attribute)?
            }
            ItemListPolicy::OptionalMap => match rep.get(slot::IfcRepresentation::ITEMS.index()) {
                Some(attribute) => decoder.resolve_ref_list(attribute)?,
                None => Vec::new(),
            },
        };
        Ok(Self(items.into_iter()))
    }
}

impl Iterator for ItemProgram {
    type Item = DecodedEntity;
    fn next(&mut self) -> Option<Self::Item> { self.0.next() }
}

/// The opening probes deliberately accept a resolved shape of any type and use
/// their historical error strings. All representations precede placement and
/// every item admission; this is not the stricter product_shape policy.
pub(super) fn opening_representations(element: &DecodedEntity, decoder: &mut EntityDecoder<'_>) -> Result<Option<Vec<DecodedEntity>>> {
    let attr = element.get(slot::IfcProduct::REPRESENTATION.index())
        .ok_or_else(|| Error::geometry("Element has no representation attribute".to_string()))?;
    if attr.is_null() { return Ok(None) }
    let representation = decoder.resolve_ref(attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;
    let list = representation.get(slot::IfcProductDefinitionShape::REPRESENTATIONS.index())
        .ok_or_else(|| Error::geometry("ProductDefinitionShape missing Representations".to_string()))?;
    let representations = decoder.resolve_ref_list(list)?;
    Ok(Some(crate::representation::meshed_representations(element, &representations).cloned().collect()))
}
