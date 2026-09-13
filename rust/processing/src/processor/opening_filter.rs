// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{get_refs_from_list, normalize_optional_string, EntityJob, OpeningFilterMode};
use crate::style::GeometryStyleInfo;
use ifc_lite_core::{EntityDecoder, IfcType, MAX_MAPPED_ITEM_DEPTH};
use rustc_hash::FxHashMap;
use std::collections::HashSet;

/// Apply the opening filter and return which entity IDs to suppress and a filtered void index.
///
/// Returns `(skipped_entity_ids, filtered_void_index)` where:
/// - `skipped_entity_ids` is the set of IfcWindow/IfcDoor entity IDs to omit from geometry output
/// - `filtered_void_index` is the void index with suppressed openings removed from host lists
pub(super) fn apply_opening_filter(
    entity_jobs: &[EntityJob],
    void_index: &FxHashMap<u32, Vec<u32>>,
    filling_by_opening: &FxHashMap<u32, u32>,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    element_material_colors: &FxHashMap<u32, Vec<[f32; 4]>>,
    decoder: &mut EntityDecoder,
    mode: OpeningFilterMode,
) -> (HashSet<u32>, FxHashMap<u32, Vec<u32>>) {
    if mode == OpeningFilterMode::Default {
        return (HashSet::default(), void_index.clone());
    }

    // Collect all IfcWindow / IfcDoor entity jobs.
    let filling_jobs: FxHashMap<u32, &EntityJob> = entity_jobs
        .iter()
        .filter(|job| matches!(job.ifc_type, IfcType::IfcWindow | IfcType::IfcDoor))
        .map(|job| (job.id, job))
        .collect();

    if filling_jobs.is_empty() {
        return (HashSet::default(), void_index.clone());
    }

    let mut skipped_entity_ids: HashSet<u32> = HashSet::default();

    // IgnoreAll: suppress every window/door mesh and clear ALL wall voids.
    // We always clear the full void_index because IfcRelFillsElement is often absent
    // or only partially present, and without it we cannot identify which specific openings
    // belong to windows/doors.
    if mode == OpeningFilterMode::IgnoreAll {
        for &id in filling_jobs.keys() {
            skipped_entity_ids.insert(id);
        }
        return (skipped_entity_ids, FxHashMap::default());
    }

    // IgnoreOpaque: suppress only windows/doors that have no transparent sub-parts.
    // Mesh suppression uses the colours each opening will render with (is_opaque_opening).
    // Void suppression uses IfcRelFillsElement data when available.
    for (&id, job) in &filling_jobs {
        if is_opaque_opening(job, geometry_style_index, element_material_colors, decoder) {
            skipped_entity_ids.insert(id);
        }
    }

    if filling_by_opening.is_empty() {
        // No IfcRelFillsElement — can't map voids to specific window/door entities.
        return (skipped_entity_ids, void_index.clone());
    }

    // Build openings_to_suppress from the explicit opening → filling mapping.
    let mut openings_to_suppress: HashSet<u32> = HashSet::default();
    for (&opening_id, &filling_id) in filling_by_opening {
        if skipped_entity_ids.contains(&filling_id) {
            openings_to_suppress.insert(opening_id);
        }
    }

    if openings_to_suppress.is_empty() {
        return (skipped_entity_ids, void_index.clone());
    }

    let mut filtered: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (&host_id, openings) in void_index {
        let remaining: Vec<u32> = openings
            .iter()
            .copied()
            .filter(|oid| !openings_to_suppress.contains(oid))
            .collect();
        if !remaining.is_empty() {
            filtered.insert(host_id, remaining);
        }
    }

    (skipped_entity_ids, filtered)
}

/// Returns `true` when the entity has no transparent or glass sub-parts,
/// meaning it is an opaque window/door that should be suppressed by `IgnoreOpaque`.
///
/// Any of the following makes it NOT opaque (returns `false`):
/// - Entity name contains "glas" (case-insensitive)
/// - Any associated material colour (#407 chain) has alpha < 1.0
/// - Any item style, through nested mapped items, has alpha < 1.0 or a name
///   containing "glas"
/// - No item is styled, there is no material colour, and the type default is
///   transparent (the colour the element then renders with)
fn is_opaque_opening(
    job: &EntityJob,
    styles: &FxHashMap<u32, GeometryStyleInfo>,
    material_colors: &FxHashMap<u32, Vec<[f32; 4]>>,
    decoder: &mut EntityDecoder,
) -> bool {
    let Ok(entity) = decoder.decode_at(job.start, job.end) else {
        return true;
    };

    // 1. Entity name contains "glas" → glazed.
    if normalize_optional_string(entity.get_string(2))
        .as_deref()
        .map(|n| n.to_lowercase().contains("glas"))
        .unwrap_or(false)
    {
        return false;
    }

    // 2. The filter runs before the metadata phase resolves `job.element_color`
    //    (it still holds the type default), so judge the colours that phase will
    //    use. A transparent material colours any item without its own style as
    //    a glazed sub-mesh (#913); this errs toward keeping an opening whose
    //    every item is styled opaque.
    let materials = material_colors.get(&job.id).map_or(&[][..], Vec::as_slice);
    if materials.iter().any(|c| c[3] < 1.0) {
        return false;
    }
    let unstyled_is_glazed = materials.is_empty() && job.element_color[3] < 1.0;

    // 3. Walk every representation item, through nested mapped items: a glass
    //    style anywhere → glazed; no style anywhere → the rule above decides.
    let Some(repr_ids) = entity
        .get_ref(6)
        .and_then(|shape_id| decoder.decode_by_id(shape_id).ok())
        .and_then(|shape| get_refs_from_list(&shape, 2))
    else {
        return !unstyled_is_glazed;
    };
    let mut pending: Vec<(u32, u32)> = Vec::new();
    for repr_id in repr_ids {
        if let Some(items) = decoder
            .decode_by_id(repr_id)
            .ok()
            .and_then(|repr| get_refs_from_list(&repr, 3))
        {
            pending.extend(items.into_iter().map(|id| (id, 0)));
        }
    }
    match scan_item_styles(pending, styles, decoder) {
        ItemStyles::Glass => false,
        ItemStyles::Styled => true,
        ItemStyles::Unstyled => !unstyled_is_glazed,
    }
}

enum ItemStyles {
    Glass,
    Styled,
    Unstyled,
}

/// Visit `pending` items and everything under them through nested
/// `IfcMappedItem`s, as deep as the colour resolver goes
/// (`MAX_MAPPED_ITEM_DEPTH`). `visited` keeps the depth each item was explored
/// at and allows a revisit only from nearer the root, the rule
/// `element_color::find_geometry_item_color_at` documents.
fn scan_item_styles(
    mut pending: Vec<(u32, u32)>,
    styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> ItemStyles {
    let mut styled = false;
    let mut visited: FxHashMap<u32, u32> = FxHashMap::default();
    while let Some((id, depth)) = pending.pop() {
        if let Some(style) = styles.get(&id) {
            if has_glass_style(style) {
                return ItemStyles::Glass;
            }
            styled = true;
        }
        if depth >= MAX_MAPPED_ITEM_DEPTH || visited.get(&id).is_some_and(|&seen| seen <= depth) {
            continue;
        }
        visited.insert(id, depth);
        // IfcMappedItem → IfcRepresentationMap → MappedRepresentation.Items
        let Ok(item) = decoder.decode_by_id(id) else {
            continue;
        };
        if item.ifc_type != IfcType::IfcMappedItem {
            continue;
        }
        let Some(mapped_repr) = item
            .get_ref(0)
            .and_then(|source_id| decoder.decode_by_id(source_id).ok())
            .and_then(|source| source.get_ref(1))
            .and_then(|repr_id| decoder.decode_by_id(repr_id).ok())
        else {
            continue;
        };
        for child in get_refs_from_list(&mapped_repr, 3).unwrap_or_default() {
            pending.push((child, depth + 1));
        }
    }
    if styled {
        ItemStyles::Styled
    } else {
        ItemStyles::Unstyled
    }
}

/// Returns `true` when a geometry style indicates a glass/transparent material.
///
/// Triggers on:
/// - Any transparency at all (alpha < 1.0)
/// - Style/material name containing "glas" (case-insensitive)
fn has_glass_style(style: &GeometryStyleInfo) -> bool {
    if style.color[3] < 1.0 {
        return true;
    }
    if style
        .material_name
        .as_deref()
        .map(|n| n.to_lowercase().contains("glas"))
        .unwrap_or(false)
    {
        return true;
    }
    false
}
