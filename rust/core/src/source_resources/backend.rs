// SPDX-License-Identifier: MPL-2.0
//! Resource-only adapter seam; a backend is never source authentication.
use super::{coverage, failure};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

pub(super) const MAX_GATES: usize = 4;
pub(super) const MAX_BINDINGS: usize = 16;
#[derive(Clone, Copy, Default)]
pub(super) struct Cost { pub live: u64, pub work: u64, pub copies: u64 }
#[derive(Clone, Copy)]
pub(super) enum StorageEvent {
    Allocated(u64),
    Deallocated(u64),
    Replaced { old: u64, new: u64 },
}
/// All methods must be allocation-free and nonpanicking, including after stop.
/// The parent supplies the eventual geometry adapter; core imports no geometry.
pub(super) trait Backend: Send + Sync {
    fn check(&self) -> Result<(), ProgramStop>;
    fn admit(&self, cost: Cost) -> Result<(), ProgramStop>;
    fn refund(&self, bytes: u64);
    fn stop(&self, stop: ProgramStop) -> ProgramStop;
    fn observe(&self, event: StorageEvent);
}
pub(super) struct Resources {
    pub backend: Arc<dyn Backend>,
    gates: AtomicUsize,
}
impl Resources {
    /// This record/backend are declared baseline control storage, not source
    /// Layout storage. Creation must be covered by the parent's metadata envelope.
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
