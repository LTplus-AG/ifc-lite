// SPDX-License-Identifier: MPL-2.0
//! Terminal-aware final diagnostic drain without replaying processor callbacks.
use super::GeometryRouter;
use super::diagnostics::UNATTRIBUTED_PRODUCT_ID;
use crate::BoolFailure;
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// Isolate recorded CSG reports for one synchronous product owner epoch.
    /// Nested products cannot drain their parent's records. Unconsumed records
    /// survive errors and unwind for explicit retrieval, without final hooks.
    pub fn with_product_csg_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        // Existing processor storage belongs to the active parent (or the
        // root's preexisting source evidence), never to an entering child.
        self.capture_recorded_processor_failures();
        let nested = self.csg_product_active.replace(true);
        let parent_drained = self.csg_product_drained.replace(false);
        // Opaque custom logs cannot be partitioned without running callbacks.
        // Nested work makes their ownership ambiguous until explicit retrieval.
        if nested { self.csg_opaque_unscoped.set(true); }
        let parent = nested.then(|| std::mem::take(&mut *self.csg_failures.borrow_mut()));
        let _scope = ProductReports { router: self, parent, nested, parent_drained };
        work()
    }

    /// Drain all current and stopped-product reports for explicit diagnostics.
    /// Canonical product publication and retry drains exclude stopped reports.
    pub fn take_csg_failures(&self) -> FxHashMap<u32, Vec<BoolFailure>> {
        let current = self.take_current_csg_failures();
        let mut stopped = std::mem::take(&mut *self.stopped_csg_failures.borrow_mut());
        append_csg_failures(&mut stopped, current);
        // Only an explicit drain outside product work establishes a clean
        // boundary for opaque logs. A nested diagnostic caller cannot do so.
        if !self.csg_product_active.get() { self.csg_opaque_unscoped.set(false); }
        stopped
    }

    /// Isolate already-recorded reports when production stops before finalization.
    /// Does not invoke processor hooks or adopt ambient thread-local reports.
    /// Explicit diagnostic retrieval still returns these reports exactly once.
    pub fn quarantine_recorded_csg_failures(&self) {
        self.csg_opaque_unscoped.set(true);
        self.park_recorded_csg_failures();
    }

    fn park_recorded_csg_failures(&self) {
        self.capture_recorded_processor_failures();
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
            Ok(()) => {
                self.csg_product_drained.set(true);
                Ok(failures)
            }
            Err(stop) => {
                self.csg_opaque_unscoped.set(true);
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

/// The guard runs after owner commit validation too, including WrongOwner.
struct ProductReports<'a> {
    router: &'a GeometryRouter,
    parent: Option<FxHashMap<u32, Vec<BoolFailure>>>,
    nested: bool,
    parent_drained: bool,
}
impl Drop for ProductReports<'_> {
    fn drop(&mut self) {
        if !self.router.csg_product_drained.get() {
            self.router.csg_opaque_unscoped.set(true);
        }
        self.router.park_recorded_csg_failures();
        if let Some(parent) = self.parent.take() {
            *self.router.csg_failures.borrow_mut() = parent;
        }
        self.router.csg_product_active.set(self.nested);
        self.router.csg_product_drained.set(self.parent_drained);
    }
}
