// SPDX-License-Identifier: MPL-2.0
//! STEP export with a `MutablePropertyView` mutation log applied (#5941).
//!
//! The plain writer ([`crate::export_step`]) takes pre-serialized
//! per-attribute and append-only property edits; it cannot update or delete a
//! property inside an existing set, touch a quantity, or remove a set. The
//! TypeScript `StepExporter` can, but it needs the whole file as one buffer in
//! the JS heap, which fails past V8's ArrayBuffer ceiling. This module takes
//! the log `exportMutations()` produces, replays it the way `importMutations`
//! does, and writes the file the TypeScript exporter would write, streaming
//! the source records it does not change.
//!
//! Parity with that exporter is the contract, and it is pinned by the shared
//! fixture `tests/fixtures/step_log_parity_vectors.json`, which the Rust test
//! `tests/step_log_parity.rs` and the TypeScript test
//! `packages/export/src/step-log.parity.test.ts` both run.
//!
//! Module map, one TypeScript phase each:
//! - [`wire`]: the log's wire shape (the only definition of it);
//! - `source`: the record index, and random access to the records the log touches;
//! - `base`: the sets an entity has before the session (the viewer's extractors);
//! - `overlay`: the replay (`applyMutationsBatch` + the view's setters);
//! - `effective`: the merged sets (`getForEntity` / `getQuantitiesForEntity`);
//! - `collect` / `generate`: the property-set phases of `StepExporter.export`;
//! - `attrs` / `nominal` / `lines` / `readers` / `units`: the serializers and
//!   text readers those phases call;
//! - `ledger`: the header's modification count;
//! - `write`: the driver.

mod attrs;
mod base;
mod collect;
mod cow;
mod created;
mod effective;
mod entities;
pub(crate) use entities::is_entity_name;
pub(crate) use nominal::{canonical_literal, check_literal_measure, check_real_measure, MeasureNumber};
pub(crate) use retype::predefined_type_members;
mod extract;
mod generate;
mod georef;
mod jsval;
pub(crate) use jsval::format_step_real;
mod ledger;
mod lines;
pub(crate) use lines::{read_slots, replace_argument};
mod merged;
mod nominal;
mod overlay;
mod pass;
mod property_value;
mod readers;
mod record;
mod refilter;
mod refs;
mod retype;
mod replay;
mod source;
mod units;
mod values;
pub mod wire;
mod write;

pub use wire::{GeorefMutations, LogMutation, LogNewEntity, MutationKind, MutationLog};
pub use merged::export_merged_models_with_logs;
pub use write::{export_step_with_log, export_step_with_log_to_writer, LogExportStats, StepCounters};

#[cfg(test)]
#[path = "tables_tests.rs"]
mod tables_tests;

/// `line`, record `id` of source `schema`, with every id in `omitted` removed from the references it holds; the
/// warning that says so when nothing is left to write (#11457). The plain writer's use of the log writer's filter.
pub(crate) fn scrub_omitted(line: String, id: u32, schema: &str, omitted: &std::collections::HashSet<u32>) -> Result<String, String> {
    // Most records name no omitted id: only those go through the filter, which also withholds what it cannot read.
    if !crate::step_text::ref_spans(line.as_bytes()).filter_map(|span| span.id).any(|r| omitted.contains(&r)) { return Ok(line) }
    let Some(head) = crate::step_record_frame::record_head(&line) else { return Ok(line) };
    let upper = head.type_name(&line).to_ascii_uppercase();
    match refilter::filter_source_line(&line, id, &upper, schema, &|r| omitted.contains(&r), true) {
        refilter::Filtered::Keep => Ok(line),
        refilter::Filtered::Rewrite(text) => Ok(text),
        refilter::Filtered::Withhold(warning) => Err(warning),
    }
}
