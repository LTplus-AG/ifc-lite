// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cycle- and depth-guarded spatial-tree assembly, split out of `spatial.rs`
//! (#3965 follow-up): walking `spatial_children_map` into `SpatialNode`s is a
//! self-contained concern once the relationship maps have been built.
//! `spatial_tests.rs` (attached to the parent `spatial` module, not this one)
//! exercises `build_spatial_nodes_recursive` directly via `use super::*`.

use super::spatial_elevation::extract_elevation_if_storey;
use super::super::types::{EntityMetadata, SpatialNode};
use ifc_lite_core::EntityDecoder;
use rustc_hash::{FxHashMap, FxHashSet};

/// Maximum recursion depth for building the spatial tree, mirroring
/// `MAX_SPATIAL_TREE_DEPTH` in `apps/viewer/src/utils/serverDataModel.ts`. This is
/// a second guard beyond the visited set in `build_spatial_nodes_recursive`: a
/// pathologically deep but acyclic aggregation/containment chain could still
/// exhaust the stack even with cycles ruled out.
pub(super) const MAX_SPATIAL_TREE_DEPTH: u16 = 100;

/// Recursively build spatial nodes with full information.
// Threads the full recursion context (maps, caches, accumulators); grouping the
// args into a struct would not change behavior and is out of scope here.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_spatial_nodes_recursive(
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
