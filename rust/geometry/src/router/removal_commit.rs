// SPDX-License-Identifier: MPL-2.0
//! Allocation and acceptance precede the single visible effect. This storage
//! primitive grants no source/removal authority; the shared controller does.
use super::GeometryRouter;
use crate::resource::{self, Cost, ProgramStop, OwnedResourceContext};
#[derive(Debug)]
pub enum RemovalCommitError<E> { AlreadyConsumed, Stopped(ProgramStop), Rejected(E) }
impl GeometryRouter {
    /// Publish only AFTER `accept` has completed all owner commits. Errors and
    /// unwind cannot expose an effect. No allocation or callback follows insert.
    /// The mutable borrow excludes reentrant mutation/observation of this set.
    pub fn commit_removed_host<T,E>(&self, product: u32, resources: &OwnedResourceContext, accept: impl FnOnce() -> Result<T,E>)
        -> Result<T,RemovalCommitError<E>> {
        let mut hosts = self.voids_consumed_hosts.borrow_mut();
        if hosts.contains(&product) { return Err(RemovalCommitError::AlreadyConsumed); }
        let permit = resources.charge(Cost { work: 1, live_bytes: (hosts.capacity() as u64 + 1).saturating_mul(32), ..Default::default() })
            .map_err(RemovalCommitError::Stopped)?;
        hosts.try_reserve(1).map_err(|_| RemovalCommitError::Stopped(resource::allocation_failure()))?;
        let result = accept().map_err(RemovalCommitError::Rejected)?;
        // The callback's final checks are the synchronous acceptance boundary.
        // A cancellation observed after this point belongs to a later operation.
        hosts.insert(product);
        permit.retain();
        Ok(result)
    }
}
#[cfg(test)]
#[path = "removal_commit_tests.rs"]
mod tests;
