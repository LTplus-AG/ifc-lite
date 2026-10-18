// SPDX-License-Identifier: MPL-2.0
//! Source-free numerical effect recorder. It owns only the ordered Boolean log;
//! kernel state and census remain in their existing caller scopes.
use crate::{BoolFailure, BoolFailureReason, BoolOp};
use std::cell::RefCell;

#[derive(Default)]
pub(crate) struct NumericalEffects {
    failures: RefCell<Vec<BoolFailure>>,
}
impl NumericalEffects {
    pub(crate) fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }
    pub(crate) fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Move a drained log into this processor's log. Used after a transient
    /// helper — a `ClippingProcessor`, or the `CsgSolidProcessor` built for an
    /// `IfcCsgSolid` operand — is about to drop and would take its records
    /// with it. Takes the drained `Vec` rather than the producer, so one
    /// method covers every transient kind.
    pub(crate) fn absorb_failures(&self, failures: Vec<BoolFailure>) {
        self.failures.borrow_mut().extend(failures);
    }

    /// A mark in the failure log, for [`Self::rewind_to`].
    pub(crate) fn failure_mark(&self) -> usize {
        self.failures.borrow().len()
    }

    /// Discard everything recorded since `mark`.
    ///
    /// Only for a SPECULATIVE attempt whose work the caller is about to redo.
    /// `finish_batch` is a batched attempt at a chain the
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
    pub(crate) fn rewind_to(&self, mark: usize) {
        self.failures.borrow_mut().truncate(mark);
    }

    /// [`Self::rewind_to`] plus the deferral itself, so a guard in
    /// `finish_batch` reads as one line and cannot rewind without
    /// deferring or defer without rewinding.
    pub(crate) fn defer_after<T>(&self, mark: usize) -> crate::Result<Option<T>> {
        self.rewind_to(mark);
        Ok(None)
    }

    /// Record the `EmptyOperand` consequence for an operand that meshed
    /// empty — UNLESS the operand program reports its loss
    /// already on record (an unsupported operand, or a nested one emptied by
    /// a drop inside it). One dropped step, one record: see the flag's
    /// rationale there.
    pub(crate) fn record_empty_operand(&self, op: BoolOp, already_recorded: bool) {
        if !already_recorded {
            self.record_failure(op, BoolFailureReason::EmptyOperand);
        }
    }
}
