// SPDX-License-Identifier: MPL-2.0
//! Historical unit-test fixtures; absent from the normal-library gate seam.
use super::Backend;
use crate::source_resources::{coverage, failure};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use crate::execution_owner::{AllocationClass, AllocationCost as Cost, SourceResourceContext, StorageEvent};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
pub(in crate::source_resources) const MAX_GATES: usize = 4;
pub(in crate::source_resources) struct Resources {
    pub backend: Arc<dyn Backend>,
    gates: AtomicUsize,
}
impl Resources {
    /// Historical test account baseline only. Actual geometry contexts preserve
    /// their existing Inner payload; they neither allocate nor publish this type.
    pub fn new(backend: Arc<dyn Backend>) -> Result<Arc<Self>, ProgramStop> {
        backend.check()?;
        Arc::try_new(Self { backend: Arc::clone(&backend), gates: AtomicUsize::new(0) })
            .map_err(|_| backend.stop(failure(Dimension::LiveBytes,
                std::mem::size_of::<Self>() as u64, 0, RefusalReason::Allocation)))
    }
    pub fn reserve_gate(&self) -> Result<(), ProgramStop> {
        self.backend.check()?;
        self.gates.fetch_update(Ordering::AcqRel, Ordering::Acquire,
            |old| (old < MAX_GATES).then_some(old + 1))
            .map(|_| ())
            .map_err(|_| self.backend.stop(failure(Dimension::Coverage,
                1, 0, RefusalReason::Limit)))
    }
    pub fn release_gate(&self) {
        if self.gates.fetch_update(Ordering::AcqRel, Ordering::Acquire,
            |old| old.checked_sub(1)).is_err() {
            self.backend.stop(coverage());
        }
    }
    pub fn retained_gates(&self) -> usize { self.gates.load(Ordering::Acquire) }
}

// Historical observer fixture only. Actual-account witnesses publish geometry's
// paired private Inner context and never construct Resources.
impl Backend for Resources {
    fn check(&self) -> Result<(), ProgramStop> { self.backend.check() }
    fn admit(&self, cost: Cost) -> Result<(), ProgramStop> { self.backend.admit(cost) }
    fn refund(&self, bytes: u64, class: AllocationClass) { self.backend.refund(bytes, class); }
    fn stop(&self, stop: ProgramStop) -> ProgramStop { self.backend.stop(stop) }
    fn observe(&self, event: StorageEvent, class: AllocationClass) { self.backend.observe(event, class); }
}
pub(in crate::source_resources) fn fixture_resources(context: &SourceResourceContext) -> Option<Arc<Resources>> {
    context.downcast::<Resources>()
}
