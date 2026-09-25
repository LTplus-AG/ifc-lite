// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Select and place one product's meshed body representations before item walk.

use super::WalkItem;
use crate::analytic_export::placement::validate_placement_chain;
use crate::analytic_export::MAX_VISITED_ITEMS;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::{meshed_representations, GeometryRouter};
use nalgebra::Matrix4;

/// `None` means a product has no representation. Errors include the product
/// identity and must be reported by the caller; a partial stack never escapes.
pub(super) fn seed_product(
    product: &DecodedEntity,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Result<Option<Vec<WalkItem>>, String> {
    let id = product.id;
    let rep_attr = product.get(6)
        .ok_or_else(|| format!("product #{id}: missing Representation attribute"))?;
    if rep_attr.is_null() { return Ok(None); }
    let rep_id = rep_attr.as_entity_ref()
        .ok_or_else(|| format!("product #{id}: Representation is not an entity reference"))?;
    let representation = decoder.decode_by_id(rep_id)
        .map_err(|error| format!("product #{id}: Representation #{rep_id}: {error}"))?;
    if representation.ifc_type != IfcType::IfcProductDefinitionShape {
        return Err(format!("product #{id}: Representation #{rep_id} is not IfcProductDefinitionShape"));
    }
    let reps_attr = representation.get(2).ok_or_else(|| format!(
        "product #{id}: IfcProductDefinitionShape #{rep_id} has no Representations attribute"
    ))?;
    let reps_list = reps_attr.as_list().ok_or_else(|| format!(
        "product #{id}: IfcProductDefinitionShape #{rep_id} has malformed Representations list"
    ))?;
    if reps_list.is_empty() || reps_list.iter().any(|item| item.as_entity_ref().is_none()) {
        return Err(format!("product #{id}: IfcProductDefinitionShape #{rep_id} has malformed Representations list"));
    }
    if reps_list.len() > MAX_VISITED_ITEMS {
        return Err(format!("product #{id}: Representations list exceeds work budget"));
    }
    let reps = decoder.resolve_ref_list(reps_attr).map_err(|error| format!(
        "product #{id}: IfcProductDefinitionShape #{rep_id} Representations: {error}"
    ))?;
    validate_placement_chain(product, decoder)
        .map_err(|error| format!("product #{id}: placement: {error}"))?;
    let matrix = router.resolve_scaled_placement_strict(product, decoder)
        .map_err(|error| format!("product #{id}: placement: {error}"))?;
    let transform = Matrix4::from_column_slice(&matrix);
    let mut stack = Vec::new();
    for rep in meshed_representations(product, &reps) {
        let items_attr = rep.get(3).ok_or_else(|| format!(
            "product #{id}: representation #{} is missing Items", rep.id
        ))?;
        let item_refs = items_attr.as_list().ok_or_else(|| format!(
            "product #{id}: representation #{} has malformed Items", rep.id
        ))?;
        if item_refs.is_empty() || item_refs.iter().any(|item| item.as_entity_ref().is_none()) {
            return Err(format!("product #{id}: representation #{} has malformed Items", rep.id));
        }
        if stack.len().saturating_add(item_refs.len()) > MAX_VISITED_ITEMS {
            return Err(format!("product #{id}: representation items exceed work budget"));
        }
        let items = decoder.resolve_ref_list(items_attr)
            .map_err(|error| format!("product #{id}: items: {error}"))?;
        stack.extend(items.into_iter().rev().map(|item| WalkItem {
            item, transform, path: Vec::new(), map_path: Vec::new(),
            representation_id: rep.id, ancestors: Vec::new(), source_modified: false,
        }));
    }
    Ok(Some(stack))
}
