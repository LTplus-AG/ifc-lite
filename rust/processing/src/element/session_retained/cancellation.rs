// SPDX-License-Identifier: MPL-2.0
//! Refuse a product without discarding a settled numerical domain.
use super::*;

impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn refuse(&mut self, reason: &RetainedExecutionError) {
        // Preparation can discover a faulty input receipt after capturing the
        // domain, before installing a pending packet. This is fault recovery,
        // not an in-flight controller cancellation and must remain charged.
        if self.pending.is_none() && !reason.controller_cancelled() {
            if let Some(owner) = &self.runtime_domain {
                owner.retire();
                self.cancel();
                return;
            }
        }
        if reason.terminal() { self.cancel(); }
    }

    pub(super) fn cancel(&mut self) {
        self.failed = true;
        // A source refusal after acceptance has no outstanding kernel work.
        // Its ledger drops normally, releasing receipts on the healthy peer.
        // Only an unsettled packet needs the conservative retire-on-cancel path.
        if let Some(pending) = &self.pending {
            if pending.cancellation.stage.load(Ordering::Acquire) != SETTLED_FAULT {
                pending.cancellation.cancel();
            }
        }
        if let Some(program) = &mut self.program {
            program.cancel();
        }
        self.plan = None;
    }
}
