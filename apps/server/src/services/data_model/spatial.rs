// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Spatial hierarchy extraction.
//!
//! Split across three files (#3965 follow-up, to stay under the module-size
//! ratchet): this file builds the relationship maps (`canonical_parent`,
//! `spatial_children_map`, `element_containment_map`) and drives the
//! orphan-fill pass; `spatial_tree.rs` walks those maps into `SpatialNode`s
//! with the cycle/depth guards; `spatial_elevation.rs` reads
//! `IfcBuildingStorey.Elevation`. `spatial_tests.rs` stays attached to this
//! file and exercises functions from all three via `use super::*` plus the
//! re-exports below.

#[path = "spatial_canonical_parent.rs"]
mod spatial_canonical_parent;
#[path = "spatial_elevation.rs"]
mod spatial_elevation;
#[path = "spatial_invariant.rs"]
mod spatial_invariant;
#[path = "spatial_lookups.rs"]
mod spatial_lookups;
#[path = "spatial_tree.rs"]
mod spatial_tree;

use self::spatial_canonical_parent::resolve_aggregate_canonical_parents;
use self::spatial_elevation::extract_elevation_if_storey;
use self::spatial_lookups::build_element_lookups;
pub(super) use self::spatial_invariant::spatial_hierarchy_consistency_violations;
#[cfg(test)]
pub(super) use self::spatial_canonical_parent::{
    resolve_aggregate_canonical_parents as resolve_aggregate_canonical_parents_for_tests,
    resolve_aggregate_canonical_parents_with_budget,
};
use self::spatial_tree::build_spatial_nodes_recursive;
use super::types::{EntityMetadata, Relationship, SpatialHierarchyData, SpatialNode};
use ifc_lite_core::EntityDecoder;
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::Arc;

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
    // Each spatial child's canonical IFCRELAGGREGATES parent, resolved per
    // child in `spatial_canonical_parent.rs`: plain first-declared-wins,
    // except a candidate that would close an aggregation cycle back through
    // the child is skipped first (#4246 - the same rule as
    // packages/parser/src/spatial-hierarchy-canonical-parent.ts's
    // computeCanonicalParent). The IFCRELCONTAINEDINSPATIALSTRUCTURE
    // promotion below (no Aggregates edge at all, #1075) is layered on top,
    // unaffected by that rule.
    let mut canonical_parent: FxHashMap<u32, u32> =
        resolve_aggregate_canonical_parents(relationships);

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
    // Snapshot the project-reachable node set before rescuing orphans: the
    // first-declared storey ruling below (#4310) only competes among these,
    // matching packages/parser, which never visits an orphan storey.
    let project_reachable: FxHashSet<u32> = nodes_map.keys().copied().collect();

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

    // The orphan-fill loop above pulls a rescued node's `children_ids`
    // straight from `spatial_children_map`, without the same filtering
    // `build_spatial_nodes_recursive` applies to its own node after
    // descending into its children. That reintroduces this PR's own bug one
    // level removed: an entity whose canonical parent is itself an orphan
    // (e.g. a Site never aggregated by Project, canonical-parenting a
    // Building) is skipped by the orphan-fill loop's `canonical_parent`
    // check - correctly, since it does have a parent - but that parent is
    // rescued as a fake root and still lists it in `children_ids`, so the
    // fake root ends up pointing at a child with no `SpatialNode` of its
    // own: the exact dangling-reference shape this fix set out to eliminate.
    // One final pass across every node (recursively-built ones included, as
    // a no-op there) closes this the same way the recursive walker already
    // closes it for its own descent.
    let all_node_ids: FxHashSet<u32> = nodes_map.keys().copied().collect();
    for node in nodes_map.values_mut() {
        node.children_ids
            .retain(|child_id| all_node_ids.contains(child_id));
    }

    // #3973 landed two pointwise fixes for the same defect shape - a fake root
    // (or, before this PR, a resurrected depth-capped node) whose children_ids
    // named an entity absent from nodes_map - each closing one path into the
    // tree (recursive descent, then orphan-fill) without ruling the shape out
    // structurally. Only a release build skips this: the check walks every
    // node once and only runs when debug_assertions are compiled in, exactly
    // like every other debug_assert! in this codebase.
    debug_assert!(
        {
            let values: Vec<&SpatialNode> = nodes_map.values().collect();
            let violations = spatial_hierarchy_consistency_violations(&values);
            if !violations.is_empty() {
                tracing::error!(violations = ?violations, "spatial hierarchy consistency violated");
            }
            violations.is_empty()
        },
        "build_spatial_hierarchy produced an inconsistent tree (see logged violations)"
    );


    let lookups = build_element_lookups(
        relationships,
        &entity_map,
        &nodes_map,
        &project_reachable,
        is_spatial_type,
        is_building_like_spatial_type,
        is_space_like_spatial_type,
    );

    SpatialHierarchyData {
        nodes: nodes_map.into_values().collect(),
        project_id,
        element_to_storey: lookups.storey,
        element_to_building: lookups.building,
        element_to_site: lookups.site,
        element_to_space: lookups.space,
    }
}

#[cfg(test)]
#[path = "spatial_tests.rs"]
mod spatial_tests;
