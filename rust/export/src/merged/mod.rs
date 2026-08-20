// SPDX-License-Identifier: MPL-2.0
//! **Merged** multi-model STEP exporter. A native (Rust) port of
//! `packages/export/src/merged-exporter.ts`: combine several IFC files into one
//! by offsetting each later model's express ids and rewriting every
//! `#`-reference, while unifying the shared spatial/infrastructure tree so the
//! result is one coherent model rather than N stacked copies.
//!
//! Feature parity with the JS `MergedExporter` (issue #2951):
//! - **Project / infrastructure unification** — later models' `IfcProject` and
//!   the first `IfcUnitAssignment` / representation contexts are dropped and
//!   their references redirected to the first model's (compatible models only).
//! - **Spatial unification** — `IfcSite` / `IfcBuilding` / `IfcBuildingStorey`
//!   are matched onto the first model's by name / elevation ([`spatial`]).
//! - **GlobalId reconciliation** — a rooted entity that duplicates a prior
//!   GlobalId in the same unit space is unified (refs remapped to the first
//!   instance); otherwise it is re-stamped with a deterministic fresh GlobalId
//!   ([`guid`]), so a federated file never carries duplicate GlobalIds.
//! - **Visibility filtering** — a per-model `included` allowlist is honored via
//!   the forward-reference closure ([`plan::resolve_included`]).
//!
//! Genuine cross-unit rescaling (`unitReconciliation: 'normalize'`) is deferred:
//! a model whose length unit is incompatible with the first is **federated**
//! (kept as its own project, never mis-scaled) and [`MergedStats::unit_rescale_required`]
//! is set so the caller can gate that case to the JS path.

mod guid;
mod plan;
mod spatial;
mod units;

use std::collections::{HashMap, HashSet};

use crate::step_text::{detect_schema, escape};

use guid::{extract_global_id_fast, is_relationship_type, read_leading_guid, replace_global_id, GuidMinter};
pub use guid::leading_rooted_global_id;
use plan::{ModelIndex, SHARED_INFRASTRUCTURE_TYPES};
use units::{resolve_length_scale, units_compatible};

pub use spatial::{ContainerMergeStrategy, StoreyMergeStrategy};

/// How to reconcile models whose length unit differs from the first model's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum UnitReconciliation {
    /// Federate an incompatible-unit model as its own `IfcProject` (JS default).
    #[default]
    Auto,
    /// Request rescaling into the first model's unit. Not performed natively in
    /// this iteration: an incompatible model is federated and
    /// [`MergedStats::unit_rescale_required`] is set for the caller to gate.
    Normalize,
    /// Treat every model as sharing the first model's unit (no compatibility
    /// check) — unify regardless of the declared length unit.
    AssumeShared,
}

/// A single input model for [`export_merged_models`].
pub struct MergedModel<'a> {
    /// Raw IFC/STEP bytes.
    pub content: &'a [u8],
    /// Stable identifier, used to salt re-stamped GlobalIds so they are
    /// reproducible and do not churn when an unrelated model changes size. When
    /// empty, the model's index is used.
    pub id: String,
    /// Express ids to include (visibility). `None` ⇒ the whole model; when set,
    /// the forward-reference closure is added so every emitted `#ref` resolves.
    pub included: Option<Vec<u32>>,
}

impl<'a> MergedModel<'a> {
    /// A model that exports in full with a default (empty) id.
    pub fn new(content: &'a [u8]) -> Self {
        Self { content, id: String::new(), included: None }
    }
}

/// Options for merged export.
pub struct MergedOptions {
    /// FILE_SCHEMA label to write. `None` ⇒ the first model's schema; each model
    /// whose source schema differs is converted to it.
    pub schema: Option<String>,
    pub description: String,
    pub application: String,
    /// Cross-unit reconciliation policy (see [`UnitReconciliation`]).
    pub unit_reconciliation: UnitReconciliation,
    /// `IfcSite` matching strategy.
    pub merge_sites: ContainerMergeStrategy,
    /// `IfcBuilding` matching strategy.
    pub merge_buildings: ContainerMergeStrategy,
    /// `IfcBuildingStorey` matching strategy.
    pub merge_storeys: StoreyMergeStrategy,
}

impl Default for MergedOptions {
    fn default() -> Self {
        Self {
            schema: None,
            description: "ViewDefinition [CoordinationView]".to_string(),
            application: "ifc-lite".to_string(),
            unit_reconciliation: UnitReconciliation::default(),
            merge_sites: ContainerMergeStrategy::default(),
            merge_buildings: ContainerMergeStrategy::default(),
            merge_storeys: StoreyMergeStrategy::default(),
        }
    }
}

/// Coverage stats for a merged export.
pub struct MergedStats {
    /// Number of input models.
    pub models: usize,
    /// Entity lines written.
    pub written: usize,
    /// Models federated as their own `IfcProject` (incompatible units under
    /// `Auto` / `Normalize`).
    pub federated_model_count: usize,
    /// True when a `Normalize` export encountered an incompatible-unit model
    /// that was federated rather than rescaled — the caller should route that
    /// case to the JS path if true single-project normalization is required.
    pub unit_rescale_required: bool,
    /// Human-readable notes (e.g. federation relaxing `IfcSingleProjectInstance`).
    pub warnings: Vec<String>,
}

/// Merge `models` (raw IFC byte slices) into one STEP/IFC string. Convenience
/// wrapper over [`export_merged_models`] that exports each model in full.
pub fn export_merged(models: &[&[u8]], opts: &MergedOptions) -> String {
    export_merged_with_stats(models, opts).0
}

/// Like [`export_merged`] but also returns coverage stats.
pub fn export_merged_with_stats(models: &[&[u8]], opts: &MergedOptions) -> (String, MergedStats) {
    let inputs: Vec<MergedModel> = models
        .iter()
        .enumerate()
        .map(|(i, &content)| MergedModel { content, id: i.to_string(), included: None })
        .collect();
    export_merged_models(&inputs, opts)
}

/// The plan state built for one model before it is emitted.
#[derive(Default)]
struct ModelPlan {
    /// Local express id → absolute final id (redirect; no offset applied).
    shared_remap: HashMap<u32, u32>,
    /// Local express ids whose line is not emitted (unified into the first model).
    skip: HashSet<u32>,
    /// Local express id → fresh GlobalId to stamp (duplicate GUID re-stamp).
    guid_rewrite: HashMap<u32, String>,
    /// Local express id → its source GlobalId (rooted entities only).
    local_guids: HashMap<u32, String>,
}

/// Merge several parsed models into one STEP/IFC string, honoring per-model
/// visibility, spatial-merge strategies, and unit reconciliation.
pub fn export_merged_models(models: &[MergedModel], opts: &MergedOptions) -> (String, MergedStats) {
    let schema = opts
        .schema
        .clone()
        .or_else(|| models.first().map(|m| detect_schema(m.content)))
        .unwrap_or_else(|| "IFC4".to_string());

    let mut out = String::new();
    out.push_str("ISO-10303-21;\nHEADER;\n");
    out.push_str(&format!("FILE_DESCRIPTION(('{}'),'2;1');\n", escape(&opts.description)));
    out.push_str(&format!(
        "FILE_NAME('','',(''),(''),'{}','ifc-lite-export','');\n",
        escape(&opts.application)
    ));
    out.push_str(&format!("FILE_SCHEMA(('{}'));\n", escape(&schema)));
    out.push_str("ENDSEC;\nDATA;\n");

    let mut stats = MergedStats {
        models: models.len(),
        written: 0,
        federated_model_count: 0,
        unit_rescale_required: false,
        warnings: Vec::new(),
    };

    if models.is_empty() {
        out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
        return (out, stats);
    }

    // First-model facts every later model unifies against. Restrict them to the
    // first model's VISIBLE set: a redirect target that visibility excludes from
    // emission would leave later models dangling a `#ref` to a line never written
    // (Greptile P1 / CR). An excluded canonical simply isn't a target — later
    // models then keep their own project/infra/containers (less dedup, still valid).
    let first = ModelIndex::build(models[0].content);
    let first_included = plan::resolve_included(&first, &models[0].included);
    let canonical_project = first.projects.iter().copied().find(|id| first_included.contains(id));
    let first_infra: HashMap<&'static str, u32> = first
        .first_infra
        .iter()
        .filter(|(_, id)| first_included.contains(id))
        .map(|(&ty, &id)| (ty, id))
        .collect();
    let first_order: Vec<u32> =
        first.order.iter().copied().filter(|id| first_included.contains(id)).collect();
    let spatial_lookup = spatial::SpatialLookup::build(
        &first_order,
        &|id| first.line_str(id),
        &|id| first.type_of.get(&id).cloned(),
    );
    let primary_scale = resolve_length_scale(models[0].content);
    drop(first);

    // Running cross-model state.
    let mut guid_to_final: HashMap<String, (u32, f64)> = HashMap::new();
    let mut emitted_guids: HashSet<String> = HashSet::new();
    let mut minter = GuidMinter::new();
    let mut offset: u32 = 0;

    for (i, model) in models.iter().enumerate() {
        let is_first = i == 0;
        let index = ModelIndex::build(model.content);
        let included = plan::resolve_included(&index, &model.included);

        // Unit mode.
        let this_scale = resolve_length_scale(model.content);
        let (compatible, effective_scale) = if is_first {
            (true, primary_scale)
        } else {
            match opts.unit_reconciliation {
                UnitReconciliation::AssumeShared => (true, this_scale),
                _ if units_compatible(this_scale, primary_scale) => (true, this_scale),
                UnitReconciliation::Normalize => {
                    stats.federated_model_count += 1;
                    stats.unit_rescale_required = true;
                    (false, this_scale)
                }
                UnitReconciliation::Auto => {
                    stats.federated_model_count += 1;
                    (false, this_scale)
                }
            }
        };

        let plan = build_plan(&index, is_first, compatible, PlanCtx {
            canonical_project,
            first_infra: &first_infra,
            spatial_lookup: &spatial_lookup,
            merge_sites: opts.merge_sites,
            merge_buildings: opts.merge_buildings,
            merge_storeys: opts.merge_storeys,
            primary_scale,
            guid_to_final: &guid_to_final,
            emitted_guids: &emitted_guids,
            minter: &mut minter,
            salt: model_salt(model, i),
        });

        // Emit.
        let source_schema = detect_schema(model.content);
        let converting = crate::schema_convert::needs_conversion(&source_schema, &schema);
        for &id in &index.order {
            if !included.contains(&id) || plan.skip.contains(&id) {
                continue;
            }
            let Some(bytes) = index.line_bytes(id) else { continue };
            let remapped = if offset == 0 && plan.shared_remap.is_empty() {
                String::from_utf8_lossy(bytes).into_owned()
            } else {
                plan::rewrite_refs(bytes, offset, &|n| plan.shared_remap.get(&n).copied())
            };
            let after_guid = match plan.guid_rewrite.get(&id) {
                Some(g) => replace_global_id(&remapped, g),
                None => remapped,
            };
            let final_text = if converting {
                // Pass the GLOBAL id (offset applied): a schema downgrade with no
                // target type falls back to IFCPROXY with a `placeholder_guid(id)`
                // GlobalId, so two models sharing a source-local id must not seed the
                // same placeholder (Greptile P1). rewrite_refs already offset the
                // line's own `#id`, so this keeps the proxy guid consistent with it.
                crate::schema_convert::convert_step_line(
                    &after_guid,
                    &source_schema,
                    &schema,
                    id.wrapping_add(offset),
                )
            } else {
                after_guid
            };

            if let Some(local_guid) = plan.local_guids.get(&id) {
                let emitted = read_leading_guid(&final_text)
                    .or_else(|| plan.guid_rewrite.get(&id).cloned())
                    .unwrap_or_else(|| local_guid.clone());
                guid_to_final.insert(emitted.clone(), (id.wrapping_add(offset), effective_scale));
                emitted_guids.insert(emitted);
            }

            out.push_str(&final_text);
            out.push('\n');
            stats.written += 1;
        }

        offset = offset.wrapping_add(index.max_id);
    }

    if stats.federated_model_count > 0 {
        stats.warnings.push(format!(
            "{} model(s) had an incompatible length unit and were federated as separate IfcProject instances (relaxing IfcSingleProjectInstance).",
            stats.federated_model_count
        ));
    }

    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    (out, stats)
}

/// Immutable-ish context threaded into [`build_plan`].
struct PlanCtx<'a> {
    canonical_project: Option<u32>,
    first_infra: &'a HashMap<&'static str, u32>,
    spatial_lookup: &'a spatial::SpatialLookup,
    merge_sites: ContainerMergeStrategy,
    merge_buildings: ContainerMergeStrategy,
    merge_storeys: StoreyMergeStrategy,
    primary_scale: f64,
    guid_to_final: &'a HashMap<String, (u32, f64)>,
    emitted_guids: &'a HashSet<String>,
    minter: &'a mut GuidMinter,
    salt: String,
}

/// Build the [`ModelPlan`] for one model: project / infrastructure / spatial
/// unification (compatible non-first models only) plus GlobalId reconciliation.
fn build_plan(index: &ModelIndex, is_first: bool, compatible: bool, mut ctx: PlanCtx) -> ModelPlan {
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
        plan::unify_spatial(
            ctx.spatial_lookup,
            index,
            &mut plan.shared_remap,
            &mut plan.skip,
            ctx.merge_sites,
            ctx.merge_buildings,
            ctx.merge_storeys,
            1.0,
        );
        plan::skip_redundant_rel_aggregates(index, &plan.shared_remap, &mut plan.skip);
    }

    if !is_first {
        reconcile_global_ids(index, compatible, &mut plan, &mut ctx);
    }

    plan
}

/// Unify or re-stamp each rooted entity whose GlobalId already appeared.
fn reconcile_global_ids(index: &ModelIndex, compatible: bool, plan: &mut ModelPlan, ctx: &mut PlanCtx) {
    // Collect first so the mutable `minter` borrow does not overlap the read of
    // `plan.local_guids` / `plan.skip`.
    let mut restamp: Vec<(u32, String)> = Vec::new();
    for &id in &index.order {
        if plan.skip.contains(&id) {
            continue;
        }
        let Some(guid) = plan.local_guids.get(&id) else { continue };
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
fn model_salt(model: &MergedModel, index: usize) -> String {
    if model.id.is_empty() {
        index.to_string()
    } else {
        model.id.clone()
    }
}

#[cfg(test)]
mod tests;
