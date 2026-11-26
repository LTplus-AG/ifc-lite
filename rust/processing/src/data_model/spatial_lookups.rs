/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The element -> spatial-container lookup tables of `SpatialHierarchyData`
//! (`element_to_storey` and friends), split out of `spatial.rs` for the
//! module-size ratchet. Built after the node tree so the storey ruling can
//! tell a project-reachable storey from a rescued orphan (#4310).

use super::super::types::{EntityMetadata, Relationship, SpatialNode};
use rustc_hash::{FxHashMap, FxHashSet};

pub(super) struct ElementLookups {
    pub storey: Vec<(u32, u32)>,
    pub building: Vec<(u32, u32)>,
    pub site: Vec<(u32, u32)>,
    pub space: Vec<(u32, u32)>,
}

/// `IFCRELCONTAINEDINSPATIALSTRUCTURE` pairs bucketed by container type.
/// `project_reachable` is the node set BEFORE orphan rescue; only those
/// storeys compete for the first-declared storey slot.
pub(super) fn build_element_lookups(
    relationships: &[Relationship],
    entity_map: &FxHashMap<u32, &EntityMetadata>,
    nodes_map: &FxHashMap<u32, SpatialNode>,
    project_reachable: &FxHashSet<u32>,
    is_spatial_type: impl Fn(&str) -> bool,
    is_building_like_spatial_type: impl Fn(&str) -> bool,
    is_space_like_spatial_type: impl Fn(&str) -> bool,
) -> ElementLookups {
    let mut element_to_storey = Vec::new();
    let mut element_to_building = Vec::new();
    let mut element_to_site = Vec::new();
    let mut element_to_space = Vec::new();

    // #4310 parity: `packages/parser`'s `elementToStorey` resolves a malformed
    // file naming the same element in more than one `IfcRelContainedInSpatialStructure`
    // edge (two different storeys both containing the same wall) to the
    // FIRST-declared edge, matching `packages/query`'s `containedIn()`. Before
    // this fix, `element_to_storey` here just pushed every matching relation
    // pair in file order with no winner picked at this layer at all - the
    // Parquet lookup table then carried BOTH `(element, StoreyA)` and
    // `(element, StoreyB)` rows, and `packages/server-client`'s
    // `data-model-decoder.ts` flattens that table into a `Map` with a plain
    // forward `for` loop and unconditional `map.set`, so the LAST row in file
    // order silently won - the opposite of the ruling. Deduping to the
    // first-declared row here, before serialization, makes that flattening
    // step correct regardless of its own iteration order and keeps this one
    // lookup table consistent with the wasm/parser path's `elementToStorey`.
    //
    // Only storeys reachable from IfcProject compete for the first-declared
    // slot - packages/parser never visits a rescued orphan storey, so an
    // orphan declared before a reachable storey must not claim the element
    // there either. An element contained ONLY in orphan storeys still keeps
    // its first-declared orphan row (the orphan is a rescued root here, and
    // dropping the row would lose data the parser has no equivalent for).
    let mut storey_claimed: FxHashSet<u32> = FxHashSet::default();
    let mut orphan_storey_claimed: FxHashSet<u32> = FxHashSet::default();
    let mut element_to_orphan_storey: Vec<(u32, u32)> = Vec::new();

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
                    // First-declared wins: an element already claimed by an
                    // earlier-declared storey ignores every later-declared one.
                    if !project_reachable.contains(&spatial_id) {
                        if orphan_storey_claimed.insert(element_id) {
                            element_to_orphan_storey.push((element_id, spatial_id));
                        }
                    } else if storey_claimed.insert(element_id) {
                        element_to_storey.push((element_id, spatial_id));
                    }
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

    // #11468 parity with `packages/parser`'s `elementToStorey`: the aggregated
    // parts of a directly contained element are on its storey, and so is an
    // element contained in an IfcSpace/IfcSpatialZone that a project-reachable
    // storey aggregates (the space may be nested in another space), with its
    // parts. Direct containment in a reachable storey wins, so this runs after
    // those rows are in. The walk goes through space-like nodes only. An
    // element reached through spaces on several storeys goes to the lowest
    // storey id; the parser applies the same rule.
    claim_through_spaces(
        relationships,
        nodes_map,
        project_reachable,
        &element_to_space,
        &is_space_like_spatial_type,
        &mut element_to_storey,
    );

    // Orphan-only elements keep their first-declared orphan storey. They go in
    // after the space claim: the parser never visits an orphan storey, so a
    // reachable storey reached through a space wins over it there too.
    let claimed: FxHashSet<u32> = element_to_storey.iter().map(|(e, _)| *e).collect();
    for (element_id, spatial_id) in element_to_orphan_storey {
        if !claimed.contains(&element_id) {
            element_to_storey.push((element_id, spatial_id));
        }
    }

    ElementLookups {
        storey: element_to_storey,
        building: element_to_building,
        site: element_to_site,
        space: element_to_space,
    }
}

fn claim_through_spaces(
    relationships: &[Relationship],
    nodes_map: &FxHashMap<u32, SpatialNode>,
    project_reachable: &FxHashSet<u32>,
    element_to_space: &[(u32, u32)],
    is_space_like_spatial_type: &impl Fn(&str) -> bool,
    element_to_storey: &mut Vec<(u32, u32)>,
) {
    let mut parts: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for rel in relationships {
        if rel.rel_type.eq_ignore_ascii_case("IFCRELAGGREGATES") {
            parts.entry(rel.relating_id).or_default().push(rel.related_id);
        }
    }
    // `owned` holds every element that already has a storey row; it is also the
    // visited set of the part walks, so a cycle or a shared part stops there.
    let mut owned: FxHashSet<u32> = element_to_storey.iter().map(|(e, _)| *e).collect();
    // The aggregated parts of a directly contained element are on its storey
    // (packages/parser propagates it to them), so they get that row first and
    // the space claim below cannot hand them to another storey. Walked in row
    // order, so a part shared by two parents takes the first-declared one.
    let direct_rows = element_to_storey.len();
    for i in 0..direct_rows {
        let (element_id, storey) = element_to_storey[i];
        claim_parts(element_id, storey, &parts, &mut owned, element_to_storey);
    }

    let mut elements_in_space: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (element_id, space_id) in element_to_space {
        elements_in_space.entry(*space_id).or_default().push(*element_id);
    }
    if elements_in_space.is_empty() {
        return;
    }
    let mut storeys: Vec<u32> = project_reachable
        .iter()
        .copied()
        .filter(|id| {
            nodes_map
                .get(id)
                .is_some_and(|n| n.type_name.eq_ignore_ascii_case("IFCBUILDINGSTOREY"))
        })
        .collect();
    // Lowest storey id first, so it wins an element reached from several storeys.
    storeys.sort_unstable();
    let mut visited: FxHashSet<u32> = FxHashSet::default();
    for storey in storeys {
        let mut pending: Vec<u32> = nodes_map[&storey].children_ids.clone();
        while let Some(id) = pending.pop() {
            let Some(node) = nodes_map.get(&id) else { continue };
            if !is_space_like_spatial_type(&node.type_name.to_uppercase()) || !visited.insert(id) {
                continue;
            }
            for element_id in elements_in_space.get(&id).into_iter().flatten() {
                if owned.insert(*element_id) {
                    element_to_storey.push((*element_id, storey));
                    claim_parts(*element_id, storey, &parts, &mut owned, element_to_storey);
                }
            }
            pending.extend(node.children_ids.iter().copied());
        }
    }
}

/// Give every not-yet-owned aggregated descendant of `root` a row on `storey`.
fn claim_parts(
    root: u32,
    storey: u32,
    parts: &FxHashMap<u32, Vec<u32>>,
    owned: &mut FxHashSet<u32>,
    element_to_storey: &mut Vec<(u32, u32)>,
) {
    let mut pending = vec![root];
    while let Some(id) = pending.pop() {
        for kid in parts.get(&id).into_iter().flatten() {
            if owned.insert(*kid) {
                element_to_storey.push((*kid, storey));
                pending.push(*kid);
            }
        }
    }
}
