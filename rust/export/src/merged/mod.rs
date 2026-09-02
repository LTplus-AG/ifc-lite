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

mod empty;
mod guid;
mod line_edit;
mod plan;
mod spatial;
mod units;

use std::collections::{HashMap, HashSet};

use crate::schema_detect::detect_schema;
use crate::step_text::escape;

use guid::{read_leading_guid, replace_global_id, GuidMinter};
pub use guid::{deterministic_global_id, leading_rooted_global_id};
use line_edit::{rewrite_refs, LineDecision};
use plan::{build_plan, model_salt, ModelIndex, PlanCtx};
use units::{resolve_length_scale, resolve_model_modes};

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
    /// Drop spatial containers (`IfcSite` / `IfcBuilding` / `IfcBuildingStorey` /
    /// `IfcSpace`) that the merge leaves holding nothing — the "Merge Projects"
    /// recipe step that container matching alone does not cover (#3643).
    /// Emptiness is judged on the MERGED model, after visibility filtering and
    /// spatial unification, and an emptied container is simply never planned, so
    /// nothing is written referencing it. Off by default: output is byte-identical
    /// to a merge that never asked for it.
    pub drop_empty_containers: bool,
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
            drop_empty_containers: false,
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
    /// Models left unmerged because placing them would overflow the u32 EXPRESS-id
    /// space. Non-zero means the merge stopped early to avoid wrapping ids; the
    /// caller should route the whole set to a wider-id path if this is hit.
    pub unmerged_model_count: usize,
    /// True when a `Normalize` export encountered an incompatible-unit model
    /// that was federated rather than rescaled — the caller should route that
    /// case to the JS path if true single-project normalization is required.
    pub unit_rescale_required: bool,
    /// Spatial containers dropped for holding nothing, counted in the merged
    /// model (a container unified across three inputs counts once). Always 0
    /// unless [`MergedOptions::drop_empty_containers`] is set.
    pub dropped_container_count: usize,
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
        unmerged_model_count: 0,
        unit_rescale_required: false,
        dropped_container_count: 0,
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

    // Unit verdicts for every model, resolved once: the empty-container pre-pass
    // has to know which models unify before anything is written, and the emit
    // loop below must reach the same verdict — so both read this one answer.
    let modes = resolve_model_modes(models, opts.unit_reconciliation, primary_scale);
    let drop_plan = empty::plan_drops(models, opts, &spatial_lookup, &modes);
    stats.dropped_container_count = drop_plan.as_ref().map_or(0, |p| p.count);

    // Running cross-model state.
    let mut guid_to_final: HashMap<String, (u32, f64)> = HashMap::new();
    let mut emitted_guids: HashSet<String> = HashSet::new();
    let mut minter = GuidMinter::new();
    let mut offset: u32 = 0;

    for (i, model) in models.iter().enumerate() {
        let is_first = i == 0;
        let index = ModelIndex::build(model.content);
        let included = plan::resolve_included(&index, &model.included);
        // Placing this model would push the merged EXPRESS-id space past u32::MAX,
        // so stop here instead: the file emitted so far is valid, and the unmerged
        // tail is reported for the caller to gate. `plan::next_offset` is the single
        // home for that bound — the drop pre-pass stops at the same model.
        let Some(next) = plan::next_offset(offset, &included) else {
            stats.unmerged_model_count = models.len() - i;
            stats.warnings.push(format!(
                "merged EXPRESS id space would exceed u32::MAX; stopped after {i} model(s), {} model(s) not merged.",
                models.len() - i
            ));
            break;
        };

        // Unit mode. Counted here, not where the verdicts are resolved, so an
        // id-space break above still reports only the models actually merged.
        let mode = &modes[i];
        let (compatible, effective_scale) = (mode.compatible, mode.scale);
        if mode.federated {
            stats.federated_model_count += 1;
        }
        if mode.rescale_required {
            stats.unit_rescale_required = true;
        }

        // Empty spatial containers this model must not write (#3643). The plan
        // covers only the models that will actually be emitted, so a model past
        // the id-space cut has no entry — `get` rather than index.
        let dropped_containers =
            drop_plan.as_ref().and_then(|p| p.per_model.get(i)).filter(|d| !d.is_empty());

        let salt = model_salt(model, i);
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
            salt: salt.clone(),
        });

        // Emit.
        let source_schema = detect_schema(model.content);
        let converting = crate::schema_convert::needs_conversion(&source_schema, &schema);
        for &id in &index.order {
            if !included.contains(&id) || plan.skip.contains(&id) {
                continue;
            }
            let Some(bytes) = index.line_bytes(id) else { continue };
            // A dropped container is never written, and any line naming one is
            // rewritten without it (or dropped with it), so the merge emits no
            // reference to a line it did not write — no clean-up pass needed.
            let mut pruned: Option<String> = None;
            if let Some(dropped) = dropped_containers {
                if dropped.contains(&id) {
                    continue;
                }
                match line_edit::decide_line(&String::from_utf8_lossy(bytes), dropped) {
                    LineDecision::Skip => continue,
                    LineDecision::Rewrite(text) => pruned = Some(text),
                    LineDecision::Keep => {}
                }
            }
            let bytes: &[u8] = pruned.as_deref().map_or(bytes, str::as_bytes);
            let remapped = if offset == 0 && plan.shared_remap.is_empty() {
                String::from_utf8_lossy(bytes).into_owned()
            } else {
                rewrite_refs(bytes, offset, &|n| plan.shared_remap.get(&n).copied())
            };
            let after_guid = match plan.guid_rewrite.get(&id) {
                Some(g) => replace_global_id(&remapped, g),
                None => remapped,
            };
            let mut final_text = if converting {
                // Pass the GLOBAL id (offset applied): a schema downgrade with no
                // target type falls back to IFCPROXY with a `placeholder_guid(id)`
                // GlobalId, so two models sharing a source-local id must not seed the
                // same placeholder (Greptile P1). rewrite_refs already offset the
                // line's own `#id`, so this keeps the proxy guid consistent with it.
                crate::schema_convert::convert_step_line(
                    &after_guid,
                    &source_schema,
                    &schema,
                    id.saturating_add(offset),
                )
            } else {
                after_guid
            };

            if let Some(local_guid) = plan.local_guids.get(&id) {
                let mut emitted = read_leading_guid(&final_text)
                    .or_else(|| plan.guid_rewrite.get(&id).cloned())
                    .unwrap_or_else(|| local_guid.clone());
                // A schema-conversion placeholder (an alignment/linear entity
                // downgraded to IFCPROXY) is minted at emit time, AFTER GlobalId
                // reconciliation, so it can still collide with a rooted GlobalId an
                // earlier model already emitted. Reconciliation never saw it —
                // re-stamp it here so the merged file keeps no duplicate GlobalIds
                // (Greptile P1 #2952).
                if emitted_guids.contains(&emitted) {
                    let minted = minter.mint(&emitted, &salt, &emitted_guids, &HashSet::new());
                    final_text = replace_global_id(&final_text, &minted);
                    emitted = minted;
                }
                let final_id = id.saturating_add(offset);
                guid_to_final.insert(emitted.clone(), (final_id, effective_scale));
                emitted_guids.insert(emitted);
                // Also key reconciliation on the SOURCE GlobalId: schema conversion
                // may have replaced this rooted entity's GlobalId with a proxy
                // placeholder, so `emitted` is no longer the id a later compatible
                // model would carry. Without this, that later model could not unify
                // and would emit a second proxy for the same entity (CR #2952).
                // `or_insert` never overwrites — a re-stamped duplicate keeps
                // pointing at its first instance.
                guid_to_final.entry(local_guid.clone()).or_insert((final_id, effective_scale));
            }

            out.push_str(&final_text);
            out.push('\n');
            stats.written += 1;
        }

        offset = next;
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

#[cfg(test)]
mod tests;
