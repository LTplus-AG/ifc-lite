// SPDX-License-Identifier: MPL-2.0
//! Merged export with per-model mutation logs (`MergedExporter.exportAsync`'s
//! `bakeMutatedModels`): each model with pending edits is first written
//! through the mutation-log writer in its own source schema, and the merge
//! then treats the result as that model's source. Unit-aware federation,
//! GlobalId reconciliation and id offsetting are therefore unchanged.
//!
//! The TypeScript bake passes no georeferencing edits to `StepExporter`, so a
//! log's `georefMutations` are not applied to a merged export either; the
//! merge says so in its warnings instead of dropping them silently.

use std::io;

use crate::merged::{export_merged_models, MergedModel, MergedOptions, MergedStats};
use crate::step_api::StepOptions;

use super::wire::MutationLog;
use super::write::export_step_with_log;

/// [`export_merged_models`] with a mutation log per model (`logs[i]` for
/// `models[i]`; `None`, a missing entry or an empty log leaves the model as it
/// is). Errs, writing nothing, when a model's log cannot be applied (see
/// [`export_step_with_log`]).
///
/// A baked model is held in memory for the merge, as the merge itself holds its
/// output; the models without edits are merged from their bytes directly.
pub fn export_merged_models_with_logs(
    models: &[MergedModel],
    logs: &[Option<&MutationLog>],
    opts: &MergedOptions,
) -> io::Result<(String, MergedStats)> {
    let mut baked: Vec<Option<Vec<u8>>> = Vec::with_capacity(models.len());
    let mut georef_dropped = 0usize;
    for (i, model) in models.iter().enumerate() {
        let log = logs.get(i).copied().flatten();
        let Some(log) = log.filter(|l| !l.mutations.is_empty() || !l.new_entities.is_empty()) else {
            georef_dropped += usize::from(log.is_some_and(|l| l.georef_mutations.is_some()));
            baked.push(None);
            continue;
        };
        georef_dropped += usize::from(log.georef_mutations.is_some());
        let mut edits = log.clone();
        edits.georef_mutations = None;
        let (text, _) = export_step_with_log(model.content, &StepOptions::default(), &edits)
            .map_err(|e| io::Error::new(e.kind(), format!("model {i}: {e}")))?;
        baked.push(Some(text.into_bytes()));
    }
    let inputs: Vec<MergedModel> = models
        .iter()
        .zip(&baked)
        .map(|(model, bytes)| MergedModel {
            content: bytes.as_deref().unwrap_or(model.content),
            id: model.id.clone(),
            included: model.included.clone(),
        })
        .collect();
    let (out, mut stats) = export_merged_models(&inputs, opts);
    if georef_dropped > 0 {
        stats.warnings.push(format!(
            "{georef_dropped} model log(s) carried georeferencing edits, which a merged export does not apply (as MergedExporter does not); export the model on its own to write them."
        ));
    }
    Ok((out, stats))
}
