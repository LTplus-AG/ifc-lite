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
        std::mem::take(&mut *self.failures.borrow_mut())
    }

    pub(super) fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Move a drained log into this processor's log. Used after a transient
    /// helper — a `ClippingProcessor`, or the `CsgSolidProcessor` built for an
    /// `IfcCsgSolid` operand — is about to drop and would take its records
    /// with it. Takes the drained `Vec` rather than the producer, so one
    /// method covers every transient kind.
    pub(super) fn absorb_failures(&self, failures: Vec<BoolFailure>) {
        self.failures.borrow_mut().extend(failures);
    }

    /// A mark in the failure log, for [`Self::rewind_to`].
    pub(super) fn failure_mark(&self) -> usize {
        self.failures.borrow().len()
    }

    /// Discard everything recorded since `mark`.
    ///
    /// Only for a SPECULATIVE attempt whose work the caller is about to redo.
    /// `try_union_polygonal_chain` is a batched attempt at a chain the
    /// sequential walk also resolves; when it gives up, `process_with_depth`
    /// re-meshes the same base operand and the same cutters and records the
    /// same losses again. Its trial subtracts already dropped their own probe
    /// failures for this reason, but the base operand did not, so one authored
    /// unsupported operand under a deferring chain was counted TWICE — the
    /// total inflated and the reason breakdown skewed, which is what the
    /// viewer's "top failure reason" reads.
    ///
    /// NOT a way to suppress a failure that really happened: the record has to
    /// stay reachable from somewhere, and here that somewhere is the second
    /// walk. A failure the sequential path does NOT re-encounter (the
    /// `CutterUnionUnavailable` the union attempt alone can see) must be
    /// recorded AFTER the rewind, not before it.
    pub(super) fn rewind_to(&self, mark: usize) {
        self.failures.borrow_mut().truncate(mark);
    }

    /// [`Self::rewind_to`] plus the deferral itself, so a guard in
    /// `try_union_polygonal_chain` reads as one line and cannot rewind without
    /// deferring or defer without rewinding.
    pub(super) fn defer_after(&self, mark: usize) -> crate::Result<Option<crate::Mesh>> {
        self.rewind_to(mark);
        Ok(None)
    }

    /// Record the `EmptyOperand` consequence for a second operand that meshed
    /// empty — UNLESS [`Self::process_operand_checked`] already recorded
    /// `UnsupportedOperand` for that same operand. One dropped step, one
    /// record: see the flag's rationale there.
    pub(super) fn record_empty_second_operand(&self, op: BoolOp, already_recorded: bool) {
        if !already_recorded {
            self.record_failure(op, BoolFailureReason::EmptyOperand);
        }
    }
}
