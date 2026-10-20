// SPDX-License-Identifier: MPL-2.0
//! The product-independent numerical and diagnostic state of one element.
//!
//! Exact-work budget, degenerate-triangle tally and pending reports are owned
//! values installed for one synchronous call, so a rayon work-steal that runs
//! another element to completion inside this one cannot read or clear them.
use super::degenerate;
use ifc_lite_geometry::kernel::budget;
use ifc_lite_geometry::PendingDiagnosticState;

pub(super) struct ElementScopes {
    budget: budget::ElementState,
    degenerate: degenerate::ElementState,
    pending: PendingDiagnosticState,
}

impl ElementScopes {
    pub(super) fn new() -> Self {
        Self {
            budget: budget::ElementState::new(),
            degenerate: degenerate::ElementState::new(),
            pending: PendingDiagnosticState::new(),
        }
    }

    /// Run `work` with this element's state installed. Every scope restores the
    /// caller's counters and reports on return and on unwind.
    pub(super) fn with_scope<R>(&mut self, work: impl FnOnce() -> R) -> R {
        let Self {
            budget,
            degenerate,
            pending,
        } = self;
        budget.with_scope(|| degenerate.with_scope(|| pending.with_scope(work)))
    }
}

impl Drop for ElementScopes {
    /// Reports the element's router did not drain reach the caller's thread, as
    /// they did before they were owned, including when the element unwinds.
    fn drop(&mut self) {
        self.pending.publish_pending();
    }
}
