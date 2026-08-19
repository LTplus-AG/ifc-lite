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

/// Find a color in a representation (`IfcProductDefinitionShape`) by
/// traversing each of its `IfcShapeRepresentation`s.
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
        if let Some(color) =
            find_color_in_shape_representation(shape_repr_id, geometry_styles, decoder)
        {
            return Some(color);
        }
    }

    None
}

/// Find color in a shape representation: delegates each item to
/// `element::find_geometry_item_color`, the canonical per-element resolver
/// (#913 §2.7), instead of re-walking the `IfcMappedItem ->
/// IfcRepresentationMap -> MappedRepresentation` chain here.
///
/// This used to duplicate that walk inline, one hop deep, so a styled leaf
/// sitting two or more mapped-item hops down resolved through the canonical
/// path but not through this prepass fallback (the asymmetry this function
/// exists to fix). Widening the local walk to match — instead of delegating
/// — reintroduced the walk's own unbounded recursion here a second time:
/// `element::find_geometry_item_color` had already been bounded by
/// `MAX_MAPPED_ITEM_DEPTH` plus a depth-recording visited map after a cyclic
/// `IfcMappedItem` chain was found to abort the process through it (#2863,
/// #2864 — a Rust stack overflow is an abort, not a catchable panic, so
/// nothing short of a bound stops it). A second, separately bounded copy of
/// the same traversal here would only defer the next divergence: the two caps
/// would need to be kept in step by hand instead of not existing. Calling the
/// guarded resolver directly means there is one traversal and one bound, and
/// the asymmetry cannot reopen.
fn find_color_in_shape_representation(
    repr_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let repr = decoder.decode_by_id(repr_id).ok()?;
    let items = get_refs_from_list(&repr, 3)?;

    for item_id in items {
        if let Some(color) =
            crate::element::find_geometry_item_color(item_id, geometry_styles, decoder)
        {
            return Some(color);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_core::{build_entity_index, EntityDecoder};

    /// `find_color_in_representation` used to bottom out after ONE level of
    /// `IfcMappedItem` indirection: `find_color_in_shape_representation`
    /// checked each item's own direct style but never chased a nested
    /// `IfcMappedItem` inside a mapped representation's items, unlike the
    /// canonical per-element resolver `element::find_geometry_item_color`
    /// (#913 §2.7), which recurses to arbitrary depth.
    ///
    /// This fixture nests the styled geometry TWO mapped-item hops deep:
    /// `#10 PDS -> #20 ShapeRepr -> #30 MappedItem -> #40 RepMap -> #50
    /// ShapeRepr -> #60 MappedItem -> #70 RepMap -> #80 ShapeRepr -> #90
    /// (styled leaf item)`.
    #[test]
    fn find_color_in_representation_follows_nested_mapped_items() {
        let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
            #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));\n\
            #20=IFCSHAPEREPRESENTATION($,$,$,(#30));\n\
            #30=IFCMAPPEDITEM(#40,$);\n\
            #40=IFCREPRESENTATIONMAP($,#50);\n\
            #50=IFCSHAPEREPRESENTATION($,$,$,(#60));\n\
            #60=IFCMAPPEDITEM(#70,$);\n\
            #70=IFCREPRESENTATIONMAP($,#80);\n\
            #80=IFCSHAPEREPRESENTATION($,$,$,(#90));\n\
            #90=IFCEXTRUDEDAREASOLID($,$,$,$);\n\
            ENDSEC;\nEND-ISO-10303-21;\n";
        let index = build_entity_index(content);
        let mut decoder = EntityDecoder::with_index(content, index);

        let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
        styles.insert(
            90,
            GeometryStyleInfo {
                color: [1.0, 0.0, 0.0, 1.0],
                shading_color: None,
                material_name: None,
            },
        );

        let color = find_color_in_representation(10, &styles, &mut decoder);
        assert_eq!(
            color,
            Some([1.0, 0.0, 0.0, 1.0]),
            "a styled leaf item two IfcMappedItem hops deep must still resolve — \
             find_color_in_shape_representation must chase nested IfcMappedItem \
             the same way find_color_in_representation's own first hop does, \
             mirroring element::find_geometry_item_color's unbounded recursion"
        );
    }

    /// #2863's cyclic fixture, transplanted to this module's own entry
    /// point: `#30`'s mapped representation lists `#30` itself, so the chase
    /// re-enters where it started. Before the guard this stack-overflows and
    /// SIGABRTs the whole test binary; asserting `None` (not merely "does not
    /// crash") is the only way to see it pass or fail rather than vanish.
    #[test]
    fn find_color_in_representation_terminates_on_cyclic_mapping() {
        let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
            #10=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));\n\
            #20=IFCSHAPEREPRESENTATION($,$,$,(#30));\n\
            #30=IFCMAPPEDITEM(#40,$);\n\
            #40=IFCREPRESENTATIONMAP($,#50);\n\
            #50=IFCSHAPEREPRESENTATION($,$,$,(#30));\n\
            ENDSEC;\nEND-ISO-10303-21;\n";
        let index = build_entity_index(content);
        let mut decoder = EntityDecoder::with_index(content, index);
        let styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
        assert_eq!(find_color_in_representation(10, &styles, &mut decoder), None);
    }

    /// Build a chain of `hops` nested `IfcMappedItem`s under one
    /// `IfcProductDefinitionShape` (`#10`), terminating in a leaf
    /// `IfcShapeRepresentation` (`#9000`) whose own item `#9999` carries the
    /// style. `#9999` is never decoded as an entity — the resolver checks
    /// styles by id before it ever needs to decode the item — so it does not
    /// need its own STEP record.
    fn nested_mapped_chain(hops: u32) -> Vec<u8> {
        let mut s = String::from(
            "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));\n",
        );
        for i in 0..hops {
            let shape = 20 + i * 10;
            let map_item = 21 + i * 10;
            let rep_map = 22 + i * 10;
            let next = if i + 1 == hops { 9000 } else { 20 + (i + 1) * 10 };
            s.push_str(&format!(
                "#{shape}=IFCSHAPEREPRESENTATION($,$,$,(#{map_item}));\n"
            ));
            s.push_str(&format!("#{map_item}=IFCMAPPEDITEM(#{rep_map},$);\n"));
            s.push_str(&format!("#{rep_map}=IFCREPRESENTATIONMAP($,#{next});\n"));
        }
        s.push_str("#9000=IFCSHAPEREPRESENTATION($,$,$,(#9999));\n");
        s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
        s.into_bytes()
    }

    #[test]
    fn find_color_in_representation_resolves_exactly_at_the_depth_cap() {
        let red = [1.0, 0.0, 0.0, 1.0];
        let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
        styles.insert(
            9999,
            GeometryStyleInfo {
                color: red,
                shading_color: None,
                material_name: None,
            },
        );
        let content = nested_mapped_chain(crate::element::MAX_MAPPED_ITEM_DEPTH);
        let index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, index);
        assert_eq!(
            find_color_in_representation(10, &styles, &mut decoder),
            Some(red),
            "a chain exactly MAX_MAPPED_ITEM_DEPTH hops deep must still resolve"
        );
    }

    #[test]
    fn find_color_in_representation_stops_one_hop_past_the_depth_cap() {
        let red = [1.0, 0.0, 0.0, 1.0];
        let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
        styles.insert(
            9999,
            GeometryStyleInfo {
                color: red,
                shading_color: None,
                material_name: None,
            },
        );
        let content = nested_mapped_chain(crate::element::MAX_MAPPED_ITEM_DEPTH + 1);
        let index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, index);
        assert_eq!(
            find_color_in_representation(10, &styles, &mut decoder),
            None,
            "one hop past the cap the chase gives up rather than recursing on"
        );
    }
}
