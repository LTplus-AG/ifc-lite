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
mod effective;
mod extract;
mod generate;
mod jsval;
mod ledger;
mod lines;
mod nominal;
mod overlay;
mod pass;
mod property_value;
mod readers;
mod replay;
mod source;
mod units;
pub mod wire;
mod write;

pub use wire::{GeorefMutations, LogMutation, LogNewEntity, MutationKind, MutationLog};
pub use write::{export_step_with_log, export_step_with_log_to_writer, LogExportStats, StepCounters};
