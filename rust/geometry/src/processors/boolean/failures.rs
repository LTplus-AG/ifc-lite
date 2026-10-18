// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The boolean processor's own failure log: record, drain, hand off, plus the
//! `GeometryProcessor` trait impl those methods serve (module-size ratchet
//! moved the whole impl block here when #4083 added two more methods to it).
//!
//! Split out of `boolean/mod.rs` (module-size ratchet) when the one-record-
//! per-step rule needed a home (#3821).

use super::{BooleanClippingProcessor, OperandPath};
use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

impl GeometryProcessor for BooleanClippingProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        let mut visited = OperandPath::default();
        self.process_with_depth(entity, decoder, schema, 0, quality, &mut visited)
            .map(|(mesh, _)| mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult]
    }

    /// Hand the log to the router (#3821); rationale on the trait method.
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.take_failures()
    }

    /// #4083: reuses `failure_mark` below.
    fn bool_failure_count(&self) -> usize {
        self.failure_mark()
    }

    /// #4083: reuses `rewind_to` below to retract a redundant record.
    fn truncate_bool_failures_to(&self, since: usize) {
        self.rewind_to(since);
    }
}

impl BooleanClippingProcessor {
    /// Drain the boolean-failure log accumulated since this processor was
    /// created (or the last `take_failures` call).
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        self.effects.take_failures()
    }

    pub(crate) fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.effects.record_failure(op, reason);
    }
    pub(crate) fn absorb_failures(&self, failures: Vec<BoolFailure>) {
        self.effects.absorb_failures(failures);
    }
    pub(crate) fn failure_mark(&self) -> usize { self.effects.failure_mark() }
    pub(crate) fn rewind_to(&self, mark: usize) { self.effects.rewind_to(mark); }
    pub(crate) fn record_empty_operand(&self, op: BoolOp, already_recorded: bool) {
        self.effects.record_empty_operand(op, already_recorded);
    }
}
