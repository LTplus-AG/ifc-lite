// SPDX-License-Identifier: MPL-2.0
//! Terminal-aware final diagnostic drain without replaying processor callbacks.
use super::GeometryRouter;
use super::diagnostics::UNATTRIBUTED_PRODUCT_ID;
use crate::BoolFailure;
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// Drain all current and stopped-product reports for explicit diagnostics.
    /// Canonical product publication and retry drains exclude stopped reports.
    pub fn take_csg_failures(&self) -> FxHashMap<u32, Vec<BoolFailure>> {
        let current = self.take_current_csg_failures();
        let mut stopped = std::mem::take(&mut *self.stopped_csg_failures.borrow_mut());
        append_csg_failures(&mut stopped, current);
        stopped
    }

    /// Isolate already-recorded reports when production stops before finalization.
    /// Does not invoke processor hooks or adopt ambient thread-local reports.
    /// Explicit diagnostic retrieval still returns these reports exactly once.
    pub fn quarantine_recorded_csg_failures(&self) {
        let failures = std::mem::take(&mut *self.csg_failures.borrow_mut());
        append_csg_failures(&mut self.stopped_csg_failures.borrow_mut(), failures);
    }

    /// Drain current-work failures, excluding quarantined stopped reports.
    /// This is the accumulation router has observed since it was
    /// created (or the last `take_csg_failures` call). The single drain point:
    /// the native pipeline and the wasm batch path both call this and nothing
    /// else.
    ///
    /// Two kinds of record come out, distinguished by their key:
    ///
    ///  * Keyed by IFC product express id — the void-subtraction path
    ///    (multi-layer wall sub-meshes, single-mesh `process_element_with_voids_parts`),
    ///    which knows the host element whose opening / clip tripped a fallback.
    ///  * Keyed by [`UNATTRIBUTED_PRODUCT_ID`] — the registered processors' own
    ///    logs (swept by [`Self::drain_processor_failures`], #3821, including
    ///    what the transient boolean under an `IfcCsgSolid` hands back to
    ///    `CsgSolidProcessor`) and the producer-less hatch. Standalone
    ///    `IfcBooleanResult` chains DO flow here now; what they still lack is
    ///    the owning product id. See `drain_processor_failures` for the cost.
    fn take_current_csg_failures(&self) -> FxHashMap<u32, Vec<BoolFailure>> {
        // Sweep the processors' own logs, then fold in any failures from a
        // context with no router handle at all (`PENDING_MAPPED_BOOL_FAILURES`,
        // which has no producer today). Neither carries a product attribution,
        // so both land in the unattributed bucket, not a fake host id.
        self.drain_processor_failures();
        let pending = crate::diagnostics::take_pending_mapped_bool_failures();
        if !pending.is_empty() {
            self.csg_failures
                .borrow_mut()
                .entry(UNATTRIBUTED_PRODUCT_ID)
                .or_default()
                .extend(pending);
        }
        std::mem::take(&mut *self.csg_failures.borrow_mut())
    }


    /// [`Self::take_csg_failures`] for a terminal-aware final drain. If a
    /// processor's drain hook stops execution, the drained records are retained
    /// separately for an explicit diagnostic caller. Later product publication
    /// and retry drains cannot adopt or discard those stopped reports.
    pub fn take_csg_failures_checked(
        &self,
    ) -> Result<FxHashMap<u32, Vec<BoolFailure>>, crate::resource::ProgramStop> {
        if let Err(stop) = crate::resource::check_current() {
            self.quarantine_recorded_csg_failures();
            return Err(stop);
        }
        let failures = self.take_current_csg_failures();
        match crate::resource::check_current() {
            Ok(()) => Ok(failures),
            Err(stop) => {
                append_csg_failures(&mut self.stopped_csg_failures.borrow_mut(), failures);
                Err(stop)
            }
        }
    }
}

#[cold]
#[inline(never)]
fn append_csg_failures(
    retained: &mut FxHashMap<u32, Vec<BoolFailure>>,
    failures: FxHashMap<u32, Vec<BoolFailure>>,
) {
    for (id, records) in failures {
        retained.entry(id).or_default().extend(records);
    }
}
