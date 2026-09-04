// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The boolean processor's own failure log: record, drain, hand off.
//!
//! Split out of `boolean/mod.rs` (module-size ratchet) when the one-record-
//! per-step rule needed a home (#3821).

use super::BooleanClippingProcessor;
use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::ClippingProcessor;

impl BooleanClippingProcessor {
    /// Drain the boolean-failure log accumulated since this processor was
    /// created (or the last `take_failures` call).
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }

    pub(super) fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Move every failure from `clipper` into this processor's log. Used
    /// after a transient `ClippingProcessor` instance is about to drop.
    pub(super) fn drain_clipper_failures(&self, clipper: &ClippingProcessor) {
        let mut log = self.failures.borrow_mut();
        log.extend(clipper.take_failures());
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
