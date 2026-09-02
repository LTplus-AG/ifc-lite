// SPDX-License-Identifier: MPL-2.0
//! Per-model indexing and plan helpers for the merged exporter. Ports the parts
//! of `merged-exporter.ts` that operate on one model at a time: line indexing,
//! the visibility forward-reference closure, `#`-reference rewriting, spatial
//! unification, and redundant-`IfcRelAggregates` pruning.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::EntityScanner;

use super::guid::{extract_global_id_fast, is_relationship_type, GuidMinter};
use super::spatial::{
    nth_attr, ContainerMergeStrategy, SpatialLookup, StoreyMergeStrategy,
};
use super::units::units_compatible;
use super::MergedModel;
use crate::step_text::refs_in_line;

/// Entity types forming shared infrastructure — the first instance of each is
/// unified across compatible models (later duplicates dropped + redirected).
pub const SHARED_INFRASTRUCTURE_TYPES: [&str; 3] = [
    "IFCUNITASSIGNMENT",
    "IFCGEOMETRICREPRESENTATIONCONTEXT",
    "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
];

/// A single model indexed by express id, plus the derived facts the merge needs.
pub struct ModelIndex<'a> {
    content: &'a [u8],
    /// Express ids in source order (first occurrence).
    pub order: Vec<u32>,
    /// id → byte span of the raw entity line.
    line_of: HashMap<u32, (usize, usize)>,
    /// id → uppercase STEP type token.
    pub type_of: HashMap<u32, String>,
    /// Largest express id seen (drives the next model's offset).
    pub max_id: u32,
    /// All `IFCPROJECT` ids in the model.
    pub projects: Vec<u32>,
    /// First express id per shared-infrastructure type.
    pub first_infra: HashMap<&'static str, u32>,
    /// Count of `IFCSITE` / `IFCBUILDING` (for the single-instance match rule).
    pub site_count: usize,
    pub building_count: usize,
}

impl<'a> ModelIndex<'a> {
    /// Index every entity line of `content` in source order.
    pub fn build(content: &'a [u8]) -> Self {
        let mut idx = ModelIndex {
            content,
            order: Vec::new(),
            line_of: HashMap::new(),
            type_of: HashMap::new(),
            max_id: 0,
            projects: Vec::new(),
            first_infra: HashMap::new(),
            site_count: 0,
            building_count: 0,
        };
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            idx.max_id = idx.max_id.max(id);
            if idx.line_of.insert(id, (start, end)).is_none() {
                idx.order.push(id);
            }
            match type_name {
                "IFCPROJECT" => idx.projects.push(id),
                "IFCSITE" => idx.site_count += 1,
                "IFCBUILDING" => idx.building_count += 1,
                _ => {}
            }
            if let Some(&shared) = SHARED_INFRASTRUCTURE_TYPES.iter().find(|&&t| t == type_name) {
                idx.first_infra.entry(shared).or_insert(id);
            }
            idx.type_of.entry(id).or_insert_with(|| type_name.to_string());
        }
        idx
    }

    /// Raw bytes of the entity line for `id`.
    pub fn line_bytes(&self, id: u32) -> Option<&'a [u8]> {
        self.line_of.get(&id).map(|&(s, e)| &self.content[s..e])
    }

    /// The entity line for `id` decoded lossily to a `String`.
    pub fn line_str(&self, id: u32) -> Option<String> {
        self.line_bytes(id).map(|b| String::from_utf8_lossy(b).into_owned())
    }
}

/// Resolve the visible id set for a model: `None` ⇒ every entity; otherwise the
/// forward-reference closure of `roots` (so a filtered export never dangles a
/// `#ref`), mirroring `export_step_with_stats`.
pub fn resolve_included(index: &ModelIndex, roots: &Option<Vec<u32>>) -> HashSet<u32> {
    match roots {
        None => index.order.iter().copied().collect(),
        Some(roots) => {
            let mut keep: HashSet<u32> = HashSet::new();
            let mut stack: Vec<u32> = roots.clone();
            let mut refs = Vec::new();
            while let Some(id) = stack.pop() {
                if !keep.insert(id) {
                    continue;
                }
                if let Some(bytes) = index.line_bytes(id) {
                    refs.clear();
                    refs_in_line(bytes, &mut refs);
                    for &r in &refs {
                        if !keep.contains(&r) {
                            stack.push(r);
                        }
                    }
                }
            }
            keep
        }
    }
}

/// The EXPRESS-id offset the NEXT model would use, or `None` when placing this
/// model would push the merged id space past `u32::MAX`. Wrapping the offset
/// would silently duplicate ids and rewrite references to the wrong entities
/// (CR #2952), so a `None` here stops the merge instead.
///
/// Bound by the largest VISIBLE id, not `index.max_id`: an excluded high id is
/// never emitted, so it must not consume id space or omit a later model that
/// would actually fit (CR #2952).
///
/// Single home for the rule because two callers must agree on it exactly: the
/// emit loop, and the empty-container pre-pass (#3643), which has to stop at
/// the same model — a plan covering models that are never emitted would keep a
/// container only the unmerged tail fills, and count it as dropped.
pub(super) fn next_offset(offset: u32, included: &HashSet<u32>) -> Option<u32> {
    offset.checked_add(included.iter().copied().max().unwrap_or(0))
}

/// Match this model's `IfcSite` / `IfcBuilding` / `IfcBuildingStorey` onto the
/// first model's (via `lookup`), recording each match in `shared_remap` (local
/// id → first-model id) and `skip` (the local line is not emitted).
#[allow(clippy::too_many_arguments)]
pub fn unify_spatial(
    lookup: &SpatialLookup,
    index: &ModelIndex,
    shared_remap: &mut HashMap<u32, u32>,
    skip: &mut HashSet<u32>,
    site_strategy: ContainerMergeStrategy,
    building_strategy: ContainerMergeStrategy,
    storey_strategy: StoreyMergeStrategy,
    elevation_factor: f64,
) {
    let mut matched_sites: HashSet<u32> = HashSet::new();
    let mut matched_buildings: HashSet<u32> = HashSet::new();
    let mut matched_storeys: HashSet<u32> = HashSet::new();
    for &id in &index.order {
        let Some(ty) = index.type_of.get(&id) else { continue };
        let Some(line) = index.line_str(id) else { continue };
        let matched = match ty.as_str() {
            "IFCSITE" => lookup
                .match_site(&line, index.site_count, &matched_sites, site_strategy)
                .inspect(|&m| {
                    matched_sites.insert(m);
                }),
            "IFCBUILDING" => lookup
                .match_building(&line, index.building_count, &matched_buildings, building_strategy)
                .inspect(|&m| {
                    matched_buildings.insert(m);
                }),
            "IFCBUILDINGSTOREY" => lookup
                .match_storey(&line, &matched_storeys, storey_strategy, elevation_factor)
                .inspect(|&m| {
                    matched_storeys.insert(m);
                }),
            _ => None,
        };
        if let Some(m) = matched {
            shared_remap.insert(id, m);
            skip.insert(id);
        }
    }
}

/// Drop an `IfcRelAggregates` whose relating object AND every related object was
/// unified into the first model (its aggregation already exists there). A
/// partially-shared relationship is kept (its refs are remapped at emit time so
/// it points into the first model's tree).
pub fn skip_redundant_rel_aggregates(
    index: &ModelIndex,
    shared_remap: &HashMap<u32, u32>,
    skip: &mut HashSet<u32>,
) {
    for &id in &index.order {
        if index.type_of.get(&id).map(String::as_str) != Some("IFCRELAGGREGATES") {
            continue;
        }
        let Some(line) = index.line_str(id) else { continue };
        let Some(relating) = nth_attr(&line, 4).and_then(parse_single_ref) else { continue };
        let related = nth_attr(&line, 5).map(parse_ref_list).unwrap_or_default();
        if shared_remap.contains_key(&relating)
            && !related.is_empty()
            && related.iter().all(|r| shared_remap.contains_key(r))
        {
            skip.insert(id);
        }
    }
}

/// Parse a single `#N` reference token (`"#4"` → `4`).
fn parse_single_ref(arg: &str) -> Option<u32> {
    arg.trim().strip_prefix('#')?.parse().ok()
}

/// Parse a `(#a,#b,…)` list of references into ids.
fn parse_ref_list(arg: &str) -> Vec<u32> {
    arg.trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .filter_map(parse_single_ref)
        .collect()
}

/// The plan state built for one model before it is emitted.
#[derive(Default)]
pub(super) struct ModelPlan {
    /// Local express id → absolute final id (redirect; no offset applied).
    pub(super) shared_remap: HashMap<u32, u32>,
    /// Local express ids whose line is not emitted (unified into the first model).
    pub(super) skip: HashSet<u32>,
    /// Local express id → fresh GlobalId to stamp (duplicate GUID re-stamp).
    pub(super) guid_rewrite: HashMap<u32, String>,
    /// Local express id → its source GlobalId (rooted entities only).
    pub(super) local_guids: HashMap<u32, String>,
}

/// Immutable-ish context threaded into [`build_plan`].
pub(super) struct PlanCtx<'a> {
    pub(super) canonical_project: Option<u32>,
    pub(super) first_infra: &'a HashMap<&'static str, u32>,
    pub(super) spatial_lookup: &'a SpatialLookup,
    pub(super) merge_sites: ContainerMergeStrategy,
    pub(super) merge_buildings: ContainerMergeStrategy,
    pub(super) merge_storeys: StoreyMergeStrategy,
    pub(super) primary_scale: f64,
    pub(super) guid_to_final: &'a HashMap<String, (u32, f64)>,
    pub(super) emitted_guids: &'a HashSet<String>,
    pub(super) minter: &'a mut GuidMinter,
    pub(super) salt: String,
}

/// Build the [`ModelPlan`] for one model: project / infrastructure / spatial
/// unification (compatible non-first models only) plus GlobalId reconciliation.
pub(super) fn build_plan(
    index: &ModelIndex,
    is_first: bool,
    compatible: bool,
    mut ctx: PlanCtx,
) -> ModelPlan {
    let mut plan = ModelPlan::default();

    for &id in &index.order {
        if let Some(ty) = index.type_of.get(&id) {
            if let Some(bytes) = index.line_bytes(id) {
                if let Some(guid) = extract_global_id_fast(ty, bytes) {
                    plan.local_guids.insert(id, guid);
                }
            }
        }
    }

    if !is_first && compatible {
        // Unify each later project into the first model's.
        if let Some(cp) = ctx.canonical_project {
            for &pid in &index.projects {
                plan.shared_remap.insert(pid, cp);
                plan.skip.insert(pid);
            }
        }
        // Deduplicate the first instance of each shared-infrastructure type.
        for &ty in &SHARED_INFRASTRUCTURE_TYPES {
            if let (Some(&this_id), Some(&first_id)) =
                (index.first_infra.get(ty), ctx.first_infra.get(ty))
            {
                plan.shared_remap.insert(this_id, first_id);
                plan.skip.insert(this_id);
            }
        }
        // Unify spatial containers, then drop now-redundant aggregations.
        unify_spatial(
            ctx.spatial_lookup,
            index,
            &mut plan.shared_remap,
            &mut plan.skip,
            ctx.merge_sites,
            ctx.merge_buildings,
            ctx.merge_storeys,
            1.0,
        );
        skip_redundant_rel_aggregates(index, &plan.shared_remap, &mut plan.skip);
    }

    // Reconcile GlobalIds for every model — including the first, whose two rooted
    // entities can share a GlobalId (a defective source) and must not both survive.
    reconcile_global_ids(index, compatible, &mut plan, &mut ctx);

    plan
}

/// Unify or re-stamp each rooted entity whose GlobalId already appeared — either
/// in an earlier model (cross-model, via `guid_to_final`) or earlier in THIS
/// model (within-model, via `seen_local`).
fn reconcile_global_ids(index: &ModelIndex, compatible: bool, plan: &mut ModelPlan, ctx: &mut PlanCtx) {
    // Collect first so the mutable `minter` borrow does not overlap the read of
    // `plan.local_guids` / `plan.skip`.
    let mut restamp: Vec<(u32, String)> = Vec::new();
    // GlobalIds this model has already emitted unchanged. The cross-model map
    // (`guid_to_final`) cannot see a duplicate *within* this model, because the
    // first occurrence is not registered until emit time — so two rooted entities
    // in one model sharing a GlobalId would both bypass unify/restamp and emit
    // duplicate identifiers. Keep the first, re-stamp every later one.
    let mut seen_local: HashSet<String> = HashSet::new();
    for &id in &index.order {
        if plan.skip.contains(&id) {
            continue;
        }
        let Some(guid) = plan.local_guids.get(&id) else { continue };
        if !seen_local.insert(guid.clone()) {
            restamp.push((id, guid.clone()));
            continue;
        }
        let Some(&(final_id, scale)) = ctx.guid_to_final.get(guid) else { continue };
        let ty = index.type_of.get(&id).map(String::as_str).unwrap_or("");
        let can_unify =
            compatible && units_compatible(scale, ctx.primary_scale) && !is_relationship_type(ty);
        if can_unify {
            plan.shared_remap.insert(id, final_id);
            plan.skip.insert(id);
        } else {
            restamp.push((id, guid.clone()));
        }
    }
    // A minted replacement must also avoid the guids THIS model emits unchanged:
    // `emitted_guids` only holds prior models' guids (the plan is built before this
    // model emits), so without this a fresh guid could collide with an untouched
    // one in the same model (CR). Collect them once, before the mutable borrow.
    let local_guids: HashSet<String> = plan.local_guids.values().cloned().collect();
    for (id, guid) in restamp {
        let minted = ctx.minter.mint(&guid, &ctx.salt, ctx.emitted_guids, &local_guids);
        plan.guid_rewrite.insert(id, minted);
    }
}

/// The GlobalId-mint salt for a model: its stable id, or its index when empty.
pub(super) fn model_salt(model: &MergedModel, index: usize) -> String {
    if model.id.is_empty() {
        index.to_string()
    } else {
        model.id.clone()
    }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod plan_tests;
