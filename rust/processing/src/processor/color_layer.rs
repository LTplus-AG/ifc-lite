// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{get_refs_from_list, normalize_optional_string};
use crate::style::GeometryStyleInfo;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;

pub(super) fn collect_presentation_layer_assignments(
    layer_by_assigned_representation: &mut FxHashMap<u32, String>,
    layer_assignment: &DecodedEntity,
) {
    let Some(layer_name) = normalize_optional_string(layer_assignment.get_string(0)) else {
        return;
    };

    let Some(assigned_items) = get_refs_from_list(layer_assignment, 2) else {
        return;
    };

    for assigned in assigned_items {
        layer_by_assigned_representation
            .entry(assigned)
            .or_insert_with(|| layer_name.clone());
    }
}

pub(super) fn resolve_element_color_for_product_definition_shape(
    product_definition_shape_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    find_color_in_representation(product_definition_shape_id, geometry_styles, decoder)
}

pub(super) fn resolve_presentation_layer_for_product_definition_shape(
    product_definition_shape_id: u32,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
) -> Option<String> {
    if let Some(layer_name) = layer_by_assigned_representation.get(&product_definition_shape_id) {
        return Some(layer_name.clone());
    }

    let product_definition_shape = decoder.decode_by_id(product_definition_shape_id).ok()?;
    let representation_ids = get_refs_from_list(&product_definition_shape, 2)?;

    for representation_id in representation_ids {
        if let Some(layer_name) = resolve_presentation_layer_name(
            representation_id,
            layer_by_assigned_representation,
            cache_by_representation,
            decoder,
            &mut Vec::new(),
        ) {
            return Some(layer_name);
        }
    }

    None
}

fn resolve_presentation_layer_name(
    representation_id: u32,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
    traversal_stack: &mut Vec<u32>,
) -> Option<String> {
    if let Some(cached) = cache_by_representation.get(&representation_id) {
        return cached.clone();
    }

    if traversal_stack.contains(&representation_id) {
        return None;
    }
    traversal_stack.push(representation_id);

    if let Some(layer_name) = layer_by_assigned_representation.get(&representation_id) {
        let result = Some(layer_name.clone());
        cache_by_representation.insert(representation_id, result.clone());
        traversal_stack.pop();
        return result;
    }

    let mut resolved: Option<String> = None;

    if let Ok(representation) = decoder.decode_by_id(representation_id) {
        if let Some(items) = get_refs_from_list(&representation, 3) {
            for item_id in items {
                if let Some(layer_name) = layer_by_assigned_representation.get(&item_id) {
                    resolved = Some(layer_name.clone());
                    break;
                }

                if let Ok(item) = decoder.decode_by_id(item_id) {
                    if item.ifc_type == IfcType::IfcMappedItem {
                        if let Some(mapping_source_id) = item.get_ref(0) {
                            if let Ok(mapping_source) = decoder.decode_by_id(mapping_source_id) {
                                if let Some(mapped_representation_id) = mapping_source.get_ref(1) {
                                    if let Some(layer_name) = resolve_presentation_layer_name(
                                        mapped_representation_id,
                                        layer_by_assigned_representation,
                                        cache_by_representation,
                                        decoder,
                                        traversal_stack,
                                    ) {
                                        resolved = Some(layer_name);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    traversal_stack.pop();
    cache_by_representation.insert(representation_id, resolved.clone());
    resolved
}

/// Find a color in a representation by traversing its items.
fn find_color_in_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    // Decode the IfcProductDefinitionShape
    let repr = decoder.decode_by_id(repr_id).ok()?;

    // Attribute 2: Representations (list of IfcRepresentation)
    let repr_list = get_refs_from_list(&repr, 2)?;

    for shape_repr_id in repr_list {
        if let Ok(shape_repr) = decoder.decode_by_id(shape_repr_id) {
            // Attribute 3: Items (list of IfcRepresentationItem)
            if let Some(items) = get_refs_from_list(&shape_repr, 3) {
                for item_id in items {
                    // Check direct style
                    if let Some(style) = geometry_styles.get(&item_id) {
                        return Some(style.color);
                    }

                    // Check mapped items
                    if let Ok(item) = decoder.decode_by_id(item_id) {
                        if item.ifc_type == IfcType::IfcMappedItem {
                            if let Some(source_id) = item.get_ref(0) {
                                if let Ok(source) = decoder.decode_by_id(source_id) {
                                    if let Some(mapped_repr_id) = source.get_ref(1) {
                                        if let Some(color) = find_color_in_shape_representation(
                                            mapped_repr_id,
                                            geometry_styles,
                                            decoder,
                                        ) {
                                            return Some(color);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Find color in a shape representation.
fn find_color_in_shape_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let repr = decoder.decode_by_id(repr_id).ok()?;
    let items = get_refs_from_list(&repr, 3)?;

    for item_id in items {
        if let Some(style) = geometry_styles.get(&item_id) {
            return Some(style.color);
        }
    }

    None
}
