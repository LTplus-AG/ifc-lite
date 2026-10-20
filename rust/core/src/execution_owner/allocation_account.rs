// SPDX-License-Identifier: MPL-2.0
//! Dependency-visible resource interfaces. None authenticates source work.
use super::SourceResourceContext;
use crate::resource_stop::ProgramStop;

/// Classification within one allowance, never a second resource limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AllocationClass {
    #[default]
    Container,
    Metadata,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct AllocationCost {
    pub live: u64,
    pub work: u64,
    pub copies: u64,
    pub class: AllocationClass,
}
#[derive(Clone, Copy, Debug)]
pub enum StorageEvent {
    Allocated(u64),
    Deallocated(u64),
    Replaced { old: u64, new: u64 },
}
/// Implementations must allocate nothing, never panic, and consult no ambient
/// account. Refund is cleanup-only and must validate category and total before
/// subtracting. Admission commits cancellation/terminal checks under its ledger
/// lock. Existing cumulative costs are never refunded. This is not source authority.
pub trait AllocationAccount: Send + Sync {
    fn check(&self) -> Result<(), ProgramStop>;
    fn admit(&self, cost: AllocationCost) -> Result<(), ProgramStop>;
    fn refund(&self, bytes: u64, class: AllocationClass);
    fn stop(&self, stop: ProgramStop) -> ProgramStop;
    /// Optional actual-storage observation, after delegated Global operations.
    fn observe(&self, _event: StorageEvent, _class: AllocationClass) {}
}
/// Captured terminal channels only. Implementations release their own locks
/// before consulting another channel, and grant no decoder or execution rights.
pub trait AllocationObserver: Send + Sync {
    fn account_context(&self) -> Option<SourceResourceContext>;
    fn check(&self) -> Result<(), ProgramStop>;
    fn record(&self, stop: ProgramStop) -> ProgramStop;
}
