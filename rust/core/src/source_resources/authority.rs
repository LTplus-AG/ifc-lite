// SPDX-License-Identifier: MPL-2.0
//! Child of execution_owner: safe snapshots, never a retained decoder reference.
use super::{ExecutionIdentity, ExecutionLeaseError, ExecutionWork, State, WorkEpoch};
use crate::execution_owner::{SourceResourceContext, SourceStopHandle};
use crate::{EntityDecoder, SourceBundle};
use crate::resource_stop::ProgramStop;
use std::sync::{Arc, atomic::Ordering};

pub(crate) const MAX_EPOCHS: usize = 16;

#[derive(Clone)]
pub(crate) struct Authority {
    state: Arc<State>,
    epoch: Arc<WorkEpoch>,
    identity: ExecutionIdentity,
    revision: u64,
    pub(crate) source: Arc<SourceBundle>,
    pub(crate) resources: SourceResourceContext,
}
impl Authority {
    pub(crate) fn capture(decoder: &EntityDecoder<'_>, work: &ExecutionWork<'_>)
        -> Result<Self, ExecutionLeaseError> {
        work.lease.validate(decoder.execution_identity())?;
        let source = decoder.source_bundle.as_ref()
            .filter(|source| source.owns_decoder(decoder))
            .ok_or(ExecutionLeaseError::WrongOwner)?;
        let published = work.lease.state.active_source.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let epoch = published.epoch.upgrade().ok_or(ExecutionLeaseError::ExpiredWork)?;
        if !work.epoch.get().is_some_and(|own| Arc::ptr_eq(own, &epoch)) {
            return Err(ExecutionLeaseError::WrongOwner);
        }
        let resources = published.resources.ok_or(ExecutionLeaseError::ExpiredWork)?;
        let result = Self { state: Arc::clone(&work.lease.state), epoch,
            identity: decoder.execution_identity(), revision: decoder.cache_revision,
            source: Arc::clone(source), resources };
        result.validate()?;
        Ok(result)
    }
    pub(crate) fn validate(&self) -> Result<(), ExecutionLeaseError> {
        if !self.state.alive.load(Ordering::Acquire) { return Err(ExecutionLeaseError::OwnerDropped); }
        if !self.state.reserved.load(Ordering::Acquire) { return Err(ExecutionLeaseError::ExpiredWork); }
        if self.state.generation.load(Ordering::Acquire) != self.identity.generation {
            return Err(ExecutionLeaseError::ConfigurationChanged);
        }
        // Revision witness is captured from the actual decoder. Every existing
        // revision-changing API also changes the live generation above. It is
        // not a separately polled decoder field and grants no source authority.
        if self.revision != 0 { return Err(ExecutionLeaseError::ConfigurationChanged); }
        let mut cursor = Some(self.epoch.as_ref());
        let mut source_borrow = false;
        let mut count = 0;
        while let Some(epoch) = cursor {
            count += 1;
            if count > MAX_EPOCHS || !epoch.active.load(Ordering::Acquire)
                || (!source_borrow && epoch.thread != std::thread::current().id()) {
                return Err(ExecutionLeaseError::ExpiredWork);
            }
            source_borrow |= epoch.parent_source;
            cursor = epoch.parent.as_deref();
        }
        self.live_resources()?;
        Ok(())
    }
    pub(crate) fn live_resources(&self) -> Result<SourceResourceContext, ExecutionLeaseError> {
        let published = self.state.active_source.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        if !published.epoch.upgrade().is_some_and(|epoch| Arc::ptr_eq(&epoch, &self.epoch)) {
            return Err(ExecutionLeaseError::ExpiredWork);
        }
        published.resources.ok_or(ExecutionLeaseError::ExpiredWork)
    }
    pub(crate) fn thread(&self) -> std::thread::ThreadId { self.epoch.thread }
    pub(crate) fn stop_handle(&self) -> SourceStopHandle {
        SourceStopHandle::new(Arc::clone(&self.epoch))
    }
    pub(crate) fn original_stop(&self) -> Result<(), ProgramStop> {
        SourceStopHandle::new(Arc::clone(&self.epoch)).check()
    }
    pub(crate) fn stop(&self, stop: ProgramStop) -> ProgramStop {
        SourceStopHandle::new(Arc::clone(&self.epoch)).stop(stop)
    }
}

pub(crate) fn metadata_sizes() -> (usize, usize) {
    (std::mem::size_of::<State>(), std::mem::size_of::<WorkEpoch>())
}

/// Terminal inspection does not authorize work or acknowledge a stale generation.
/// Preserve the actual selected owner's earlier stop even if configuration changed.
pub(crate) fn work_original_stop(decoder: &EntityDecoder<'_>, work: &ExecutionWork<'_>)
    -> Result<Option<ProgramStop>, ExecutionLeaseError> {
    if work.lease.identity.instance != decoder.execution_identity().instance {
        return Err(ExecutionLeaseError::WrongOwner);
    }
    Ok(work.epoch.get().and_then(|epoch| SourceStopHandle::new(Arc::clone(epoch)).check().err()))
}
