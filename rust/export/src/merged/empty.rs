// SPDX-License-Identifier: MPL-2.0
//! Drop spatial containers that end up holding nothing — the step of
//! IfcOpenShell/BlenderBIM's "Merge Projects" recipe that container *matching*
//! ([`super::spatial`]) leaves behind (issue #3643).
//!
//! An `IfcSite` / `IfcBuilding` / `IfcBuildingStorey` / `IfcSpace` is empty when
//! it contains no surviving element (`IfcRelContainedInSpatialStructure`),
//! directly aggregates no surviving non-spatial object, and transitively
//! aggregates no non-empty spatial child. `IfcProject` is never a candidate.
//!
//! Emptiness is a property of the MERGED model, not of one input: a site that is
//! empty in its own file is not empty once a later model's storeys are unified
//! onto it. So this runs as a pre-pass over every model — after visibility
//! filtering and after spatial unification, the two things that make a container
//! empty in the first place — and yields the per-model express ids the emit loop
//! then never writes. Nothing is emitted referencing them, so there is no
//! dangling-reference clean-up pass to follow (which is the whole reason this
//! belongs in the merge rather than after it).
//!
//! A dropped container's own placement / representation entities are left behind
//! unreferenced: valid STEP, just inert. Chasing them is not worth a second
//! graph walk.

use std::collections::{HashMap, HashSet};

use super::guid::extract_global_id_fast;
use super::line_edit::{arg_refs, classify_refs, RefSlot};
use super::plan::{next_offset, resolve_included, unify_spatial, ModelIndex};
use super::spatial::{nth_attr, ContainerMergeStrategy, SpatialLookup, StoreyMergeStrategy};
use super::units::ModelUnitMode;
use super::{MergedModel, MergedOptions};

/// Spatial container types that are dropped when they end up empty. `IfcProject`
/// is deliberately absent: it is the file's root, never a candidate.
const CONTAINER_TYPES: [&str; 4] =
    ["IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE"];

/// A container in the MERGED model: the (model index, express id) of the first
/// instance, so every input's copy of a unified container maps to one node.
type Node = (usize, u32);

/// Inputs the pre-pass needs to reproduce the emit loop's unification verdicts.
struct DropCtx<'a> {
    spatial_lookup: &'a SpatialLookup,
    merge_sites: ContainerMergeStrategy,
    merge_buildings: ContainerMergeStrategy,
    merge_storeys: StoreyMergeStrategy,
    /// Per model: whether it unifies into the first model (same verdict the emit
    /// loop uses, from `units::resolve_model_modes`).
    compatible: &'a [bool],
}

/// Which containers the emit loop must not write.
pub(super) struct DropPlan {
    /// Per input model: local express ids never emitted.
    pub(super) per_model: Vec<HashSet<u32>>,
    /// Containers dropped, counted in the MERGED model (a container unified
    /// across three inputs counts once).
    pub(super) count: usize,
}

/// The merged-model container graph accumulated across every input.
#[derive(Default)]
struct Graph {
    /// Every container node seen.
    nodes: HashSet<Node>,
    /// Nodes holding a surviving non-spatial object (element or aggregate).
    has_content: HashSet<Node>,
    /// Nodes something references in a way the emit loop cannot rewrite, so they
    /// have to stay. Treated as non-empty, which keeps their ancestors too.
    blocked: HashSet<Node>,
    /// Spatial child → its containers (upward edges for the emptiness sweep).
    parents: HashMap<Node, Vec<Node>>,
}

/// True when `type_upper` is a droppable spatial container type.
fn is_container_type(type_upper: &str) -> bool {
    CONTAINER_TYPES.contains(&type_upper)
}

/// Plan which spatial containers the merge leaves holding nothing, or `None`
/// when the caller did not ask for it ([`MergedOptions::drop_empty_containers`]).
pub(super) fn plan_drops(
    models: &[MergedModel],
    opts: &MergedOptions,
    spatial_lookup: &SpatialLookup,
    modes: &[ModelUnitMode],
) -> Option<DropPlan> {
    if !opts.drop_empty_containers {
        return None;
    }
    let compatible: Vec<bool> = modes.iter().map(|m| m.compatible).collect();
    Some(plan_container_drops(models, &DropCtx {
        spatial_lookup,
        merge_sites: opts.merge_sites,
        merge_buildings: opts.merge_buildings,
        merge_storeys: opts.merge_storeys,
        compatible: &compatible,
    }))
}

/// Plan which spatial containers the merge leaves holding nothing.
fn plan_container_drops(models: &[MergedModel], ctx: &DropCtx) -> DropPlan {
    let mut graph = Graph::default();
    let mut guid_node: HashMap<String, Node> = HashMap::new();
    // Containers are a tiny fraction of a model, so the per-model container maps
    // are cheap to retain; the byte-indexed models are not, and are dropped as
    // soon as each model's contribution to the graph is recorded.
    let mut per_model_containers: Vec<Vec<(u32, Node)>> = Vec::with_capacity(models.len());
    let mut offset: u32 = 0;

    for (i, model) in models.iter().enumerate() {
        let index = ModelIndex::build(model.content);
        let included = resolve_included(&index, &model.included);
        // Stop where the emit loop will stop. A model past the EXPRESS-id cut is
        // never written, so counting its content here would keep a container
        // nothing in the output actually fills — and report it as surviving.
        // Same rule, one home (`plan::next_offset`), so the two cannot disagree.
        let Some(next) = next_offset(offset, &included) else { break };
        offset = next;
        let compatible = ctx.compatible.get(i).copied().unwrap_or(false);
        let mut remap: HashMap<u32, u32> = HashMap::new();
        if i > 0 && compatible {
            let mut skip: HashSet<u32> = HashSet::new();
            unify_spatial(
                ctx.spatial_lookup,
                &index,
                &mut remap,
                &mut skip,
                ctx.merge_sites,
                ctx.merge_buildings,
                ctx.merge_storeys,
                1.0,
            );
        }

        let canon = canonical_containers(&index, &included, &remap, compatible, i, &mut guid_node);
        graph.nodes.extend(canon.values().copied());
        record_edges(&index, &included, &canon, &mut graph);
        record_blocks(&index, &included, &canon, &mut graph);
        per_model_containers.push(canon.into_iter().collect());
    }

    // A container is non-empty when it holds something, is blocked, or has a
    // non-empty spatial child — the last propagated upward from the first two.
    // The `insert` guard also makes a self-referential aggregation terminate.
    let mut non_empty: HashSet<Node> =
        graph.has_content.union(&graph.blocked).copied().collect();
    let mut stack: Vec<Node> = non_empty.iter().copied().collect();
    while let Some(node) = stack.pop() {
        let Some(parents) = graph.parents.get(&node) else { continue };
        for &parent in parents {
            if non_empty.insert(parent) {
                stack.push(parent);
            }
        }
    }

    let dropped: HashSet<Node> =
        graph.nodes.iter().copied().filter(|n| !non_empty.contains(n)).collect();
    let per_model = per_model_containers
        .iter()
        .map(|locals| {
            locals.iter().filter(|(_, n)| dropped.contains(n)).map(|&(id, _)| id).collect()
        })
        .collect();
    DropPlan { per_model, count: dropped.len() }
}

/// Map each of this model's visible containers to its node in the merged model:
/// the first model's container when spatial unification matched it there, the
/// earlier instance when an earlier model already emitted its GlobalId, else
/// itself. Mirrors the emit loop's unification order (source order, first wins).
fn canonical_containers(
    index: &ModelIndex,
    included: &HashSet<u32>,
    remap: &HashMap<u32, u32>,
    compatible: bool,
    model: usize,
    guid_node: &mut HashMap<String, Node>,
) -> HashMap<u32, Node> {
    let mut canon = HashMap::new();
    for &id in &index.order {
        if !included.contains(&id) {
            continue;
        }
        let Some(ty) = index.type_of.get(&id) else { continue };
        if !is_container_type(ty) {
            continue;
        }
        let node = if let Some(&target) = remap.get(&id) {
            (0, target)
        } else if compatible {
            match index.line_bytes(id).and_then(|b| extract_global_id_fast(ty, b)) {
                Some(guid) => *guid_node.entry(guid).or_insert((model, id)),
                None => (model, id),
            }
        } else {
            (model, id)
        };
        canon.insert(id, node);
    }
    canon
}

/// Record what this model contributes to each container: contained elements and
/// aggregated objects become content; aggregated spatial children become upward
/// edges, so a non-empty storey keeps its building and site.
fn record_edges(
    index: &ModelIndex,
    included: &HashSet<u32>,
    canon: &HashMap<u32, Node>,
    graph: &mut Graph,
) {
    for &id in &index.order {
        if !included.contains(&id) {
            continue;
        }
        let Some(ty) = index.type_of.get(&id) else { continue };
        // (relating attribute, related attribute) — `IfcRelAggregates` names the
        // whole first, the containment relationships name the parts first.
        let (relating, related) = match ty.as_str() {
            "IFCRELAGGREGATES" => (4, 5),
            "IFCRELCONTAINEDINSPATIALSTRUCTURE" | "IFCRELREFERENCEDINSPATIALSTRUCTURE" => (5, 4),
            _ => continue,
        };
        let Some(line) = index.line_str(id) else { continue };
        let Some(parent) = nth_attr(&line, relating)
            .and_then(single_ref)
            .and_then(|local| canon.get(&local).copied())
        else {
            // Not a container (an `IfcProject` aggregating its sites, say) — its
            // children are roots of the spatial tree, with nothing above to keep.
            continue;
        };
        for child_local in nth_attr(&line, related).map(ref_list).unwrap_or_default() {
            if !included.contains(&child_local) {
                continue;
            }
            match canon.get(&child_local) {
                Some(&child) => graph.parents.entry(child).or_default().push(parent),
                None => {
                    graph.has_content.insert(parent);
                }
            }
        }
    }
}

/// Block every container this model references in a way the emit loop could not
/// rewrite. Dropping such a container would leave a dangling `#ref`, so it stays
/// (and counts as non-empty, keeping its ancestors) instead.
///
/// Prunable is: a reference from an objectified relationship (`IfcRel*`) that
/// nothing else references, since the emit loop can strip it from a list or drop
/// the whole relationship line. Everything else — a non-relationship referrer, a
/// reference nested inside a typed value, or a relationship that is itself
/// referenced (dropping it would dangle in turn) — blocks.
fn record_blocks(
    index: &ModelIndex,
    included: &HashSet<u32>,
    canon: &HashMap<u32, Node>,
    graph: &mut Graph,
) {
    if canon.is_empty() {
        return;
    }
    let mut referrers: Vec<u32> = Vec::new();
    let mut referenced_rels: HashSet<u32> = HashSet::new();
    let mut refs: Vec<u32> = Vec::new();
    for &id in &index.order {
        if !included.contains(&id) {
            continue;
        }
        let Some(bytes) = index.line_bytes(id) else { continue };
        refs.clear();
        arg_refs(bytes, &mut refs);
        let mut hits_container = false;
        for &r in &refs {
            hits_container |= canon.contains_key(&r);
            if index.type_of.get(&r).is_some_and(|t| t.starts_with("IFCREL")) {
                referenced_rels.insert(r);
            }
        }
        if hits_container {
            referrers.push(id);
        }
    }

    for id in referrers {
        let ty = index.type_of.get(&id).map(String::as_str).unwrap_or("");
        let prunable = ty.starts_with("IFCREL") && !referenced_rels.contains(&id);
        let Some(line) = index.line_str(id) else { continue };
        let Some(slots) = classify_refs(&line) else {
            // The argument list could not be parsed, so no rewrite can narrow
            // this line: every container it names has to stay.
            refs.clear();
            arg_refs(line.as_bytes(), &mut refs);
            for r in &refs {
                if let Some(&node) = canon.get(r) {
                    graph.blocked.insert(node);
                }
            }
            continue;
        };
        for (r, slot) in slots {
            let Some(&node) = canon.get(&r) else { continue };
            let rewritable = match slot {
                RefSlot::Single | RefSlot::ListElement => prunable,
                RefSlot::Nested => false,
            };
            if !rewritable {
                graph.blocked.insert(node);
            }
        }
    }
}

/// Parse a single `#N` reference attribute (`"#4"` → `4`).
fn single_ref(arg: &str) -> Option<u32> {
    arg.trim().strip_prefix('#')?.parse().ok()
}

/// Parse a `(#a,#b,…)` list attribute into ids.
fn ref_list(arg: &str) -> Vec<u32> {
    arg.trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .filter_map(single_ref)
        .collect()
}

#[cfg(test)]
#[path = "empty_tests.rs"]
mod empty_tests;
