// SPDX-License-Identifier: MPL-2.0
//! Ownership of pending thread-local reports during a synchronous work slice.
//! Router logs, source-claim state and process-global measurements stay outside.
use super::{BoolFailure, PENDING_MAPPED_BOOL_FAILURES, take_pending_mapped_bool_failures};
use crate::construction::ConstructionReports;
use std::marker::PhantomData;

#[derive(Debug, Default)]
struct Pending {
    source: ConstructionReports,
    mapped: Vec<BoolFailure>,
}
impl Pending {
    fn take_current() -> Self {
        Self { source: ConstructionReports {
            curve_capped: crate::processors::take_curve_capped(),
            face_refused: crate::processors::take_face_refused(),
            decoder_refused_record_ids: Vec::new(),
        }, mapped: take_pending_mapped_bool_failures() }
    }
    fn publish(self) {
        crate::processors::diagnostic_capture::restore(&self.source);
        PENDING_MAPPED_BOOL_FAILURES.with(|pending| pending.borrow_mut().extend(self.mapped));
    }
}

/// Pending reports retained by one work owner between synchronous slices.
/// The value may move between workers; an installed scope cannot. Starting a
/// state neither adopts ambient reports nor drains router processor logs.
#[derive(Debug, Default)]
pub struct PendingDiagnosticState {
    pending: Pending,
}
impl PendingDiagnosticState {
    pub fn new() -> Self { Self::default() }

    /// Deliberately adopt only the legacy pending-mapped CSG channel at owner
    /// admission. Curve/face reports already pending for the caller stay ambient.
    /// Call once at the owning executor's first live admission, not planning.
    pub fn adopt_current_mapped(&mut self) {
        let mut older = take_pending_mapped_bool_failures();
        older.append(&mut self.pending.mapped);
        self.pending.mapped = older;
    }

    /// Install owner reports, retain new leftovers on return/error/unwind, and
    /// restore the caller's pending reports exactly. No scope crosses a yield.
    /// Work that drains reports through its ordinary router still does so here;
    /// this primitive does not introduce a per-poll processor drain.
    pub fn with_scope<T>(&mut self, work: impl FnOnce() -> T) -> T {
        let caller = Pending::take_current();
        std::mem::take(&mut self.pending).publish();
        let _scope = Scope { owner: self, caller: Some(caller), _thread_bound: PhantomData };
        work()
    }

    /// Publish this owner's remaining reports once at its validated terminal
    /// boundary. The caller chooses success/error/cancellation delivery policy;
    /// dropping a state never silently publishes it into another owner's TLS.
    /// Existing caller face ordering and mapped-record prefixes are retained.
    pub fn publish_pending(&mut self) {
        std::mem::take(&mut self.pending).publish();
    }
}

struct Scope<'a> {
    owner: &'a mut PendingDiagnosticState,
    caller: Option<Pending>,
    _thread_bound: PhantomData<*const ()>,
}
impl Drop for Scope<'_> {
    fn drop(&mut self) {
        self.owner.pending = Pending::take_current();
        self.caller.take().expect("active pending diagnostic scope").publish();
    }
}

#[cfg(test)]
#[path = "pending_diagnostics_tests.rs"]
mod tests;
