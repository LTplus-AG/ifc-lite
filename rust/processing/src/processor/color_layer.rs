// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{get_refs_from_list, normalize_optional_string};
use crate::style::GeometryStyleInfo;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::{FxHashMap, FxHashSet};

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

pub(crate) fn resolve_element_color_for_product_definition_shape(
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
        ) {
            return Some(layer_name);
        }
    }

    None
}

/// One unit of pending work. `IfcPresentationLayerAssignment.AssignedItems` is
/// a SELECT over both representations and representation items, so the walk
/// has to be able to test either.
enum Step {
    Representation { id: u32, parent: Option<u32> },
    Item { item_id: u32, owner: u32 },
}

/// Memoise a hit: `Some(layer)` for `start` and every representation on the
/// path that led to it, `None` for every other representation the walk
/// visited.
///
/// The chain is sound because the walk is depth-first in document order and
/// returns on the FIRST match: for each ancestor, everything earlier in its
/// own traversal order was explored and missed, so this hit is that ancestor's
/// first match too. The `None`s are sound because the stack is LIFO: a hit
/// while a representation's items were still pending could only have come
/// from inside its subtree, which puts it on the chain. So anything visited
/// and NOT on the chain was explored to exhaustion.
///
/// Both halves are what the recursive version got for free on unwind, and both
/// matter for mapped-item instancing, where every occurrence has its own root
/// and what they share is the subtree below the map.
fn memoise_hit(
    start: u32,
    layer: &str,
    parent_of: &FxHashMap<u32, u32>,
    visited: FxHashSet<u32>,
    cache_by_representation: &mut FxHashMap<u32, Option<String>>,
) {
    let mut chain: FxHashSet<u32> = FxHashSet::default();
    let mut at = Some(start);
    while let Some(id) = at {
        chain.insert(id);
        at = parent_of.get(&id).copied();
    }
    for id in visited {
        let answer = chain.contains(&id).then(|| layer.to_string());
        cache_by_representation.insert(id, answer);
    }
}

/// Resolve the presentation layer for one `IfcRepresentation`, chasing
/// `IfcMappedItem` -> `IfcRepresentationMap` -> `MappedRepresentation`.
///
/// ITERATIVE, deliberately. The reference graph comes from the file, so it is
/// exporter- and attacker-controlled, and this walk used to recurse with only
/// a path-scoped cycle guard. A visited set bounds cycles and revisits but not
/// a long ACYCLIC chain: every insert succeeds, the guard never fires, and the
/// stack still overflows. A Rust stack overflow is SIGABRT, not a catchable
/// panic, so nothing upstream turns it into a load error and in the wasm
/// geometry worker it takes the instance down. Reproduced on 6.9 MB of
/// well-formed IFC: 60 000 nested mapped items, every id distinct.
///
/// AGENTS.md asks for this shape over a depth cap, and the reason applies
/// exactly here: with no call stack to consume there is nothing left for a cap
/// to protect, and the visited set becomes sufficient on its own. A cap would
/// also have to answer "what is a legitimate nesting depth", and answering it
/// wrong loses a layer silently on a file no exporter would call malformed.
/// `appearance::evaluated_source::validate_style_tree` walks a comparable
/// graph the same way.
///
/// Work is bounded without a budget: each representation is expanded at most
/// once, and items are pushed only from a representation being expanded for
/// the first time, so the total is at most the number of item references in
/// the file.
///
/// Traversal order is the document order the recursive version had, and it is
/// load-bearing because the first match wins: a file may assign layers at more
/// than one depth. Items are pushed in reverse so the first pops first, and
/// pushing a mapped item's target representation on top descends into it
/// before the next sibling item is examined.
fn resolve_presentation_layer_name(
    root_representation_id: u32,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
) -> Option<String> {
    if let Some(cached) = cache_by_representation.get(&root_representation_id) {
        return cached.clone();
    }

    let mut visited: FxHashSet<u32> = FxHashSet::default();
    // Recorded at pop time, not push time: the same representation can be
    // pushed by two different items before either is popped, and the parent
    // that counts is the one whose step was actually taken.
    let mut parent_of: FxHashMap<u32, u32> = FxHashMap::default();
    let mut stack = vec![Step::Representation { id: root_representation_id, parent: None }];

    while let Some(step) = stack.pop() {
        match step {
            Step::Representation { id: representation_id, parent } => {
                if !visited.insert(representation_id) {
                    continue;
                }
                if let Some(parent) = parent {
                    parent_of.insert(representation_id, parent);
                }

                match cache_by_representation.get(&representation_id) {
                    // Explored to exhaustion by an earlier element, so this is
                    // the whole subtree's answer, not a partial one.
                    Some(Some(layer_name)) => {
                        let hit = layer_name.clone();
                        memoise_hit(representation_id, &hit, &parent_of, visited, cache_by_representation);
                        return Some(hit);
                    }
                    Some(None) => continue,
                    None => {}
                }

                if let Some(layer_name) = layer_by_assigned_representation.get(&representation_id) {
                    let hit = layer_name.clone();
                    memoise_hit(representation_id, &hit, &parent_of, visited, cache_by_representation);
                    return Some(hit);
                }

                let Ok(representation) = decoder.decode_by_id(representation_id) else {
                    continue;
                };
                let Some(items) = get_refs_from_list(&representation, 3) else {
                    continue;
                };
                for item_id in items.into_iter().rev() {
                    stack.push(Step::Item { item_id, owner: representation_id });
                }
            }
            Step::Item { item_id, owner } => {
                if let Some(layer_name) = layer_by_assigned_representation.get(&item_id) {
                    let hit = layer_name.clone();
                    memoise_hit(owner, &hit, &parent_of, visited, cache_by_representation);
                    return Some(hit);
                }

                let Ok(item) = decoder.decode_by_id(item_id) else {
                    continue;
                };
                if item.ifc_type != IfcType::IfcMappedItem {
                    continue;
                }
                let Some(mapping_source_id) = item.get_ref(0) else {
                    continue;
                };
                let Ok(mapping_source) = decoder.decode_by_id(mapping_source_id) else {
                    continue;
                };
                let Some(mapped_representation_id) = mapping_source.get_ref(1) else {
                    continue;
                };
                stack.push(Step::Representation { id: mapped_representation_id, parent: Some(owner) });
            }
        }
    }

    // The walk ran to exhaustion, so every representation it reached had its
    // whole closure searched. `None` is the true answer for all of them, not
    // an artefact of where the walk started, and memoising the lot is what
    // keeps a shared library representation from being re-walked per element.
    for representation_id in visited {
        cache_by_representation.insert(representation_id, None);
    }

    None
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
#[path = "color_layer_tests.rs"]
mod tests;
