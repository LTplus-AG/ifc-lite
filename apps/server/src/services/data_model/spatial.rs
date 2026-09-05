// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Spatial hierarchy extraction.

use super::types::{EntityMetadata, Relationship, SpatialHierarchyData, SpatialNode};
use ifc_lite_core::EntityDecoder;
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::Arc;

/// Maximum recursion depth for building the spatial tree, mirroring
/// `MAX_SPATIAL_TREE_DEPTH` in `apps/viewer/src/utils/serverDataModel.ts`. This is
/// a second guard beyond the visited set in `build_spatial_nodes_recursive`: a
/// pathologically deep but acyclic aggregation/containment chain could still
/// exhaust the stack even with cycles ruled out.
const MAX_SPATIAL_TREE_DEPTH: u16 = 100;

/// Build spatial hierarchy from relationships.
pub(super) fn build_spatial_hierarchy(
    relationships: &[Relationship],
    entities: &[EntityMetadata],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
    length_unit_scale: f64,
) -> SpatialHierarchyData {
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());

    // Build entity map for quick lookup
    let entity_map: FxHashMap<u32, &EntityMetadata> =
        entities.iter().map(|e| (e.entity_id, e)).collect();

    // Types treated as spatial-structure nodes, mirroring
    // packages/data/src/spatial-types.ts's SPATIAL_STRUCTURE_TYPE_ENUMS. IFCSPATIALZONE,
    // IFCMARINEPART and IFCFACILITYPARTCOMMON were missing here (#3965): the TS side has
    // carried them since #1075 (IfcSpatialZone) and #3248/#3249 (the IFC4X3 pair), so an
    // aggregated instance of any of the three already built a node via
    // build_spatial_nodes_recursive's blind children_ids walk - only the orphan-fill loop
    // below and the containment promotion added by #3965 depend on this list.
    let is_spatial_type = |type_name: &str| {
        matches!(
            type_name.to_uppercase().as_str(),
            "IFCPROJECT"
                | "IFCSITE"
                | "IFCBUILDING"
                | "IFCBUILDINGSTOREY"
                | "IFCSPACE"
                | "IFCSPATIALZONE"
                | "IFCFACILITY"
                | "IFCFACILITYPART"
                | "IFCFACILITYPARTCOMMON"
                | "IFCBRIDGE"
                | "IFCBRIDGEPART"
                | "IFCROAD"
                | "IFCROADPART"
                | "IFCRAILWAY"
                | "IFCRAILWAYPART"
                | "IFCMARINEFACILITY"
                | "IFCMARINEPART"
        )
    };
    let is_building_like_spatial_type = |type_name: &str| {
        matches!(
            type_name.to_uppercase().as_str(),
            "IFCBUILDING"
                | "IFCFACILITY"
                | "IFCBRIDGE"
                | "IFCROAD"
                | "IFCRAILWAY"
                | "IFCMARINEFACILITY"
        )
    };
    // Space-like: bucket into element_to_space, mirroring
    // packages/data/src/spatial-types.ts's isSpaceLikeSpatialType (IfcSpace and
    // IfcSpatialZone roll their contained elements up the same way there).
    let is_space_like_spatial_type =
        |type_upper: &str| matches!(type_upper, "IFCSPACE" | "IFCSPATIALZONE");

    // Separate spatial relationships from element containment
    // IFCRELAGGREGATES: spatial parent -> spatial child (Project -> Site -> Building -> Storey)
    // IFCRELCONTAINEDINSPATIALSTRUCTURE: spatial container -> elements (Storey -> Wall, Door,
    // etc.), EXCEPT when the target is itself a spatial-structure type: an IfcSpace or
    // IfcSpatialZone placed under its storey via containment instead of aggregation (the
    // common Revit Family / Dynamo export pattern, #1075) is a tree NODE, not a leaf
    // element, so it is promoted into spatial_children_map instead - mirroring
    // packages/parser/src/spatial-hierarchy-builder.ts's addSpatialChild, which merges
    // aggregated and contained spatial children into one deduped set (#3965).
    let mut spatial_children_map: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut element_containment_map: FxHashMap<u32, Vec<u32>> = FxHashMap::default();

    // Each spatial child gets exactly ONE canonical parent. Without this, a
    // space aggregated under one storey AND contained under a different one
    // (a malformed but real cross-linked authoring-tool export, #3973) would
    // end up in both parents' children_ids, while build_spatial_nodes_recursive
    // only ever builds one SpatialNode for it (a single-visit walk keyed by
    // entity id) - so one parent's children_ids referenced a node that both
    // belonged to another parent AND carried that other parent's parent_id, and
    // which parent "won" depended on relationship-list/HashMap iteration order,
    // not a rule. IfcRelAggregates is the canonical spatial-hierarchy
    // relationship (IFCRELCONTAINEDINSPATIALSTRUCTURE promotion below exists
    // only to cover the case where NO aggregates edge exists at all, #1075), so
    // it always wins; ties within a kind resolve to the first occurrence in
    // file order (`relationships` preserves source/parse order), never a
    // HashMap's iteration order.
    let mut canonical_parent: FxHashMap<u32, u32> = FxHashMap::default();
    for rel in relationships {
        if rel.rel_type.to_uppercase() == "IFCRELAGGREGATES" {
            canonical_parent
                .entry(rel.related_id)
                .or_insert(rel.relating_id);
        }
    }

    for rel in relationships {
        let rel_type_upper = rel.rel_type.to_uppercase();
        if rel_type_upper == "IFCRELAGGREGATES" {
            // Spatial hierarchy: parent -> child spatial nodes. Only the
            // canonical (first-seen) aggregates edge feeds the tree; a
            // duplicate aggregates edge naming a different parent for the same
            // child is dropped rather than adding a second reference to it.
            if canonical_parent.get(&rel.related_id) == Some(&rel.relating_id) {
                spatial_children_map
                    .entry(rel.relating_id)
                    .or_default()
                    .push(rel.related_id);
            }
        } else if rel_type_upper == "IFCRELCONTAINEDINSPATIALSTRUCTURE" {
            let target_is_spatial = entity_map
                .get(&rel.related_id)
                .map(|e| {
                    let target_type_upper = e.type_name.to_uppercase();
                    is_spatial_type(&target_type_upper) && target_type_upper != "IFCPROJECT"
                })
                .unwrap_or(false);
            if target_is_spatial {
                // Promote: a contained spatial child becomes a tree node,
                // unless an IfcRelAggregates edge already claimed it for a
                // (possibly different) parent - aggregation always wins, per
                // canonical_parent above. Dedup against an edge to the same
                // parent so a space that is both aggregated and contained
                // under the same parent isn't listed twice.
                let winner = *canonical_parent
                    .entry(rel.related_id)
                    .or_insert(rel.relating_id);
                if winner == rel.relating_id {
                    let children = spatial_children_map.entry(rel.relating_id).or_default();
                    if !children.contains(&rel.related_id) {
                        children.push(rel.related_id);
                    }
                }
            } else {
                // Element containment: spatial container -> elements
                element_containment_map
                    .entry(rel.relating_id)
                    .or_default()
                    .push(rel.related_id);
            }
        }
    }

    // Find project (root)
    let project_id = entities
        .iter()
        .find(|e| e.type_name.to_uppercase() == "IFCPROJECT")
        .map(|e| e.entity_id)
        .unwrap_or(0);

    // Build all spatial nodes with full information
    let mut nodes_map: FxHashMap<u32, SpatialNode> = FxHashMap::default();

    // Collect all supported spatial entity IDs, including IFC4.3 facility hierarchies.
    let spatial_entity_ids: Vec<u32> = entities
        .iter()
        .filter(|e| is_spatial_type(&e.type_name))
        .map(|e| e.entity_id)
        .collect();

    // Build nodes recursively starting from project. `visited` tracks every
    // entity the walk actually reached, including one excluded for depth
    // (see build_spatial_nodes_recursive) - it survives the call so the
    // orphan-fill loop below can tell "reached and deliberately excluded"
    // apart from "never reached at all".
    let mut visited: FxHashSet<u32> = FxHashSet::default();
    if project_id != 0 {
        build_spatial_nodes_recursive(
            project_id,
            0,
            0,
            "",
            &spatial_children_map,
            &element_containment_map,
            &entity_map,
            &mut decoder,
            &mut nodes_map,
            &mut visited,
            length_unit_scale,
        );
    }

    // Also process any spatial nodes genuinely unreachable from project - not
    // merely absent from `nodes_map`. Two other cases are also absent from it
    // and must NOT be rescued here:
    //   - `visited` but excluded (a depth-capped node itself, or a cyclic
    //     revisit) - it was reached and deliberately dropped, not orphaned;
    //   - named as someone's child in `canonical_parent` but never reached
    //     (a descendant of a depth-capped node: the recursion never got far
    //     enough to even visit it, since it stops before descending past the
    //     cap) - it still structurally belongs to a parent, so leaving the
    //     whole subtree dropped is consistent, not a dangling reference. Only
    //     an entity that is spatial-typed AND has no parent relationship
    //     anywhere in the file is a genuine orphan worth rescuing as a root.
    // Rescuing either of the first two would reinsert a fake root (parent_id:
    // 0, level: 0) while its real parent's children_ids either still names it
    // as a child, or the parent chain above it was intentionally truncated -
    // two representations of the same entity's place in the tree disagreeing.
    for &entity_id in &spatial_entity_ids {
        if visited.contains(&entity_id) || canonical_parent.contains_key(&entity_id) {
            continue;
        }
        if let std::collections::hash_map::Entry::Vacant(e) = nodes_map.entry(entity_id) {
            if let Some(entity) = entity_map.get(&entity_id) {
                let name = entity
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}#{}", entity.type_name, entity_id));

                e.insert(SpatialNode {
                        entity_id,
                        parent_id: 0,
                        level: 0,
                        path: name.clone(),
                        type_name: entity.type_name.clone(),
                        name: entity.name.clone(),
                        elevation: extract_elevation_if_storey(
                            &entity.type_name,
                            entity_id,
                            &mut decoder,
                            length_unit_scale,
                        ),
                        children_ids: spatial_children_map
                            .get(&entity_id)
                            .cloned()
                            .unwrap_or_default(),
                        element_ids: element_containment_map
                            .get(&entity_id)
                            .cloned()
                            .unwrap_or_default(),
                    });
            }
        }
    }

    // Build lookup maps for element containment
    let mut element_to_storey = Vec::new();
    let mut element_to_building = Vec::new();
    let mut element_to_site = Vec::new();
    let mut element_to_space = Vec::new();

    for rel in relationships {
        if rel.rel_type.to_uppercase() == "IFCRELCONTAINEDINSPATIALSTRUCTURE" {
            let spatial_id = rel.relating_id;
            let element_id = rel.related_id;

            // Skip a target that was promoted to a spatial-structure node above: it is
            // not a leaf element, so it has no place in these element_to_* lookups
            // (mirrors containedElements excluding containedSpatialChildren in
            // packages/parser/src/spatial-hierarchy-builder.ts).
            let target_is_spatial = entity_map
                .get(&element_id)
                .map(|e| {
                    let target_type_upper = e.type_name.to_uppercase();
                    is_spatial_type(&target_type_upper) && target_type_upper != "IFCPROJECT"
                })
                .unwrap_or(false);
            if target_is_spatial {
                continue;
            }

            if let Some(spatial_node) = nodes_map.get(&spatial_id) {
                let type_upper = spatial_node.type_name.to_uppercase();
                if type_upper == "IFCBUILDINGSTOREY" {
                    element_to_storey.push((element_id, spatial_id));
                } else if is_building_like_spatial_type(&type_upper) {
                    element_to_building.push((element_id, spatial_id));
                } else if type_upper == "IFCSITE" {
                    element_to_site.push((element_id, spatial_id));
                } else if is_space_like_spatial_type(&type_upper) {
                    element_to_space.push((element_id, spatial_id));
                }
            }
        }
    }

    SpatialHierarchyData {
        nodes: nodes_map.into_values().collect(),
        project_id,
        element_to_storey,
        element_to_building,
        element_to_site,
        element_to_space,
    }
}

/// Recursively build spatial nodes with full information.
// Threads the full recursion context (maps, caches, accumulators); grouping the
// args into a struct would not change behavior and is out of scope here.
#[allow(clippy::too_many_arguments)]
fn build_spatial_nodes_recursive(
    entity_id: u32,
    parent_id: u32,
    level: u16,
    parent_path: &str,
    spatial_children_map: &FxHashMap<u32, Vec<u32>>,
    element_containment_map: &FxHashMap<u32, Vec<u32>>,
    entity_map: &FxHashMap<u32, &EntityMetadata>,
    decoder: &mut EntityDecoder,
    nodes_map: &mut FxHashMap<u32, SpatialNode>,
    visited: &mut FxHashSet<u32>,
    length_unit_scale: f64,
) {
    // Guard against cyclic IfcRelAggregates / promoted-IfcRelContainedInSpatialStructure
    // edges, mirroring `ctx.visited` in
    // `packages/parser/src/spatial-hierarchy-builder.ts`: a revisited node is
    // skipped (left as whatever was already built, if anything) rather than
    // rebuilt and re-descended into, which would otherwise recurse without
    // bound. Unlike the browser path, this recursion runs in a process with
    // `panic = 'abort'`, so an unguarded cycle here is not a catchable panic -
    // it is a stack overflow that SIGABRTs the whole server (#3973: Storey A
    // aggregates Storey B, Storey B "contains" Storey A).
    if visited.contains(&entity_id) {
        return;
    }
    // Mark as visited (considered) BEFORE the depth check below, not after: a
    // node excluded for being too deep must still count as "reached" for the
    // orphan-fill loop's purposes (see build_spatial_hierarchy). Marking it
    // only on the success path left `visited` unable to distinguish "the walk
    // never found this entity at all" (genuinely orphaned, worth rescuing)
    // from "the walk found it and deliberately excluded it" (must stay
    // excluded) - the orphan-fill loop only checked `nodes_map`, which is
    // empty for both cases, so it reinserted every depth-capped entity as a
    // fake root (parent_id: 0, level: 0) with its real children_ids intact -
    // producing a node whose own parent/level said "root" while its parent's
    // children_ids still named it as a child, and letting the Parquet export
    // (which reads `parent_id` as authoritative) render it as a spurious
    // extra root instead of the dropped subtree it actually is.
    visited.insert(entity_id);
    // Guard against a pathologically deep but acyclic chain, mirroring
    // `MAX_SPATIAL_TREE_DEPTH` in `apps/viewer/src/utils/serverDataModel.ts`.
    if level > MAX_SPATIAL_TREE_DEPTH {
        return;
    }

    let entity = match entity_map.get(&entity_id) {
        Some(e) => e,
        None => return,
    };

    let entity_name = entity
        .name
        .as_ref()
        .cloned()
        .unwrap_or_else(|| format!("{}#{}", entity.type_name, entity_id));

    let path = if parent_path.is_empty() {
        entity_name.clone()
    } else {
        format!("{}/{}", parent_path, entity_name)
    };

    // Extract elevation for storeys (with unit scale applied)
    let elevation =
        extract_elevation_if_storey(&entity.type_name, entity_id, decoder, length_unit_scale);

    // Get children and elements
    let children_ids = spatial_children_map
        .get(&entity_id)
        .cloned()
        .unwrap_or_default();
    let element_ids = element_containment_map
        .get(&entity_id)
        .cloned()
        .unwrap_or_default();

    let node = SpatialNode {
        entity_id,
        parent_id,
        level,
        path: path.clone(),
        type_name: entity.type_name.clone(),
        name: entity.name.clone(),
        elevation,
        children_ids: children_ids.clone(),
        element_ids,
    };

    nodes_map.insert(entity_id, node);

    // Recursively process children
    for &child_id in &children_ids {
        build_spatial_nodes_recursive(
            child_id,
            entity_id,
            level + 1,
            &path,
            spatial_children_map,
            element_containment_map,
            entity_map,
            decoder,
            nodes_map,
            visited,
            length_unit_scale,
        );
    }

    // A child that hit the depth cap (or, in principle, any other early
    // return above) is `visited` but was never inserted into `nodes_map`, so
    // it must not remain in this node's own `children_ids` - otherwise this
    // node would point at a child with no SpatialNode of its own, the exact
    // dangling-reference shape the orphan-fill skip above exists to avoid.
    // Two passes (read then write) rather than `retain` because the check
    // needs `nodes_map` immutably while updating this node's own entry in it.
    if let Some(existing_children) = nodes_map.get(&entity_id).map(|n| n.children_ids.clone()) {
        let filtered: Vec<u32> = existing_children
            .into_iter()
            .filter(|child_id| nodes_map.contains_key(child_id))
            .collect();
        if let Some(node) = nodes_map.get_mut(&entity_id) {
            node.children_ids = filtered;
        }
    }
}

/// Attribute index of `IfcBuildingStorey.Elevation`, the same in IFC2X3 and IFC4:
///
/// ```text
/// [0] GlobalId   [1] OwnerHistory    [2] Name            [3] Description
/// [4] ObjectType [5] ObjectPlacement [6] Representation  [7] LongName
/// [8] CompositionType                                    [9] Elevation
/// ```
///
/// This MUST stay in step with `IFC_BUILDING_STOREY_ELEVATION_INDEX` in
/// `packages/data/src/storey-elevation.ts` — the two paths must read the same
/// slot (issue #1841). It previously read 8 (CompositionType, an enum) and fell
/// back to 7 (LongName, a string): both yield no float, so every storey reported
/// no elevation and the UI showed 0.
const STOREY_ELEVATION_INDEX: usize = 9;

/// Attribute index of `IfcBuildingStorey.ObjectPlacement`.
const STOREY_PLACEMENT_INDEX: usize = 5;

/// `IfcLocalPlacement.RelativePlacement` - the storey's own offset from its
/// parent spatial container.
const LOCAL_PLACEMENT_RELATIVE_INDEX: usize = 1;

/// `IfcAxis2Placement3D.Location` - an `IfcCartesianPoint`.
const AXIS_PLACEMENT_LOCATION_INDEX: usize = 0;

/// Extract elevation from an IFCBUILDINGSTOREY entity, in metres.
///
/// Mirrors `SpatialHierarchyBuilder.extractElevation` in `@ifc-lite/parser`:
/// read `Elevation`, and when it is null (common in Revit / ArchiCAD exports,
/// #1289) fall back to the Z of the storey's own `ObjectPlacement`. Both results
/// are raw IFC lengths, so the unit scale applies either way.
fn extract_elevation_if_storey(
    type_name: &str,
    entity_id: u32,
    decoder: &mut EntityDecoder,
    length_unit_scale: f64,
) -> Option<f64> {
    if !type_name.eq_ignore_ascii_case("IFCBUILDINGSTOREY") {
        return None;
    }

    let entity = decoder.decode_by_id(entity_id).ok()?;

    // Read ONLY the Elevation slot. Scanning for "some attribute that parses as
    // a number" would pick up entity references (bare express ids) as bogus
    // elevations, which is the trap `@ifc-lite/parser` documents at #1289.
    let raw = match entity.get_float(STOREY_ELEVATION_INDEX) {
        Some(elevation) => elevation,
        None => {
            let placement_id = entity.get_ref(STOREY_PLACEMENT_INDEX)?;
            extract_placement_elevation(placement_id, decoder)?
        }
    };

    Some(raw * length_unit_scale)
}

/// Resolve a storey's Z from its `ObjectPlacement`, following
/// `IfcLocalPlacement -> RelativePlacement (IfcAxis2Placement3D) -> Location
/// (IfcCartesianPoint).Coordinates[2]`.
///
/// This is the placement RELATIVE to the parent spatial container, matching the
/// semantics of the `Elevation` attribute — deliberately not the absolute world
/// Z, so site-level georeferencing is not folded in. Returns the raw (unscaled)
/// value, or `None` when the chain cannot be resolved.
fn extract_placement_elevation(placement_id: u32, decoder: &mut EntityDecoder) -> Option<f64> {
    let placement = decoder.decode_by_id(placement_id).ok()?;
    let axis_id = placement.get_ref(LOCAL_PLACEMENT_RELATIVE_INDEX)?;

    let axis = decoder.decode_by_id(axis_id).ok()?;
    let location_id = axis.get_ref(AXIS_PLACEMENT_LOCATION_INDEX)?;

    let (_x, _y, z) = decoder.get_cartesian_point_fast(location_id)?;
    Some(z)
}

#[cfg(test)]
#[path = "spatial_tests.rs"]
mod spatial_tests;
