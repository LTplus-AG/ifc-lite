// SPDX-License-Identifier: MPL-2.0
//! Enumerate every authored representation role, including symbolic geometry.

use super::denominator::{attribute, fail, refs};
use super::Product;
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, SchemaVersion};

pub(super) const MAX_ITEMS: usize = 100_000;
pub(super) const MAX_DEPTH: usize = 128;

pub(super) fn roots(
    entity: &DecodedEntity,
    product: &mut Product,
    decoder: &mut EntityDecoder,
    schema: SchemaVersion,
) -> Vec<u32> {
    product.global_id = attribute(entity, schema, "GlobalId")
        .and_then(AttributeValue::as_string)
        .map(str::to_owned);
    if !matches!(
        attribute(entity, schema, "GlobalId"),
        Some(AttributeValue::String(_) | AttributeValue::Null)
    ) {
        fail(product, "product:malformed_GlobalId");
    }
    let mut items = grid_axes(entity, product, schema);
    match attribute(entity, schema, "Representation") {
        Some(AttributeValue::Null) => {
            product.representation_state = if !product.enumeration_complete {
                "unresolved"
            } else if items.is_empty() {
                "absent"
            } else {
                "intrinsic_visual"
            };
            return items;
        }
        Some(AttributeValue::EntityRef(id)) => {
            product.representation_state = "present";
            let shape = match decoder.decode_by_id(*id) {
                Ok(shape)
                    if schema.is_subtype_of(shape.ifc_type.name(), "IfcProductRepresentation") =>
                {
                    shape
                }
                _ => {
                    fail(product, "product:unresolved_Representation");
                    return items;
                }
            };
            let Some(reps) = refs(attribute(&shape, schema, "Representations")) else {
                fail(product, "product:malformed_Representations");
                return items;
            };
            if reps.is_empty() || reps.len() > MAX_ITEMS {
                fail(product, "product:empty_or_bounded_Representations");
                return items;
            }
            for rep in reps {
                let children = representation_items(rep, product, decoder, schema);
                if items.len().saturating_add(children.len()) > MAX_ITEMS {
                    fail(product, "product:representation_walk_bound_or_cycle");
                    break;
                }
                items.extend(children);
            }
        }
        _ => fail(product, "product:malformed_Representation"),
    }
    items
}

pub(super) fn representation_items(
    id: u32,
    product: &mut Product,
    decoder: &mut EntityDecoder,
    schema: SchemaVersion,
) -> Vec<u32> {
    let rep = match decoder.decode_by_id(id) {
        Ok(rep) if schema.is_subtype_of(rep.ifc_type.name(), "IfcRepresentation") => rep,
        _ => {
            fail(product, "product:unresolved_shape_representation");
            return Vec::new();
        }
    };
    let context_valid = attribute(&rep, schema, "ContextOfItems")
        .and_then(|v| v.as_entity_ref())
        .and_then(|id| decoder.decode_by_id(id).ok())
        .is_some_and(|context| {
            schema.is_subtype_of(context.ifc_type.name(), "IfcRepresentationContext")
        });
    if !context_valid {
        fail(product, "product:unresolved_ContextOfItems");
    }
    if !matches!(
        attribute(&rep, schema, "RepresentationType"),
        Some(AttributeValue::String(_) | AttributeValue::Null)
    ) {
        fail(product, "product:malformed_RepresentationType");
    }
    let role = match attribute(&rep, schema, "RepresentationIdentifier") {
        Some(AttributeValue::String(role)) => Some(role.clone()),
        Some(AttributeValue::Null) => None,
        _ => {
            fail(product, "product:malformed_RepresentationIdentifier");
            None
        }
    };
    if role.as_deref() != Some("Body") {
        product.counts.non_body_products = 1;
        // No Axis is assumed to be derivation-only without source authentication.
        product.reasons.insert(format!(
            "product:unsupported_visual_role/{}",
            role.as_deref().unwrap_or("<unspecified>")
        ));
    }
    product.representation_roles.insert(id, role);
    let Some(items) = refs(attribute(&rep, schema, "Items")) else {
        fail(product, "product:malformed_Items");
        return Vec::new();
    };
    if items.is_empty() || items.len() > MAX_ITEMS {
        fail(product, "product:empty_or_bounded_Items");
        return Vec::new();
    }
    items
}

fn grid_axes(entity: &DecodedEntity, product: &mut Product, schema: SchemaVersion) -> Vec<u32> {
    let mut items = Vec::new();
    if !schema.is_subtype_of(entity.ifc_type.name(), "IfcGrid") {
        return items;
    }
    for name in ["UAxes", "VAxes", "WAxes"] {
        let value = attribute(entity, schema, name);
        if name == "WAxes" && matches!(value, Some(AttributeValue::Null)) {
            continue;
        }
        match refs(value) {
            Some(axes)
                if !axes.is_empty() && items.len().saturating_add(axes.len()) <= MAX_ITEMS =>
            {
                items.extend(axes)
            }
            _ => fail(product, "product:malformed_or_bounded_Grid_axes"),
        }
    }
    if !items.is_empty() {
        product.intrinsic_visual_roles.insert("Grid".into());
        product.counts.non_body_products = 1;
        product
            .reasons
            .insert("product:unsupported_visual_role/Grid".into());
    }
    items
}

// A type definition is not an occurrence. A representation-less occurrence
// assigned a mapped type is also not proved non-visual by its own `$` alone.
pub(super) fn check_type_absence(
    id: u32,
    product: &mut Product,
    decoder: &mut EntityDecoder,
    schema: SchemaVersion,
) {
    let valid_absence = decoder.decode_by_id(id).ok().is_some_and(|entity| {
        schema.is_subtype_of(entity.ifc_type.name(), "IfcTypeProduct")
            && matches!(
                attribute(&entity, schema, "RepresentationMaps"),
                Some(AttributeValue::Null)
            )
    });
    if !valid_absence {
        product.representation_state = "type_representation_unresolved";
        fail(product, "product:type_representation_not_enumerated");
    }
}
