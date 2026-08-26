// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Colour and material-name resolution for one element's sub-meshes.
//!
//! Split out of `element.rs` under the ~400-line module rule. This half is
//! a pure function of (geometry id, style map) with its own bounded walk;
//! the mesh production it serves stays in `element.rs`.

use crate::processor::get_refs_from_list;
use crate::style::{FullIndexedColourMap, GeometryStyleInfo};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
// Re-exported, not merely imported: the depth-cap test reads it back through
// THIS module so that swapping to a private copy here fails the test. Importing
// it straight from core in the test compares the constant with itself.
pub(crate) use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;
use rustc_hash::FxHashMap;

/// Resolve a geometry item's authored colour: direct style on the item, else
/// chase `IfcMappedItem → IfcRepresentationMap → MappedRepresentation.Items`
/// recursively (#913 §2.7 — mapped sub-geometry inherits its underlying
/// item's style), to at most `MAX_MAPPED_ITEM_DEPTH` hops.
pub(crate) fn find_geometry_item_color(
    geometry_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let mut visited = FxHashMap::default();
    find_geometry_item_color_at(geometry_id, geometry_styles, decoder, 0, &mut visited)
}

/// The visited map is GLOBAL to one resolution, not path-scoped: the geometry
/// router removes each id on the way out because it accumulates geometry per
/// path, whereas a colour is a pure function of the item id and the style map.
///
/// It records the DEPTH each item was explored at and permits a revisit from
/// strictly nearer the root. A plain SET is wrong in combination with the cap:
/// an item first reached near the limit is cut before its subtree is searched
/// yet stays marked, so a later shorter branch that WOULD have resolved is
/// skipped and the colour is silently lost — a wrong value rather than a
/// crash, so nothing reports it (Codex, #2868 review). Work stays bounded: an
/// item is re-explored only from closer to the root, at most
/// `MAX_MAPPED_ITEM_DEPTH` times.
///
/// That matters for more than tidiness. A depth cap alone bounds the chain but
/// not the fan-out: a malformed representation holding `k` items that each
/// lead back into the cycle costs `O(k^depth)` decodes, so four self-references
/// at depth 32 is ~2^64 calls — no stack overflow, just a worker pinned
/// forever. Trading an abort for a hang would not have been a fix (#2863).
fn find_geometry_item_color_at(
    geometry_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
    depth: u32,
    visited: &mut FxHashMap<u32, u32>,
) -> Option<[f32; 4]> {
    // Direct style on this exact geometry item wins.
    if let Some(style) = geometry_styles.get(&geometry_id) {
        return Some(style.color);
    }

    // Otherwise, if it's a mapped item, chase the mapping to the underlying
    // geometry and resolve there (recursing handles nested mapped items).
    // Refuse to go deeper than the cap: a cyclic mapping would otherwise
    // recurse until the stack overflows and the process aborts (#2863).
    if depth >= MAX_MAPPED_ITEM_DEPTH {
        return None;
    }
    match visited.get(&geometry_id) {
        // Explored from here or from CLOSER to the root already: that attempt
        // had at least as much room under the cap, so it cannot find anything
        // new. Skipping is safe, and it is what breaks cycles.
        Some(&seen_at) if seen_at <= depth => return None,
        _ => visited.insert(geometry_id, depth),
    };
    let geom = decoder.decode_by_id(geometry_id).ok()?;
    if geom.ifc_type != IfcType::IfcMappedItem {
        return None;
    }
    // IfcMappedItem.MappingSource (attr 0) → IfcRepresentationMap.
    let mapping_source_id = geom.get_ref(0)?;
    // IfcRepresentationMap.MappedRepresentation (attr 1) → IfcShapeRepresentation.
    let representation_map = decoder.decode_by_id(mapping_source_id).ok()?;
    let mapped_representation_id = representation_map.get_ref(1)?;
    let mapped_representation = decoder.decode_by_id(mapped_representation_id).ok()?;
    // IfcShapeRepresentation.Items (attr 3).
    let items = get_refs_from_list(&mapped_representation, 3)?;
    for underlying in items {
        if let Some(color) =
            find_geometry_item_color_at(underlying, geometry_styles, decoder, depth + 1, visited)
        {
            return Some(color);
        }
    }
    None
}

/// Resolve the authored colour for a type's `IfcRepresentationMap` (#957) by
/// looking up its mapped geometry items in the styled-item index — the same
/// index that colours ordinary products. `None` ⇒ caller falls back to the
/// type's default colour.
pub(crate) fn resolve_color_for_representation_map(
    rep_map_id: u32,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let rep_map = decoder.decode_by_id(rep_map_id).ok()?;
    // IfcRepresentationMap.MappedRepresentation = attr 1.
    let mapped_rep_id = rep_map.get_ref(1)?;
    let mapped_rep = decoder.decode_by_id(mapped_rep_id).ok()?;
    // IfcShapeRepresentation.Items = attr 3.
    let item_ids = get_refs_from_list(&mapped_rep, 3)?;
    for item_id in item_ids {
        if let Some(style) = geometry_style_index.get(&item_id) {
            return Some(style.color);
        }
        if let Some(color) = find_geometry_item_color(item_id, geometry_style_index, decoder) {
            return Some(color);
        }
    }
    None
}

/// Find the first representation item of `entity` that carries a full
/// `IfcIndexedColourMap` (#858). Drives the element-level palette split on
/// the single-mesh fallback path.
pub(crate) fn find_indexed_colour_for_element<'a>(
    entity: &DecodedEntity,
    indexed_colour_full: &'a FxHashMap<u32, FullIndexedColourMap>,
    decoder: &mut EntityDecoder,
) -> Option<&'a FullIndexedColourMap> {
    let pds_id = entity.get_ref(6)?;
    let pds = decoder.decode_by_id(pds_id).ok()?;
    let repr_ids = get_refs_from_list(&pds, 2)?;
    for repr_id in repr_ids {
        if let Ok(repr) = decoder.decode_by_id(repr_id) {
            if let Some(items) = get_refs_from_list(&repr, 3) {
                for item_id in items {
                    if let Some(full) = indexed_colour_full.get(&item_id) {
                        return Some(full);
                    }
                }
            }
        }
    }
    None
}

fn is_opening_with_subparts(ifc_type: &IfcType) -> bool {
    matches!(ifc_type, IfcType::IfcWindow | IfcType::IfcDoor)
}

/// Synthesize a material name for window/door sub-parts that carry no
/// authored style: transparency is a practical proxy for glazing in many BIM
/// exports.
pub(crate) fn infer_opening_subpart_material_name(
    ifc_type: &IfcType,
    color: [f32; 4],
    geometry_id: u32,
) -> Option<String> {
    if !is_opening_with_subparts(ifc_type) {
        return None;
    }

    let prefix = match ifc_type {
        IfcType::IfcDoor => "Door",
        _ => "Window",
    };

    if color[3] <= 0.65 {
        return Some(format!("{}_Glass", prefix));
    }

    Some(format!("{}_Frame_{}", prefix, geometry_id))
}
