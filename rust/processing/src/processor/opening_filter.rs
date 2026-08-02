// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{get_refs_from_list, normalize_optional_string, EntityJob, OpeningFilterMode};
use crate::style::GeometryStyleInfo;
use ifc_lite_core::{EntityDecoder, IfcType};
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
    // Mesh suppression uses element color + style traversal (is_opaque_opening).
    // Void suppression uses IfcRelFillsElement data when available.
    for (&id, job) in &filling_jobs {
        if is_opaque_opening(job, geometry_style_index, decoder) {
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
/// - Resolved element color has any transparency (alpha < 1.0)
/// - Any sub-geometry style has alpha < 1.0 or a material/style name containing "glas"
fn is_opaque_opening(
    job: &EntityJob,
    styles: &FxHashMap<u32, GeometryStyleInfo>,
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

    // 2. Resolved element color has any transparency → glazed.
    //    Covers IfcWindow entities using their default colour ([0.6, 0.8, 1.0, 0.4])
    //    and any entity whose explicit surface style resolved to a transparent colour.
    if job.element_color[3] < 1.0 {
        return false;
    }

    let Some(product_shape_id) = entity.get_ref(6) else {
        return true; // No shape info — treat as opaque
    };

    let Ok(product_shape) = decoder.decode_by_id(product_shape_id) else {
        return true;
    };

    let Some(repr_ids) = get_refs_from_list(&product_shape, 2) else {
        return true;
    };

    for repr_id in repr_ids {
        let Ok(repr) = decoder.decode_by_id(repr_id) else {
            continue;
        };
        let Some(item_ids) = get_refs_from_list(&repr, 3) else {
            continue;
        };
        for item_id in item_ids {
            // Direct style on item
            if let Some(style) = styles.get(&item_id) {
                if has_glass_style(style) {
                    return false;
                }
            }

            // Mapped items: IfcMappedItem → IfcRepresentationMap → IfcRepresentation → items
            if let Ok(item) = decoder.decode_by_id(item_id) {
                if item.ifc_type == IfcType::IfcMappedItem {
                    if let Some(source_id) = item.get_ref(0) {
                        if let Ok(source) = decoder.decode_by_id(source_id) {
                            if let Some(mapped_repr_id) = source.get_ref(1) {
                                if let Ok(mapped_repr) = decoder.decode_by_id(mapped_repr_id) {
                                    if let Some(mapped_items) = get_refs_from_list(&mapped_repr, 3)
                                    {
                                        for mapped_item_id in mapped_items {
                                            if let Some(style) = styles.get(&mapped_item_id) {
                                                if has_glass_style(style) {
                                                    return false;
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
        }
    }

    true // No glass found → opaque
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
