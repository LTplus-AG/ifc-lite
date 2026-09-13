// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `color_layer.rs`.
//!
//! A sibling `_tests.rs` rather than an inline `#[cfg(test)] mod tests`: the
//! module-size ratchet counts every line of a production file, test code
//! included, and `color_layer.rs` crossed 400 when the presentation-layer
//! walk got its bounds. Splitting is what AGENTS.md asks for here; the
//! allowlist is the fallback.

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
    let content = nested_mapped_chain(ifc_lite_core::MAX_MAPPED_ITEM_DEPTH);
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
    let content = nested_mapped_chain(ifc_lite_core::MAX_MAPPED_ITEM_DEPTH + 1);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    assert_eq!(
        find_color_in_representation(10, &styles, &mut decoder),
        None,
        "one hop past the cap the chase gives up rather than recursing on"
    );
}

/// Build an `IfcProductDefinitionShape` whose body is `hops` nested
/// `IfcMappedItem` indirections, with the presentation layer assigned to the
/// LEAF representation so only a walk that reaches the bottom finds it.
///
/// Strided so the three id spaces cannot overlap at any chain length. A
/// `1000 + i` / `2000 + i` / `3000 + i` scheme collides past 1000 hops, and a
/// collided fixture silently stops being a deep chain at all: at 4096 hops it
/// passed against a deliberately broken walk, which is a test that cannot fail.
fn layer_repr_id(i: u32) -> u32 {
    10 * i + 1
}

fn nested_layer_chain(hops: u32) -> (String, u32) {
    let item = |i: u32| 10 * i + 2;
    let map = |i: u32| 10 * i + 3;

    let mut s = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    s.push_str(&format!(
        "#7=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));\n",
        layer_repr_id(0)
    ));
    for i in 0..hops {
        s.push_str(&format!(
            "#{}=IFCSHAPEREPRESENTATION($,$,$,(#{}));\n",
            layer_repr_id(i),
            item(i)
        ));
        s.push_str(&format!("#{}=IFCMAPPEDITEM(#{},$);\n", item(i), map(i)));
        s.push_str(&format!(
            "#{}=IFCREPRESENTATIONMAP($,#{});\n",
            map(i),
            layer_repr_id(i + 1)
        ));
    }
    s.push_str(&format!(
        "#{}=IFCSHAPEREPRESENTATION($,$,$,());\n",
        layer_repr_id(hops)
    ));
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    (s, layer_repr_id(hops))
}

/// Resolve with a layer assigned to `labelled`. Pass an id no entity uses to
/// mean "this file assigns no layer at all".
fn layer_of(content: &str, labelled: u32) -> Option<String> {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content.as_bytes(), index);
    let mut layers: FxHashMap<u32, String> = FxHashMap::default();
    layers.insert(labelled, "L".to_string());
    let mut cache: FxHashMap<u32, Option<String>> = FxHashMap::default();
    resolve_presentation_layer_for_product_definition_shape(7, &layers, &mut cache, &mut decoder)
}

/// The walk used to recurse, so a long chain of DISTINCT ids overflowed the
/// stack and took SIGABRT with it: not a catchable panic, and in the wasm
/// geometry worker it kills the instance. Reproduced on 60 000 links, 6.9 MB.
///
/// The assertion is that the layer RESOLVES, not merely that the call returns.
/// A depth cap would also return here, by giving up and reporting no layer on
/// a file no exporter would call malformed. Being iterative, this walk has no
/// depth to give up at.
#[test]
fn resolve_presentation_layer_follows_a_long_acyclic_chain() {
    let (ifc, leaf) = nested_layer_chain(4096);
    assert_eq!(
        layer_of(&ifc, leaf),
        Some("L".to_string()),
        "a 4096-hop chain must resolve its layer, not overflow and not give up"
    );
}

/// A cycle is bounded by the visited set alone once there is no call stack to
/// protect. Four items each leading back into the same representation is also
/// the fan-out shape that costs `k^depth` under a depth-only guard.
#[test]
fn resolve_presentation_layer_terminates_on_cyclic_fan_out() {
    let ifc = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#100));\n\
        #100=IFCSHAPEREPRESENTATION($,$,$,(#201,#202,#203,#204));\n\
        #201=IFCMAPPEDITEM(#301,$);\n\
        #202=IFCMAPPEDITEM(#302,$);\n\
        #203=IFCMAPPEDITEM(#303,$);\n\
        #204=IFCMAPPEDITEM(#304,$);\n\
        #301=IFCREPRESENTATIONMAP($,#100);\n\
        #302=IFCREPRESENTATIONMAP($,#100);\n\
        #303=IFCREPRESENTATIONMAP($,#100);\n\
        #304=IFCREPRESENTATIONMAP($,#100);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    assert_eq!(layer_of(ifc, 9_999_999), None);
}

/// First match wins, so WHICH layer is returned depends on traversal order,
/// and the iterative rewrite has to reproduce the recursive one exactly.
///
/// `#100` holds two items. Item `#201` is a mapped item whose target `#110`
/// carries layer "DEEP"; item `#202` carries layer "FLAT" directly. Document
/// order plus depth-first means `#201`'s subtree is searched before `#202` is
/// examined at all, so "DEEP" wins. A breadth-first walk, or one that tested
/// every item's own layer before descending into any of them, returns "FLAT".
#[test]
fn the_first_match_is_the_one_document_order_reaches_first() {
    let ifc = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#100));\n\
        #100=IFCSHAPEREPRESENTATION($,$,$,(#201,#202));\n\
        #201=IFCMAPPEDITEM(#301,$);\n\
        #301=IFCREPRESENTATIONMAP($,#110);\n\
        #110=IFCSHAPEREPRESENTATION($,$,$,());\n\
        #202=IFCEXTRUDEDAREASOLID($,$,$,$);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let index = build_entity_index(ifc);
    let mut decoder = EntityDecoder::with_index(ifc.as_bytes(), index);
    let mut layers: FxHashMap<u32, String> = FxHashMap::default();
    layers.insert(110, "DEEP".to_string());
    layers.insert(202, "FLAT".to_string());
    let mut cache: FxHashMap<u32, Option<String>> = FxHashMap::default();
    assert_eq!(
        resolve_presentation_layer_for_product_definition_shape(7, &layers, &mut cache, &mut decoder),
        Some("DEEP".to_string()),
        "depth-first in document order: the first item's subtree outranks a later sibling"
    );
}

/// A miss explores the whole reachable closure, so `None` is the true answer
/// for every representation the walk touched, not an artefact of where it
/// started. Memoising all of them is what stops a shared library
/// representation being re-walked once per element.
///
/// This is the property the first attempt at this fix got wrong in the other
/// direction: it carried a "truncated" bit up the return path and declined to
/// memoise anything on a capped walk, which left the cache EMPTY for the whole
/// model and turned a 100k-decode load into a 3.2M-decode one.
#[test]
fn a_miss_memoises_every_representation_it_explored() {
    let (ifc, leaf) = nested_layer_chain(6);
    let index = build_entity_index(&ifc);
    let mut decoder = EntityDecoder::with_index(ifc.as_bytes(), index);
    let layers: FxHashMap<u32, String> = FxHashMap::default();
    let mut cache: FxHashMap<u32, Option<String>> = FxHashMap::default();

    assert_eq!(
        resolve_presentation_layer_for_product_definition_shape(7, &layers, &mut cache, &mut decoder),
        None
    );
    for i in 0..=6 {
        assert_eq!(
            cache.get(&layer_repr_id(i)),
            Some(&None),
            "representation {} was explored to exhaustion and must be memoised",
            layer_repr_id(i)
        );
    }
    assert_eq!(cache.get(&leaf), Some(&None));
}

/// A hit memoises every representation on the path to it, not only the root.
///
/// Mapped-item instancing gives each occurrence its OWN root
/// `IfcShapeRepresentation`; what the occurrences share is the subtree below
/// the `IfcRepresentationMap`. Memoising the root alone would re-walk that
/// shared subtree once per occurrence, which is what the first cut of this
/// rewrite did. The fixture is two occurrences of one map target.
#[test]
fn a_hit_memoises_the_whole_path_so_a_sibling_occurrence_is_a_lookup() {
    let ifc = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #8=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));\n\
        #11=IFCSHAPEREPRESENTATION($,$,$,(#12));\n\
        #12=IFCMAPPEDITEM(#13,$);\n\
        #21=IFCSHAPEREPRESENTATION($,$,$,(#22));\n\
        #22=IFCMAPPEDITEM(#13,$);\n\
        #13=IFCREPRESENTATIONMAP($,#500);\n\
        #500=IFCSHAPEREPRESENTATION($,$,$,(#510));\n\
        #510=IFCMAPPEDITEM(#511,$);\n\
        #511=IFCREPRESENTATIONMAP($,#501);\n\
        #501=IFCSHAPEREPRESENTATION($,$,$,());\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let index = build_entity_index(ifc);
    let mut decoder = EntityDecoder::with_index(ifc.as_bytes(), index);
    let mut layers: FxHashMap<u32, String> = FxHashMap::default();
    layers.insert(501, "L".to_string());
    let mut cache: FxHashMap<u32, Option<String>> = FxHashMap::default();

    assert_eq!(
        resolve_presentation_layer_for_product_definition_shape(7, &layers, &mut cache, &mut decoder),
        Some("L".to_string())
    );
    for id in [11, 500, 501] {
        assert_eq!(
            cache.get(&id),
            Some(&Some("L".to_string())),
            "representation #{id} is on the hit path and must be memoised"
        );
    }

    // The second occurrence enters at its own root #21, whose first hop is
    // the shared #500. With #500 memoised this resolves without expanding
    // #500's subtree; the assertion on the cache is what makes that visible.
    let before = cache.len();
    assert_eq!(
        resolve_presentation_layer_for_product_definition_shape(8, &layers, &mut cache, &mut decoder),
        Some("L".to_string())
    );
    assert_eq!(
        cache.len(),
        before + 1,
        "only the new root #21 should be added; the shared subtree was a cache hit"
    );
}

/// A hit also memoises `None` for every representation the walk explored and
/// missed on the way. Here the shared map target `#500` (and its child `#501`)
/// is expanded and exhausted BEFORE the later sibling item `#14` carries the
/// layer, so neither is on the hit chain. Without the `None`s, the second
/// occurrence re-decodes `#500`'s whole subtree on every resolve.
#[test]
fn a_hit_memoises_none_for_the_exhausted_subtrees_it_passed() {
    let ifc = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
        #8=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));\n\
        #11=IFCSHAPEREPRESENTATION($,$,$,(#12,#14));\n\
        #12=IFCMAPPEDITEM(#13,$);\n\
        #14=IFCEXTRUDEDAREASOLID($,$,$,$);\n\
        #21=IFCSHAPEREPRESENTATION($,$,$,(#22,#24));\n\
        #22=IFCMAPPEDITEM(#13,$);\n\
        #24=IFCEXTRUDEDAREASOLID($,$,$,$);\n\
        #13=IFCREPRESENTATIONMAP($,#500);\n\
        #500=IFCSHAPEREPRESENTATION($,$,$,(#510));\n\
        #510=IFCMAPPEDITEM(#511,$);\n\
        #511=IFCREPRESENTATIONMAP($,#501);\n\
        #501=IFCSHAPEREPRESENTATION($,$,$,());\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let index = build_entity_index(ifc);
    let mut decoder = EntityDecoder::with_index(ifc.as_bytes(), index);
    let mut layers: FxHashMap<u32, String> = FxHashMap::default();
    layers.insert(14, "L".to_string());
    layers.insert(24, "L".to_string());
    let mut cache: FxHashMap<u32, Option<String>> = FxHashMap::default();

    assert_eq!(
        resolve_presentation_layer_for_product_definition_shape(7, &layers, &mut cache, &mut decoder),
        Some("L".to_string())
    );
    assert_eq!(cache.get(&11), Some(&Some("L".to_string())), "the root is on the hit chain");
    for id in [500, 501] {
        assert_eq!(
            cache.get(&id),
            Some(&None),
            "#{id} was explored to exhaustion before the hit and must be memoised as None"
        );
    }
}
